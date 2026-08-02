import type { CanonicalChatImage } from "./canonical";
import { normalizeCanonicalChatMimeType } from "./canonicalAttachments";
import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "./canonicalContentIdentity";
import { truncateCanonicalChatText } from "./canonicalUtilities";

const CANONICAL_MEDIA_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);
const CANONICAL_MEDIA_FINGERPRINT_PATTERN = /^\d{1,10}:[\da-z]{1,7}:[\da-z]{1,7}$/u;
export const MAX_CANONICAL_CHAT_IMAGES = 10;
export const MAX_CANONICAL_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS =
    Math.ceil((MAX_CANONICAL_CHAT_IMAGE_BYTES * 4) / 3) + 8;
export const MAX_CANONICAL_CHAT_TOTAL_IMAGE_DATA_CHARACTERS =
    MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS;
const EMBEDDED_CHAT_IMAGE_MIME_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);

function canonicalChatRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Merges canonical image blocks without repeating identical payloads.
 * @param previous Previously collected images.
 * @param next Incoming images.
 * @returns Images in first-seen order.
 */
export function mergeCanonicalChatImages(
    previous: CanonicalChatImage[] = [],
    next: CanonicalChatImage[] = []
): CanonicalChatImage[] {
    const seen = new Set<string>();
    const images: CanonicalChatImage[] = [];
    let embeddedCharacters = 0;
    for (const image of [...previous, ...next]) {
        const record = image as unknown as Record<string, unknown>;
        const nextEmbeddedCharacters = embeddedMediaCharacters(record);
        const canIncludeEmbeddedData =
            embeddedCharacters + nextEmbeddedCharacters <=
            MAX_CANONICAL_CHAT_TOTAL_IMAGE_DATA_CHARACTERS;
        const normalized = canonicalChatImageFromRecord(
            record,
            canIncludeEmbeddedData,
            true
        );
        if (!normalized) {
            continue;
        }
        const identity = JSON.stringify(
            summarizeCanonicalChatValueForFingerprint(normalized)
        );
        if (seen.has(identity)) {
            continue;
        }
        seen.add(identity);
        images.push(normalized);
        if (canIncludeEmbeddedData) {
            embeddedCharacters += nextEmbeddedCharacters;
        }
        if (images.length >= MAX_CANONICAL_CHAT_IMAGES) {
            break;
        }
    }
    return images;
}

function embeddedImageMimeType(value: string): string | undefined {
    const match = /^data:([^;,]+);base64,/iu.exec(value.trim());
    return match?.[1] ? normalizeCanonicalChatMimeType(match[1]) : undefined;
}

function boundedEmbeddedImageData(
    value: string | undefined,
    declaredMimeType: string | undefined
): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS) {
        return undefined;
    }
    const dataMimeType = embeddedImageMimeType(normalized);
    const mimeType = normalizeCanonicalChatMimeType(
        dataMimeType || declaredMimeType || "image/png"
    );
    return EMBEDDED_CHAT_IMAGE_MIME_TYPES.has(mimeType) ? normalized : undefined;
}

function canonicalImageHasUrl(image: CanonicalChatImage): boolean {
    return Boolean(
        image.url ||
        image.openUrl ||
        image.source?.url ||
        (typeof image.image_url === "string" ? image.image_url : image.image_url?.url)
    );
}

function retainedMediaFingerprint(
    value: string | undefined,
    originalValue: string | undefined,
    storedFingerprint: string | undefined,
    trustStoredFingerprint: boolean
): string | undefined {
    if (!value) return undefined;
    return originalValue === value &&
        trustStoredFingerprint &&
        storedFingerprint &&
        CANONICAL_MEDIA_FINGERPRINT_PATTERN.test(storedFingerprint)
        ? storedFingerprint
        : canonicalChatContentFingerprint(value);
}

function normalizedCanonicalChatImage(
    image: CanonicalChatImage,
    trustStoredFingerprint: boolean
): CanonicalChatImage | undefined {
    const declaredMimeType = image.source?.media_type || image.mimeType;
    const data = boundedEmbeddedImageData(image.data, declaredMimeType);
    const sourceData = boundedEmbeddedImageData(image.source?.data, declaredMimeType);
    const dataFingerprint = retainedMediaFingerprint(
        data,
        image.data,
        image.dataFingerprint,
        trustStoredFingerprint
    );
    const sourceDataFingerprint = retainedMediaFingerprint(
        sourceData,
        image.source?.data,
        image.source?.dataFingerprint,
        trustStoredFingerprint
    );
    const normalized: CanonicalChatImage = {
        ...image,
        alt: image.alt ? truncateCanonicalChatText(image.alt, 4096) : image.alt,
        data,
        source: image.source
            ? {
                  ...image.source,
                  data: sourceData,
              }
            : undefined,
    };
    if (dataFingerprint) {
        normalized.dataFingerprint = dataFingerprint;
    } else {
        delete normalized.dataFingerprint;
    }
    if (normalized.source && sourceDataFingerprint) {
        normalized.source.dataFingerprint = sourceDataFingerprint;
    } else if (normalized.source) {
        delete normalized.source.dataFingerprint;
    }
    if (normalized.source && !Object.values(normalized.source).some(Boolean)) {
        normalized.source = undefined;
    }
    return data || sourceData || canonicalImageHasUrl(normalized)
        ? normalized
        : undefined;
}

