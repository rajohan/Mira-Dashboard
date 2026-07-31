import type {
    CanonicalChatAttachment,
    CanonicalChatImage,
    CanonicalChatThinking,
    CanonicalChatToolCall,
} from "./chatCanonical";
import {
    boundCanonicalChatToolValue,
    MAX_CANONICAL_CHAT_TEXT_CHARACTERS,
    truncateCanonicalChatText,
} from "./chatCanonicalUtilities";

const CHAT_IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DASHBOARD_URL_FALLBACK_ORIGIN = "https://dashboard.invalid";

type DashboardMediaKind = "local" | "managed";

interface ParsedChatUrl {
    isRootRelative: boolean;
    isSameDashboardOrigin: boolean;
    url: URL;
}

interface DashboardMediaReference {
    kind: DashboardMediaKind;
    url: string;
}

/**
 * Returns a lowercase MIME type without optional parameters.
 * @param mimeType MIME type to normalize.
 * @returns Normalized MIME type.
 */
export function normalizeCanonicalChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function unsigned32(value: number): number {
    return value < 0 ? value + 4_294_967_296 : value;
}

/**
 * Builds a compact deterministic fingerprint for canonical chat content.
 * @param content Content to fingerprint.
 * @returns Non-cryptographic content identity.
 */
export function canonicalChatContentFingerprint(content: string): string {
    let firstHash = 2_166_136_261;
    let secondHash = 2_654_435_761;
    for (let index = 0; index < content.length; index += 1) {
        const code = content.codePointAt(index) ?? 0;
        firstHash = Math.imul(firstHash ^ code, 16_777_619);
        secondHash = Math.imul(secondHash ^ code, 2_246_822_519);
    }
    return `${content.length}:${unsigned32(firstHash).toString(36)}:${unsigned32(
        secondHash
    ).toString(36)}`;
}

const CANONICAL_MEDIA_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);
const CANONICAL_MEDIA_DATA_FIELDS = new Set([
    "base64",
    "contentBase64",
    "data",
    "dataUrl",
    "image_url",
]);
const CANONICAL_MEDIA_SAMPLE_LENGTH = 64;
export const MAX_CANONICAL_CHAT_IMAGES = 10;
export const MAX_CANONICAL_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS =
    Math.ceil((MAX_CANONICAL_CHAT_IMAGE_BYTES * 4) / 3) + 8;
const MAX_CANONICAL_CHAT_THINKING_BLOCKS = 100;
const MAX_CANONICAL_CHAT_TOOL_CALLS = 100;
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

function isCanonicalMediaRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (CANONICAL_MEDIA_BLOCK_TYPES.has(type)) {
        return true;
    }
    return (
        typeof record.fileName === "string" &&
        ["file", "image", "text"].includes(String(record.kind))
    );
}

function summarizedCanonicalMediaData(value: string): {
    edgeFingerprint: string;
    length: number;
} {
    const edgeSample =
        value.length <= CANONICAL_MEDIA_SAMPLE_LENGTH * 2
            ? value
            : `${value.slice(0, CANONICAL_MEDIA_SAMPLE_LENGTH)}${value.slice(
                  -CANONICAL_MEDIA_SAMPLE_LENGTH
              )}`;
    return {
        edgeFingerprint: canonicalChatContentFingerprint(edgeSample),
        length: value.length,
    };
}

function summarizeCanonicalChatFingerprintValue(
    value: unknown,
    field: string,
    isMediaRecord: boolean
): unknown {
    if (
        typeof value === "string" &&
        isMediaRecord &&
        (CANONICAL_MEDIA_DATA_FIELDS.has(field) || value.startsWith("data:image/"))
    ) {
        return summarizedCanonicalMediaData(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) =>
            summarizeCanonicalChatFingerprintValue(item, "", isMediaRecord)
        );
    }
    const record = canonicalChatRecord(value);
    if (!record) {
        return value;
    }
    const nestedIsMediaRecord = isMediaRecord || isCanonicalMediaRecord(record);
    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [
            key,
            summarizeCanonicalChatFingerprintValue(item, key, nestedIsMediaRecord),
        ])
    );
}

/**
 * Replaces embedded media bytes with bounded identity metadata for hot-path
 * fingerprints while preserving text, tool, lifecycle, and provider fields.
 * @param value Canonical or provider chat value.
 * @returns Fingerprint-safe value without full embedded media payloads.
 */
