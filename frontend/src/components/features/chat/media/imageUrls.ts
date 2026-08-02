import { normalizeCanonicalChatImage } from "../../../../../../contracts/chatCanonicalMessage";
import { normalizeChatMimeType } from "./identity";
import type { ChatImageBlock } from "./types";

const CHAT_IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DASHBOARD_URL_FALLBACK_ORIGIN = "https://dashboard.invalid";
const MAX_CHAT_IMAGE_DIMENSION = 16_384;
const MAX_CHAT_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_CHAT_IMAGE_HEADER_BYTES = 512 * 1024;

type DashboardMediaKind = "local" | "managed";

interface ParsedChatUrl {
    isRootRelative: boolean;
    isSameDashboardOrigin: boolean;
    url: URL;
}

function currentDashboardOrigin(): string | undefined {
    if (!("location" in globalThis)) {
        return undefined;
    }
    const origin = location.origin;
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
    return pathname.startsWith("/api/chat/media/outgoing/")
        ? "managed"
        : undefined;
}

function dashboardMediaKindFromUrl(url: string): DashboardMediaKind | undefined {
    const parsedChatUrl = parseChatUrl(url);
    return parsedChatUrl?.isSameDashboardOrigin
        ? dashboardMediaKind(parsedChatUrl.url.pathname)
        : undefined;
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
    const parsedChatUrl = parseChatUrl(candidate);
    if (!parsedChatUrl) {
        return undefined;
    }
    const mediaKind = parsedChatUrl.isSameDashboardOrigin
        ? dashboardMediaKind(parsedChatUrl.url.pathname)
        : undefined;
    if (parsedChatUrl.isRootRelative) {
        return mediaKind ? candidate : undefined;
    }
    const isDashboardApiPath =
        parsedChatUrl.url.pathname === "/api" ||
        parsedChatUrl.url.pathname.startsWith("/api/");
    if (isDashboardApiPath && !mediaKind && parsedChatUrl.isSameDashboardOrigin) {
        return undefined;
    }
    return CHAT_IMAGE_URL_PROTOCOLS.has(parsedChatUrl.url.protocol)
        ? candidate
        : undefined;
}

/** Returns the original local path encoded in a Dashboard media URL. */
export function chatLocalMediaPathFromUrl(url: string): string | undefined {
    const parsedChatUrl = parseChatUrl(url);
    if (
        !parsedChatUrl?.isSameDashboardOrigin ||
        dashboardMediaKind(parsedChatUrl.url.pathname) !== "local"
    ) {
        return undefined;
    }
    return parsedChatUrl.url.searchParams.get("path")?.trim() || undefined;
}

/** Returns a bounded preview URL for Dashboard-managed media. */
export function chatAttachmentPreviewUrl(
    url: string,
    mode: "image" | "text"
): string | undefined {
    if (dashboardMediaKindFromUrl(url)) {
        const fragmentIndex = url.indexOf("#");
        const urlWithoutFragment =
            fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
        const fragment = fragmentIndex === -1 ? "" : url.slice(fragmentIndex);
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

/** Returns the original safe URL from every OpenClaw image block variant. */
export function chatImageDownloadUrl(image: ChatImageBlock): string | undefined {
    const normalizedImage = normalizeCanonicalChatImage(image);
    if (!normalizedImage) {
        return undefined;
    }
    const imageUrl =
        typeof normalizedImage.image_url === "string"
            ? normalizedImage.image_url
            : normalizedImage.image_url?.url;
    const directUrl = [
        normalizedImage.url,
        normalizedImage.openUrl,
        normalizedImage.source?.url,
        imageUrl,
    ]
        .map((value) => safeChatImageUrl(value))
        .find(Boolean);
    if (directUrl) {
        return directUrl;
    }
    const imageData = normalizedImage.source?.data || normalizedImage.data;
    if (!imageData) {
        return undefined;
    }
    const normalizedImageData = imageData.trim();
    if (normalizedImageData.startsWith("data:image/")) {
        return safeChatImageUrl(normalizedImageData);
    }
    const mimeType =
        normalizedImage.source?.media_type ||
        normalizedImage.mimeType ||
        "image/png";
    return `data:${mimeType};base64,${normalizedImageData}`;
}

interface ChatImageDimensions {
    height: number;
    width: number;
}

function base64ImageHeader(dataUrl: string): Uint8Array | undefined {
    const match = /^data:[^;,]+;base64,([\s\S]+)$/iu.exec(dataUrl);
    if (!match?.[1]) {
        return undefined;
    }
    const encodedPrefix = match[1]
        .slice(0, Math.ceil((MAX_CHAT_IMAGE_HEADER_BYTES * 4) / 3) + 8)
        .replaceAll(/\s/gu, "");
    try {
        const decoded = atob(encodedPrefix);
        return Uint8Array.from(
            decoded,
            (character) => character.codePointAt(0) ?? 0
        );
    } catch {
        return undefined;
    }
}

function bigEndian16(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
        offset
    );
}

function bigEndian32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        offset
    );
}

