import type { ChatTransportAttachment } from "../../../../../contracts/chat";
import type {
    CanonicalChatEvent,
    CanonicalChatProviderMetadata,
} from "../../../../../contracts/chatCanonical";
import {
    extractCanonicalChatImages,
    mergeCanonicalChatImages,
    normalizeCanonicalChatImage,
} from "../../../../../contracts/chatCanonicalMessage";

/** Defines normalized role variants that represent tool result rows. */
export const TOOL_ROLE_VARIANTS: readonly string[] = [
    "tool",
    "tool_result",
    "toolresult",
];
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

/** Represents chat image block. */
export interface ChatImageBlock {
    type: "image" | "image_url" | "input_image";
    alt?: string;
    mimeType?: string;
    data?: string;
    url?: string;
    openUrl?: string;
    image_url?:
        | string
        | {
              url?: string;
          };
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
        url?: string;
    };
}

/** Represents chat attachment display. */
export interface ChatAttachmentDisplay {
    id: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    dataUrl?: string;
    url?: string;
    contentBase64?: string;
    kind: "image" | "text" | "file";
}

/** Represents chat preview item. */
export interface ChatPreviewItem {
    title: string;
    mimeType?: string;
    kind: "image" | "text" | "file";
    url?: string;
    text?: string;
    sizeBytes?: number;
}

/** Represents chat send attachment. */
export interface ChatSendAttachment {
    id: string;
    file: File;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentBase64: string;
    dataUrl?: string;
    kind: "image" | "text" | "file";
}

/** Identifies where files were added so validation feedback stays local. */
export type ChatAttachmentInputSource = "composer" | "picker";

/** Represents attachment validation feedback and its presentation target. */
export interface ChatAttachmentError {
    message: string;
    source: ChatAttachmentInputSource;
}

/**
 * Returns a lowercase MIME type without optional parameters.
 * @param mimeType Mime type value.
 * @returns a lowercase MIME type without optional parameters.
 */
export function normalizeChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function unsigned32(value: number): number {
    return value < 0 ? value + 4_294_967_296 : value;
}

/**
 * Returns a compact fingerprint that incorporates every character.
 * @param content Content value.
 * @returns a compact fingerprint that incorporates every character.
 */
export function chatContentFingerprint(content: string): string {
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

/**
 * Returns attachment content identity independent of transient row IDs.
 * @returns attachment content identity independent of transient row IDs.
 */
export function chatAttachmentIdentity(attachment: ChatAttachmentDisplay): string {
    const content =
        attachment.contentBase64 || attachment.dataUrl || attachment.url || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? chatContentFingerprint(content) : attachment.id,
    ].join("::");
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
    return pathname.startsWith("/api/chat/media/outgoing/") ? "managed" : undefined;
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

/**
 * Returns the original local path encoded in a canonical Dashboard media URL.
 * @param url Url value.
 * @returns the original local path encoded in a canonical Dashboard media URL.
 */
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

/**
 * Returns a bounded preview URL for Dashboard-managed media.
 * @param url Url value.
 * @param mode Mode value.
 * @returns a bounded preview URL for Dashboard-managed media.
 */
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

/**
 * Returns the original safe URL from every OpenClaw image block variant.
 * @returns the original safe URL from every OpenClaw image block variant.
 */
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
        normalizedImage.source?.media_type || normalizedImage.mimeType || "image/png";
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
        return Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
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
                1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16),
            height:
                1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16),
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