export function summarizeCanonicalChatValueForFingerprint(value: unknown): unknown {
    return summarizeCanonicalChatFingerprintValue(value, "", false);
}

function attachmentIdentity(attachment: CanonicalChatAttachment): string {
    const content =
        attachment.contentBase64 || attachment.dataUrl || attachment.url || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? canonicalChatContentFingerprint(content) : attachment.id,
    ].join("::");
}

function currentDashboardOrigin(): string | undefined {
    const locationValue = (
        globalThis as typeof globalThis & {
            location?: { origin?: string };
        }
    ).location;
    const origin = locationValue?.origin;
    return origin && origin !== "null" ? origin : undefined;
}

function parseChatUrl(value: string): ParsedChatUrl | undefined {
    if (value.startsWith("//")) {
        return undefined;
    }
    const dashboardOrigin = currentDashboardOrigin();
    const isRootRelative = value.startsWith("/");
    try {
        const url = new URL(value, dashboardOrigin || DASHBOARD_URL_FALLBACK_ORIGIN);
        return {
            isRootRelative,
            isSameDashboardOrigin:
                isRootRelative ||
                Boolean(dashboardOrigin && url.origin === dashboardOrigin),
            url,
        };
    } catch {
        return undefined;
    }
}

function dashboardMediaKind(pathname: string): DashboardMediaKind | undefined {
    if (pathname === "/api/media") {
        return "local";
    }
    return pathname.startsWith("/api/chat/media/outgoing/") ? "managed" : undefined;
}

/**
 * Removes an origin from a recognized Dashboard media route.
 * @param value Candidate Dashboard media URL.
 * @returns Portable root-relative media URL when recognized.
 */
export function canonicalChatPortableDashboardMediaUrl(
    value: string
): string | undefined {
    const parsed = parseChatUrl(value.trim());
    if (
        !parsed ||
        !dashboardMediaKind(parsed.url.pathname) ||
        !parsed.isSameDashboardOrigin
    ) {
        return undefined;
    }
    return `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`;
}

function dashboardMediaReference(value: string): DashboardMediaReference | undefined {
    const candidate = value.trim();
    const parsed = parseChatUrl(candidate);
    if (!parsed) {
        return undefined;
    }
    const kind = dashboardMediaKind(parsed.url.pathname);
    if (!kind) {
        return undefined;
    }
    if (parsed.isSameDashboardOrigin) {
        return { kind, url: candidate };
    }
    return undefined;
}

function dashboardMediaKindFromUrl(url: string): DashboardMediaKind | undefined {
    return dashboardMediaReference(url)?.kind;
}

function safeChatImageUrl(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const candidate = value.trim();
    if (!candidate) {
        return undefined;
    }
    if (candidate.startsWith("data:image/")) {
        return candidate;
    }
    const mediaReference = dashboardMediaReference(candidate);
    if (mediaReference) {
        return mediaReference.url;
    }
    const parsed = parseChatUrl(candidate);
    if (!parsed) {
        return undefined;
    }
    const mediaKind = parsed.isSameDashboardOrigin
        ? dashboardMediaKind(parsed.url.pathname)
        : undefined;
    if (parsed.isRootRelative) {
        return mediaKind ? candidate : undefined;
    }
    const isDashboardApiPath =
        parsed.url.pathname === "/api" || parsed.url.pathname.startsWith("/api/");
    if (isDashboardApiPath && !mediaKind && parsed.isSameDashboardOrigin) {
        return undefined;
    }
    return CHAT_IMAGE_URL_PROTOCOLS.has(parsed.url.protocol) ? candidate : undefined;
}

/**
 * Returns a local path encoded in a canonical Dashboard media URL.
 * @param url Dashboard media URL.
 * @returns Local path when the URL targets local Dashboard media.
 */
export function canonicalChatLocalMediaPathFromUrl(url: string): string | undefined {
    const mediaReference = dashboardMediaReference(url);
    if (mediaReference?.kind !== "local") {
        return undefined;
    }
    const parsed = parseChatUrl(mediaReference.url);
    return parsed?.url.searchParams.get("path")?.trim() || undefined;
}