/**
 * Bounds one provider image while retaining URL-backed images and supported payloads.
 * @param image Provider image block.
 * @returns Safe bounded image, or undefined when it has no usable source.
 */
export function normalizeCanonicalChatImage(
    image: CanonicalChatImage
): CanonicalChatImage | undefined {
    return normalizedCanonicalChatImage(image, true);
}

interface CanonicalizedChatMedia {
    content: unknown;
    images: CanonicalChatImage[];
}

function embeddedMediaCharacters(record: Record<string, unknown>): number {
    const source = canonicalChatRecord(record.source);
    const imageUrl =
        typeof record.image_url === "string"
            ? record.image_url
            : canonicalChatRecord(record.image_url)?.url;
    return (
        (typeof record.data === "string" ? record.data.length : 0) +
        (typeof imageUrl === "string" && imageUrl.startsWith("data:image/")
            ? imageUrl.length
            : 0) +
        (typeof source?.data === "string" ? source.data.length : 0)
    );
}

function canonicalChatImageFromRecord(
    record: Record<string, unknown>,
    includeEmbeddedData: boolean,
    trustStoredFingerprint: boolean
): CanonicalChatImage | undefined {
    const type = CANONICAL_MEDIA_BLOCK_TYPES.has(String(record.type))
        ? (record.type as CanonicalChatImage["type"])
        : undefined;
    if (!type) return undefined;

    const rawImageUrl = record.image_url;
    const imageUrlRecord = canonicalChatRecord(rawImageUrl);
    let imageUrlValue: string | undefined;
    if (typeof rawImageUrl === "string") {
        imageUrlValue = rawImageUrl;
    } else if (typeof imageUrlRecord?.url === "string") {
        imageUrlValue = imageUrlRecord.url;
    }
    const embeddedImageUrl = imageUrlValue?.startsWith("data:image/")
        ? imageUrlValue
        : undefined;
    let imageUrl: CanonicalChatImage["image_url"];
    if (typeof rawImageUrl === "string" && !embeddedImageUrl) {
        imageUrl = rawImageUrl;
    } else if (typeof imageUrlRecord?.url === "string" && !embeddedImageUrl) {
        imageUrl = { url: imageUrlRecord.url };
    }
    const rawSource = canonicalChatRecord(record.source);
    const source = rawSource
        ? {
              data:
                  includeEmbeddedData && typeof rawSource.data === "string"
                      ? rawSource.data
                      : undefined,
              dataFingerprint:
                  typeof rawSource.dataFingerprint === "string"
                      ? rawSource.dataFingerprint
                      : undefined,
              media_type:
                  typeof rawSource.media_type === "string"
                      ? rawSource.media_type
                      : undefined,
              type: typeof rawSource.type === "string" ? rawSource.type : undefined,
              url: typeof rawSource.url === "string" ? rawSource.url : undefined,
          }
        : undefined;

    let data: string | undefined;
    if (includeEmbeddedData) {
        data = typeof record.data === "string" ? record.data : embeddedImageUrl;
    }

    return normalizedCanonicalChatImage(
        {
            alt: typeof record.alt === "string" ? record.alt : undefined,
            data,
            dataFingerprint:
                typeof record.dataFingerprint === "string"
                    ? record.dataFingerprint
                    : undefined,
            image_url: imageUrl,
            mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
            openUrl: typeof record.openUrl === "string" ? record.openUrl : undefined,
            source:
                source && Object.values(source).some((value) => value !== undefined)
                    ? source
                    : undefined,
            type,
            url: typeof record.url === "string" ? record.url : undefined,
        },
        trustStoredFingerprint
    );
}

/**
 * Extracts bounded display images while replacing embedded media bytes in the
 * canonical content copy with identities computed once during normalization.
 * @param content Provider content.
 * @returns Canonical content and image blocks.
 */
export function canonicalizeCanonicalChatMedia(content: unknown): CanonicalizedChatMedia {
    if (!Array.isArray(content)) {
        return { content, images: [] };
    }
    const images: CanonicalChatImage[] = [];
    const canonicalContent: unknown[] = [];
    let embeddedCharacters = 0;
    for (const item of content) {
        const record = canonicalChatRecord(item);
        if (!record || !CANONICAL_MEDIA_BLOCK_TYPES.has(String(record.type))) {
            canonicalContent.push(item);
            continue;
        }
        const nextEmbeddedCharacters = embeddedMediaCharacters(record);
        const canIncludeEmbeddedData =
            images.length < MAX_CANONICAL_CHAT_IMAGES &&
            embeddedCharacters + nextEmbeddedCharacters <=
                MAX_CANONICAL_CHAT_TOTAL_IMAGE_DATA_CHARACTERS;
        const image = canonicalChatImageFromRecord(record, canIncludeEmbeddedData, false);
        if (!image) {
            canonicalContent.push({ type: record.type });
            continue;
        }
        if (images.length < MAX_CANONICAL_CHAT_IMAGES) {
            images.push(image);
            if (canIncludeEmbeddedData) {
                embeddedCharacters += nextEmbeddedCharacters;
            }
        }
        canonicalContent.push(summarizeCanonicalChatValueForFingerprint(image));
    }
    return { content: canonicalContent, images };
}

/**
 * Extracts image blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical image blocks.
 */
export function extractCanonicalChatImages(content: unknown): CanonicalChatImage[] {
    return canonicalizeCanonicalChatMedia(content).images;
}