function jpegDimensions(bytes: Uint8Array): ChatImageDimensions | undefined {
    if (bytes[0] !== 255 || bytes[1] !== 216) {
        return undefined;
    }
    const startOfFrameMarkers = new Set([
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 255) {
            offset += 1;
            continue;
        }
        while (bytes[offset] === 255) {
            offset += 1;
        }
        const marker = bytes[offset];
        if (marker === undefined || marker === 218 || marker === 217) {
            return undefined;
        }
        if (startOfFrameMarkers.has(marker)) {
            return {
                height: bigEndian16(bytes, offset + 4),
                width: bigEndian16(bytes, offset + 6),
            };
        }
        if (marker === 1 || (marker >= 208 && marker <= 215)) {
            offset += 1;
            continue;
        }
        const segmentLength = bigEndian16(bytes, offset + 1);
        if (segmentLength < 2) {
            return undefined;
        }
        offset += segmentLength + 1;
    }
    return undefined;
}

function webpDimensions(bytes: Uint8Array): ChatImageDimensions | undefined {
    const ascii = (offset: number, length: number) =>
        String.fromCodePoint(...bytes.slice(offset, offset + length));
    if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") {
        return undefined;
    }
    const format = ascii(12, 4);
    if (format === "VP8X" && bytes.length >= 30) {
        return {
            width:
                1 +
                (bytes[24] ?? 0) +
                ((bytes[25] ?? 0) << 8) +
                ((bytes[26] ?? 0) << 16),
            height:
                1 +
                (bytes[27] ?? 0) +
                ((bytes[28] ?? 0) << 8) +
                ((bytes[29] ?? 0) << 16),
        };
    }
    if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 47) {
        return {
            width: 1 + (((bytes[22] ?? 0) & 63) << 8) + (bytes[21] ?? 0),
            height:
                1 +
                (((bytes[24] ?? 0) & 15) << 10) +
                ((bytes[23] ?? 0) << 2) +
                (((bytes[22] ?? 0) & 192) >> 6),
        };
    }
    if (
        format === "VP8 " &&
        bytes.length >= 30 &&
        bytes[23] === 157 &&
        bytes[24] === 1 &&
        bytes[25] === 42
    ) {
        return {
            width: (((bytes[27] ?? 0) << 8) | (bytes[26] ?? 0)) & 16_383,
            height: (((bytes[29] ?? 0) << 8) | (bytes[28] ?? 0)) & 16_383,
        };
    }
    return undefined;
}

function embeddedChatImageDimensions(
    dataUrl: string
): ChatImageDimensions | undefined {
    const bytes = base64ImageHeader(dataUrl);
    if (!bytes) {
        return undefined;
    }
    if (
        bytes.length >= 24 &&
        bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71
    ) {
        return { width: bigEndian32(bytes, 16), height: bigEndian32(bytes, 20) };
    }
    const header = String.fromCodePoint(...bytes.slice(0, 6));
    if ((header === "GIF87a" || header === "GIF89a") && bytes.length >= 10) {
        return {
            width: (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
            height: (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8),
        };
    }
    return jpegDimensions(bytes) || webpDimensions(bytes);
}

function isEmbeddedChatImageWithinDimensionLimit(dataUrl: string): boolean {
    const dimensions = embeddedChatImageDimensions(dataUrl);
    return Boolean(
        dimensions &&
        dimensions.width > 0 &&
        dimensions.height > 0 &&
        dimensions.width <= MAX_CHAT_IMAGE_DIMENSION &&
        dimensions.height <= MAX_CHAT_IMAGE_DIMENSION &&
        dimensions.width * dimensions.height <= MAX_CHAT_IMAGE_PIXELS
    );
}

/** Returns a safe inline image URL while preserving the download URL. */
export function chatImageDisplayUrl(
    url: string,
    mimeType: string
): string | undefined {
    const safeUrl = safeChatImageUrl(url);
    if (!safeUrl) {
        return undefined;
    }
    if (
        safeUrl.startsWith("data:image/") &&
        !isEmbeddedChatImageWithinDimensionLimit(safeUrl)
    ) {
        return undefined;
    }
    const mediaKind = dashboardMediaKindFromUrl(safeUrl);
    if (!mediaKind && !safeUrl.startsWith("data:image/")) {
        return undefined;
    }
    const isManagedMedia = mediaKind === "managed";
    return isManagedMedia || normalizeChatMimeType(mimeType) === "image/svg+xml"
        ? chatAttachmentPreviewUrl(safeUrl, "image")
        : safeUrl;
}

/** Returns an embeddable URL from every OpenClaw image block variant. */
export function chatImageUrl(image: ChatImageBlock): string | undefined {
    const downloadUrl = chatImageDownloadUrl(image);
    return downloadUrl
        ? chatImageDisplayUrl(downloadUrl, chatImageMimeType(image))
        : undefined;
}

/** Returns the declared image MIME type with a safe display fallback. */
export function chatImageMimeType(image: ChatImageBlock): string {
    const declaredMimeType = image.source?.media_type || image.mimeType;
    if (declaredMimeType) {
        return declaredMimeType;
    }
    const localMediaPath = chatLocalMediaPathFromUrl(
        chatImageDownloadUrl(image) || ""
    );
    return localMediaPath?.toLowerCase().endsWith(".svg")
        ? "image/svg+xml"
        : "image/png";
}