function attachmentPreviewUrl(url: string, mode: "image" | "text"): string | undefined {
    const mediaReference = dashboardMediaReference(url);
    if (mediaReference) {
        const fragmentIndex = mediaReference.url.indexOf("#");
        const urlWithoutFragment =
            fragmentIndex === -1
                ? mediaReference.url
                : mediaReference.url.slice(0, fragmentIndex);
        const fragment =
            fragmentIndex === -1 ? "" : mediaReference.url.slice(fragmentIndex);
        if (/[?&]preview=(?:image|text)(?=&|$)/u.test(urlWithoutFragment)) {
            return `${urlWithoutFragment.replace(
                /[?&]preview=(?:image|text)(?=&|$)/u,
                (match) => `${match[0]}preview=${mode}`
            )}${fragment}`;
        }
        return `${urlWithoutFragment}${urlWithoutFragment.includes("?") ? "&" : "?"}preview=${mode}${fragment}`;
    }
    return mode === "image" ? safeChatImageUrl(url) : undefined;
}

/**
 * Returns a safe display URL for a canonical chat image.
 * @param url Candidate image URL.
 * @param mimeType Image MIME type.
 * @returns Safe display URL when the candidate is supported.
 */
export function canonicalChatImageDisplayUrl(
    url: string,
    mimeType: string
): string | undefined {
    const safeUrl = safeChatImageUrl(url);
    if (!safeUrl) {
        return undefined;
    }
    const mediaKind = dashboardMediaKindFromUrl(safeUrl);
    if (!mediaKind && !safeUrl.startsWith("data:image/")) {
        return undefined;
    }
    const isManagedMedia = mediaKind === "managed";
    return isManagedMedia || normalizeCanonicalChatMimeType(mimeType) === "image/svg+xml"
        ? attachmentPreviewUrl(safeUrl, "image")
        : safeUrl;
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
    for (const image of [...previous, ...next]) {
        const normalized = normalizeCanonicalChatImage(image);
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

/**
 * Bounds one provider image while retaining URL-backed images and supported payloads.
 * @param image Provider image block.
 * @returns Safe bounded image, or undefined when it has no usable source.
 */
export function normalizeCanonicalChatImage(
    image: CanonicalChatImage
): CanonicalChatImage | undefined {
    const declaredMimeType = image.source?.media_type || image.mimeType;
    const data = boundedEmbeddedImageData(image.data, declaredMimeType);
    const sourceData = boundedEmbeddedImageData(image.source?.data, declaredMimeType);
    const normalized: CanonicalChatImage = {
        ...image,
        alt: image.alt ? truncateCanonicalChatText(image.alt, 4096) : image.alt,
        data,
        source: image.source ? { ...image.source, data: sourceData } : undefined,
    };
    if (normalized.source && !Object.values(normalized.source).some(Boolean)) {
        normalized.source = undefined;
    }
    return data || sourceData || canonicalImageHasUrl(normalized)
        ? normalized
        : undefined;
}

/**
 * Merges canonical attachments without repeating content identity.
 * @param previous Previously collected attachments.
 * @param next Incoming attachments.
 * @returns Attachments in first-seen order.
 */
export function mergeCanonicalChatAttachments(
    previous: CanonicalChatAttachment[] = [],
    next: CanonicalChatAttachment[] = []
): CanonicalChatAttachment[] {
    const seen = new Set<string>();
    return [...previous, ...next].filter((attachment) => {
        const identity = attachmentIdentity(attachment);
        if (seen.has(identity)) {
            return false;
        }
        seen.add(identity);
        return true;
    });
}

/**
 * Extracts image blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical image blocks.
 */
export function extractCanonicalChatImages(content: unknown): CanonicalChatImage[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const images: CanonicalChatImage[] = [];
    for (const item of content) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            continue;
        }
        const record = item as Record<string, unknown>;
        const type =
            record.type === "image" ||
            record.type === "image_url" ||
            record.type === "input_image"
                ? record.type
                : undefined;
        if (!type) {
            continue;
        }

        const rawImageUrl = record.image_url;
        const imageUrlRecord =
            rawImageUrl && typeof rawImageUrl === "object" && !Array.isArray(rawImageUrl)
                ? (rawImageUrl as Record<string, unknown>)
                : undefined;
        let imageUrl: CanonicalChatImage["image_url"];
        if (typeof rawImageUrl === "string") {
            imageUrl = rawImageUrl;
        } else if (typeof imageUrlRecord?.url === "string") {
            imageUrl = { url: imageUrlRecord.url };
        }
        const rawSource =
            record.source &&
            typeof record.source === "object" &&
            !Array.isArray(record.source)
                ? (record.source as Record<string, unknown>)
                : undefined;
        const source = rawSource
            ? {
                  data: typeof rawSource.data === "string" ? rawSource.data : undefined,
                  media_type:
                      typeof rawSource.media_type === "string"
                          ? rawSource.media_type
                          : undefined,
                  type: typeof rawSource.type === "string" ? rawSource.type : undefined,
                  url: typeof rawSource.url === "string" ? rawSource.url : undefined,
              }
            : undefined;

        const image = normalizeCanonicalChatImage({
            alt: typeof record.alt === "string" ? record.alt : undefined,
            data: typeof record.data === "string" ? record.data : undefined,
            image_url: imageUrl,
            mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
            openUrl: typeof record.openUrl === "string" ? record.openUrl : undefined,
            source:
                source && Object.values(source).some((value) => value !== undefined)
                    ? source
                    : undefined,
            type,
            url: typeof record.url === "string" ? record.url : undefined,
        });
        if (image) {
            images.push(image);
        }
        if (images.length >= MAX_CANONICAL_CHAT_IMAGES) {
            break;
        }
    }
    return images;
}