function embeddedChatImageDimensions(dataUrl: string): ChatImageDimensions | undefined {
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

/**
 * Returns a safe inline image URL while preserving the original download URL.
 * @param url Url value.
 * @param mimeType Mime type value.
 * @returns a safe inline image URL while preserving the original download URL.
 */
export function chatImageDisplayUrl(url: string, mimeType: string): string | undefined {
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

/**
 * Returns an embeddable URL from every OpenClaw image block variant.
 * @returns an embeddable URL from every OpenClaw image block variant.
 */
export function chatImageUrl(image: ChatImageBlock): string | undefined {
    const downloadUrl = chatImageDownloadUrl(image);
    return downloadUrl
        ? chatImageDisplayUrl(downloadUrl, chatImageMimeType(image))
        : undefined;
}

/**
 * Returns the declared image MIME type with a safe display fallback.
 * @returns the declared image MIME type with a safe display fallback.
 */
export function chatImageMimeType(image: ChatImageBlock): string {
    const declaredMimeType = image.source?.media_type || image.mimeType;
    if (declaredMimeType) {
        return declaredMimeType;
    }
    const localMediaPath = chatLocalMediaPathFromUrl(chatImageDownloadUrl(image) || "");
    return localMediaPath?.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
}

/**
 * Merges image blocks without repeating identical payloads.
 * @param previous Previous value.
 * @param next Next value.
 * @returns Merge chat images result.
 */
export function mergeChatImages(
    previous: ChatImageBlock[] = [],
    next: ChatImageBlock[] = []
): ChatImageBlock[] {
    return mergeCanonicalChatImages(previous, next);
}

/**
 * Merges attachment display rows without repeating IDs.
 * @param previous Previous value.
 * @param next Next value.
 * @returns Merge chat attachments result.
 */
export function mergeChatAttachments(
    previous: ChatAttachmentDisplay[] = [],
    next: ChatAttachmentDisplay[] = []
): ChatAttachmentDisplay[] {
    const seenAttachments = new Set<string>();
    return [...previous, ...next].filter((attachment) => {
        const identity = chatAttachmentIdentity(attachment);
        if (seenAttachments.has(identity)) {
            return false;
        }
        seenAttachments.add(identity);
        return true;
    });
}

/** Represents chat thinking display. */
export interface ChatThinkingDisplay {
    id?: string;
    snapshot?: boolean;
    text: string;
}

/** Represents chat tool call display. */
export interface ChatToolCallDisplay {
    id?: string;
    name: string;
    arguments?: unknown;
    toolResult?: ChatToolResultDisplay;
}

/** Represents chat tool result display. */
export interface ChatToolResultDisplay {
    id?: string;
    name?: string;
    content: string;
    isError?: boolean;
    /** Runtime completion metadata that is not the transcript's actual tool output. */
    isPlaceholder?: boolean;
    images?: ChatImageBlock[];
}

/** Represents chat visibility settings. */
export interface ChatVisibilitySettings {
    shouldShowThinking: boolean;
    shouldShowTools: boolean;
}

/** Provider-independent source identity retained while projecting one message. */
export interface ChatMessageSourceReference {
    id: string;
    origin?: CanonicalChatEvent["origin"];
    provider?: CanonicalChatProviderMetadata;
    sequence?: number;
    source: "openclaw-history" | "openclaw-runtime";
}

/** Primary source plus any provider rows folded into the same visible message. */
export interface ChatMessageProvenance extends ChatMessageSourceReference {
    relatedSources?: ChatMessageSourceReference[];
}

function chatMessageSourceReference(
    provenance: ChatMessageProvenance
): ChatMessageSourceReference {
    const { relatedSources: _relatedSources, ...reference } = provenance;
    return reference;
}

function chatMessageSourceKey(source: ChatMessageSourceReference): string {
    return `${source.source}\u0000${source.id}\u0000${source.sequence ?? ""}`;
}

/**
 * Keeps one primary source while retaining every source folded into the message.
 * @param primary Source represented by the resulting message.
 * @param folded Older or secondary source folded into the same message.
 * @returns Combined provenance without duplicate source identities.
 */
export function mergeChatMessageProvenance(
    primary: ChatMessageProvenance | undefined,
    folded: ChatMessageProvenance | undefined
): ChatMessageProvenance | undefined {
    if (!primary) return folded;
    if (!folded) return primary;

    const primaryKey = chatMessageSourceKey(primary);
    const relatedSources = new Map<string, ChatMessageSourceReference>();
    for (const reference of [
        ...(primary.relatedSources || []),
        chatMessageSourceReference(folded),
        ...(folded.relatedSources || []),
    ]) {
        const key = chatMessageSourceKey(reference);
        if (key !== primaryKey) {
            relatedSources.set(key, reference);
        }
    }
    return {
        ...primary,
        ...(relatedSources.size > 0 && {
            relatedSources: relatedSources.values().toArray(),
        }),
    };
}

/** Represents chat history message. */
export interface ChatHistoryMessage {
    role: string;
    content: unknown;
    controlId?: string;
    text: string;
    images?: ChatImageBlock[];
    /** Dashboard-visible system/control notice that must not become a human turn. */
    intent?: "commentary" | "control";
    attachments?: ChatAttachmentDisplay[];
    /** True when every attachment was carried over from hidden tool output. */
    hasOnlyHiddenToolAttachments?: boolean;
    thinking?: ChatThinkingDisplay[];
    toolCalls?: ChatToolCallDisplay[];
    toolResult?: ChatToolResultDisplay;
    timestamp?: string;
    local?: boolean;
    runId?: string;
    /** True only when the runtime has identified this row as the final answer. */
    isFinal?: boolean;
    /** True only for an assistant turn terminated by the provider for tool use. */
    isToolUse?: boolean;
    /** Stable identity for one transient runtime row inside a run. */
    runtimeKey?: string;
    /** Canonical Gateway event order used only while reconciling runtime rows. */
    runtimeSequence?: number;
    /** Canonical transport identity used to assemble versioned turns. */
    provenance?: ChatMessageProvenance;
}

/**
 * Returns every image carried directly or by a nested tool result.
 * @returns every image carried directly or by a nested tool result.
 */
export function allChatMessageImages(message: ChatHistoryMessage): ChatImageBlock[] {
    let images = mergeChatImages(message.images, message.toolResult?.images);
    const toolCalls = message.toolCalls || [];
    for (const toolCall of toolCalls) {
        images = mergeChatImages(images, toolCall.toolResult?.images);
    }
    return images;
}

/** Represents one chat row. */
export interface ChatRow {
    deleteKeys?: string[];
    key: string;
    kind: "message" | "status" | "stream" | "typing";
    message: ChatHistoryMessage;
}

/** Defines default chat visibility. */
export const DEFAULT_CHAT_VISIBILITY: ChatVisibilitySettings = {
    shouldShowThinking: false,
    shouldShowTools: false,
};

/**
 * Returns whether record.
 * @param value Value to process.
 * @returns Whether record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Extracts images.
 * @param content Content value.
 * @returns Extract images result.
 */
export function extractImages(content: unknown): ChatImageBlock[] {
    return extractCanonicalChatImages(content);
}

/**
 * Extracts thinking blocks.
 * @param content Content value.
 * @returns Extract thinking blocks result.
 */
export function extractThinkingBlocks(content: unknown): ChatThinkingDisplay[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const blocks: ChatThinkingDisplay[] = [];

    for (const item of content) {
        if (!isRecord(item) || item.type !== "thinking") {
            continue;
        }

        let text = typeof item.text === "string" ? item.text : "";
        if (typeof item.thinking === "string") {
            text = item.thinking;
        }

        if (text.trim()) {
            blocks.push({ text });
        }
    }

    return blocks;
}

/**
 * Extracts tool calls.
 * @param content Content value.
 * @returns Extract tool calls result.
 */
export function extractToolCalls(content: unknown): ChatToolCallDisplay[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const toolCalls: ChatToolCallDisplay[] = [];

    for (const item of content) {
        if (!isRecord(item) || item.type !== "toolCall") {
            continue;
        }

        toolCalls.push({
            id: typeof item.id === "string" ? item.id : undefined,
            name: typeof item.name === "string" ? item.name : "tool",
            arguments: item.arguments,
        });
    }

    return toolCalls;
}

/**
 * Performs attachment kind.
 * @param mimeType Mime type value.
 * @returns Attachment kind result.
 */
export function attachmentKind(mimeType: string): ChatAttachmentDisplay["kind"] {
    const normalizedMimeType = normalizeChatMimeType(mimeType);
    if (normalizedMimeType.startsWith("image/")) {
        return "image";
    }

    if (
        normalizedMimeType === "application/json" ||
        normalizedMimeType.startsWith("text/")
    ) {
        return "text";
    }

    return "file";
}

/**
 * Performs gateway attachments.
 * @param attachments Attachments value.
 * @returns Gateway attachments result.
 */
export function chatTransportAttachments(
    attachments: ChatSendAttachment[]
): ChatTransportAttachment[] {
    return attachments.map((attachment) => ({
        type: attachment.kind,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        content: attachment.contentBase64,
    }));
}

/**
 * Performs optimistic attachment display.
 * @param attachments Attachments value.
 * @returns Optimistic attachment display result.
 */
export function optimisticAttachmentDisplay(
    attachments: ChatSendAttachment[]
): ChatAttachmentDisplay[] {
    return attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.dataUrl,
        contentBase64: attachment.contentBase64,
        kind: attachment.kind,
    }));
}

