/** Defines normalized role variants that represent tool result rows. */
export const TOOL_ROLE_VARIANTS: readonly string[] = [
    "tool",
    "tool_result",
    "toolresult",
];
const CHAT_IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DASHBOARD_URL_FALLBACK_ORIGIN = "https://dashboard.invalid";

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

/** Returns a lowercase MIME type without optional parameters. */
export function normalizeChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

/** Returns a compact fingerprint that incorporates every character. */
export function chatContentFingerprint(content: string): string {
    let firstHash = 2_166_136_261;
    let secondHash = 2_654_435_761;
    for (let index = 0; index < content.length; index += 1) {
        const code = content.codePointAt(index) ?? 0;
        firstHash = Math.imul(firstHash ^ code, 16_777_619);
        secondHash = Math.imul(secondHash ^ code, 2_246_822_519);
    }
    return `${content.length}:${(firstHash >>> 0).toString(36)}:${(
        secondHash >>> 0
    ).toString(36)}`;
}

/** Returns attachment content identity independent of transient row IDs. */
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

/** Returns the original local path encoded in a canonical Dashboard media URL. */
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
    const imageUrl =
        typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
    const directUrl = [image.url, image.openUrl, image.source?.url, imageUrl]
        .map((value) => safeChatImageUrl(value))
        .find(Boolean);
    if (directUrl) {
        return directUrl;
    }

    const imageData = image.source?.data || image.data;
    if (!imageData) {
        return undefined;
    }
    const normalizedImageData = imageData.trim();
    if (normalizedImageData.startsWith("data:image/")) {
        return safeChatImageUrl(normalizedImageData);
    }
    const mimeType = image.source?.media_type || image.mimeType || "image/png";
    return `data:${mimeType};base64,${normalizedImageData}`;
}

/** Returns a safe inline image URL while preserving the original download URL. */
export function chatImageDisplayUrl(url: string, mimeType: string): string | undefined {
    const safeUrl = safeChatImageUrl(url);
    if (!safeUrl) {
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
    const localMediaPath = chatLocalMediaPathFromUrl(chatImageDownloadUrl(image) || "");
    return localMediaPath?.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
}

/** Represents one attachment in the provider-independent transport contract. */
export interface ChatTransportAttachment {
    type: string;
    mimeType: string;
    fileName: string;
    content: string;
}

/** Merges image blocks without repeating identical payloads. */
export function mergeChatImages(
    previous: ChatImageBlock[] = [],
    next: ChatImageBlock[] = []
): ChatImageBlock[] {
    const seenImages = new Set<string>();
    return [...previous, ...next].filter((image) => {
        const identity = JSON.stringify(image);
        if (seenImages.has(identity)) {
            return false;
        }
        seenImages.add(identity);
        return true;
    });
}

/** Merges attachment display rows without repeating IDs. */
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

/** Represents chat history message. */
export interface ChatHistoryMessage {
    role: string;
    content: unknown;
    text: string;
    images?: ChatImageBlock[];
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
    /** Stable identity for one transient runtime row inside a run. */
    runtimeKey?: string;
    /** Canonical Gateway event order used only while reconciling runtime rows. */
    runtimeSequence?: number;
}

/** Returns every image carried directly or by a nested tool result. */
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

/** Returns whether record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Extracts images. */
export function extractImages(content: unknown): ChatImageBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((item): item is ChatImageBlock => {
        if (!isRecord(item)) {
            return false;
        }

        return ["image", "image_url", "input_image"].includes(String(item.type));
    });
}

/** Extracts thinking blocks. */
export function extractThinkingBlocks(content: unknown): ChatThinkingDisplay[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const blocks: ChatThinkingDisplay[] = [];

    for (const item of content) {
        if (!isRecord(item) || item.type !== "thinking") {
            continue;
        }

        const text =
            typeof item.thinking === "string"
                ? item.thinking
                : typeof item.text === "string"
                  ? item.text
                  : "";

        if (text.trim()) {
            blocks.push({ text });
        }
    }

    return blocks;
}

/** Extracts tool calls. */
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

/** Performs attachment kind. */
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

/** Performs gateway attachments. */
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

/** Performs optimistic attachment display. */
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

/** Normalizes text. */
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

/** Returns whether a role represents a tool-result transcript row. */
function isToolRole(role: string): boolean {
    return TOOL_ROLE_VARIANTS.includes(role);
}

/** Returns whether renderable chat history message. */
export function isRenderableChatHistoryMessage(
    message: ChatHistoryMessage,
    visibility: ChatVisibilitySettings = DEFAULT_CHAT_VISIBILITY
): boolean {
    const role = message.role.toLowerCase();
    if (isToolRole(role)) {
        return Boolean(
            visibility.shouldShowTools &&
            ((message.toolResult?.content.trim() || "").length > 0 ||
                allChatMessageImages(message).length > 0 ||
                (message.attachments?.length || 0) > 0)
        );
    }

    if (
        message.text.trim() ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    ) {
        return true;
    }

    return Boolean(
        (visibility.shouldShowThinking && (message.thinking?.length || 0) > 0) ||
        (visibility.shouldShowTools && (message.toolCalls?.length || 0) > 0)
    );
}