/**
 * Extracts thinking blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical thinking blocks.
 */
export function extractCanonicalChatThinking(content: unknown): CanonicalChatThinking[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: CanonicalChatThinking[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "thinking"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        let text = typeof record.text === "string" ? record.text : "";
        if (typeof record.thinking === "string") {
            text = record.thinking;
        }
        if (text.trim()) {
            blocks.push({ text: truncateCanonicalChatText(text, 256 * 1024) });
        }
        if (blocks.length >= MAX_CANONICAL_CHAT_THINKING_BLOCKS) {
            break;
        }
    }
    return blocks;
}

/**
 * Extracts tool calls from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical tool calls.
 */
export function extractCanonicalChatToolCalls(content: unknown): CanonicalChatToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const calls: CanonicalChatToolCall[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "toolCall"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : "";
        calls.push({
            arguments: boundCanonicalChatToolValue(record.arguments),
            id: id || undefined,
            name: name || "tool",
        });
        if (calls.length >= MAX_CANONICAL_CHAT_TOOL_CALLS) {
            break;
        }
    }
    return calls;
}

/**
 * Returns the display kind for a MIME type.
 * @param mimeType MIME type to classify.
 * @returns Canonical attachment kind.
 */
export function canonicalChatAttachmentKind(
    mimeType: string
): CanonicalChatAttachment["kind"] {
    const normalized = normalizeCanonicalChatMimeType(mimeType);
    if (normalized.startsWith("image/")) {
        return "image";
    }
    if (normalized === "application/json" || normalized.startsWith("text/")) {
        return "text";
    }
    return "file";
}

/**
 * Normalizes text from OpenClaw string and content-block variants.
 * @param content Provider content.
 * @returns Normalized text.
 */
export function normalizeCanonicalChatText(content: unknown): string {
    if (typeof content === "string") {
        return truncateCanonicalChatText(content, MAX_CANONICAL_CHAT_TEXT_CHARACTERS);
    }
    if (Array.isArray(content)) {
        return truncateCanonicalChatText(
            content
                .map((item) => {
                    if (typeof item === "string") {
                        return item;
                    }
                    if (!item || typeof item !== "object") {
                        return "";
                    }
                    const block = item as Record<string, unknown>;
                    if (typeof block.text === "string") {
                        return block.text;
                    }
                    return ["image", "image_url", "input_image"].includes(
                        String(block.type)
                    )
                        ? "[image]"
                        : "";
                })
                .filter(Boolean)
                .join("\n\n"),
            MAX_CANONICAL_CHAT_TEXT_CHARACTERS
        );
    }
    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        return typeof maybe.text === "string"
            ? truncateCanonicalChatText(maybe.text, MAX_CANONICAL_CHAT_TEXT_CHARACTERS)
            : "";
    }
    return "";
}