/**
 * Normalizes text.
 * @param content Content value.
 * @returns Normalized text.
 */
export function normalizeText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
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

                if (["image", "image_url", "input_image"].includes(String(block.type))) {
                    return "[image]";
                }

                return "";
            })
            .filter(Boolean)
            .join("\n\n");
    }

    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        if (typeof maybe.text === "string") {
            return maybe.text;
        }
    }

    return "";
}

/**
 * Returns whether a role represents a tool-result transcript row.
 * @param role Role value.
 * @returns Whether a role represents a tool-result transcript row.
 */
function isToolRole(role: string): boolean {
    return TOOL_ROLE_VARIANTS.includes(role);
}

/**
 * Returns whether renderable chat history message.
 * @returns Whether renderable chat history message.
 */
export function isRenderableChatHistoryMessage(
    message: ChatHistoryMessage,
    visibility: ChatVisibilitySettings = DEFAULT_CHAT_VISIBILITY
): boolean {
    const role = message.role.toLowerCase();
    if (isToolRole(role)) {
        return (
            visibility.shouldShowTools &&
            ((message.toolResult?.content.trim() || "").length > 0 ||
                allChatMessageImages(message).length > 0 ||
                (message.attachments?.length || 0) > 0)
        );
    }

    if (
        (!message.isToolUse && message.text.trim()) ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    ) {
        return true;
    }

    return (
        (visibility.shouldShowThinking && (message.thinking?.length || 0) > 0) ||
        (visibility.shouldShowTools && (message.toolCalls?.length || 0) > 0)
    );
}
