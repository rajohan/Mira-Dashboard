/** Represents chat image block. */
export interface ChatImageBlock {
    type: "image";
    mimeType?: string;
    data?: string;
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
    };
}

/** Represents chat attachment display. */
export interface ChatAttachmentDisplay {
    id: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    dataUrl?: string;
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

/** Represents chat gateway attachment. */
export interface ChatGatewayAttachment {
    type: string;
    mimeType: string;
    fileName: string;
    content: string;
}

/** Represents chat thinking display. */
export interface ChatThinkingDisplay {
    text: string;
}

/** Represents chat tool call display. */
export interface ChatToolCallDisplay {
    id?: string;
    name: string;
    arguments?: unknown;
}

/** Represents chat tool result display. */
export interface ChatToolResultDisplay {
    id?: string;
    name?: string;
    content: string;
    isError?: boolean;
    images?: ChatImageBlock[];
}

/** Represents chat visibility settings. */
export interface ChatVisibilitySettings {
    showThinking: boolean;
    showTools: boolean;
}

/** Represents chat history message. */
export interface ChatHistoryMessage {
    role: string;
    content: unknown;
    text: string;
    images?: ChatImageBlock[];
    attachments?: ChatAttachmentDisplay[];
    thinking?: ChatThinkingDisplay[];
    toolCalls?: ChatToolCallDisplay[];
    toolResult?: ChatToolResultDisplay;
    timestamp?: string;
    local?: boolean;
    runId?: string;
}

/** Represents raw chat history message. */
export interface RawChatHistoryMessage {
    role?: string;
    content?: unknown;
    text?: string;
    timestamp?: string | number;
    command?: boolean;
    toolCallId?: string;
    tool_call_id?: string;
    toolName?: string;
    tool_name?: string;
    isError?: boolean;
    MediaPath?: string;
    MediaPaths?: string[];
    MediaType?: string;
    MediaTypes?: string[];
}

/** Represents chat stream event message. */
export interface ChatStreamEventMessage {
    sessionKey?: string;
    runId?: string;
    state?: string;
    errorMessage?: string;
    message?: unknown;
    content?: unknown;
    text?: string;
    delta?: unknown;
    deltaText?: string;
    replace?: boolean;
    seq?: number;
}

/** Represents one chat row. */
export interface ChatRow {
    key: string;
    kind: "message" | "stream" | "typing";
    message: ChatHistoryMessage;
}

/** Defines default chat visibility. */
export const DEFAULT_CHAT_VISIBILITY: ChatVisibilitySettings = {
    showThinking: false,
    showTools: false,
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

        return item.type === "image";
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
    if (mimeType.startsWith("image/")) {
        return "image";
    }

    if (mimeType.startsWith("text/") || mimeType === "application/json") {
        return "text";
    }

    return "file";
}

/** Performs gateway attachments. */
export function gatewayAttachments(
    attachments: ChatSendAttachment[]
): ChatGatewayAttachment[] {
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

/** Performs file name from path. */
function fileNameFromPath(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

/** Performs mime type from path. */
function mimeTypeFromPath(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        txt: "text/plain",
        json: "application/json",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        mp4: "video/mp4",
        webm: "video/webm",
    };

    return extension
        ? mimeTypes[extension] || "application/octet-stream"
        : "application/octet-stream";
}

/** Performs media URL from path. */
function mediaUrlFromPath(path: string): string {
    return `/api/media?path=${encodeURIComponent(path)}`;
}

/** Extracts media directive attachments. */
function extractMediaDirectiveAttachments(text: string): ChatAttachmentDisplay[] {
    const attachments: ChatAttachmentDisplay[] = [];
    const mediaPattern = /^MEDIA:(.+)$/gm;

    for (const match of text.matchAll(mediaPattern)) {
        const mediaPath = match[1]?.trim();
        if (!mediaPath) {
            continue;
        }

        const mimeType = mimeTypeFromPath(mediaPath);
        const kind = attachmentKind(mimeType);

        attachments.push({
            id: `media-${mediaPath}-${attachments.length}`,
            fileName: fileNameFromPath(mediaPath),
            mimeType,
            dataUrl: kind === "image" ? mediaUrlFromPath(mediaPath) : undefined,
            kind,
        });
    }

    return attachments;
}

/** Performs text to base64. */
function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return window.btoa(binary);
}

/** Extracts inline file attachments. */
function extractInlineFileAttachments(text: string): ChatAttachmentDisplay[] {
    const filePattern = /<file\s+name="([^"]+)"\s+mime="([^"]+)">([\s\S]*?)<\/file>/g;
    const attachments: ChatAttachmentDisplay[] = [];

    for (const match of text.matchAll(filePattern)) {
        const [
            ,
            fileName = "attachment",
            mimeType = "application/octet-stream",
            body = "",
        ] = match;
        const externalContentMatch = body.match(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?\n---\n([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/
        );
        const content = (externalContentMatch?.[1] ?? body).trim();
        const contentBytes = new TextEncoder().encode(content);
        const contentBase64 = textToBase64(content);
        const kind = attachmentKind(mimeType);

        attachments.push({
            id: `inline-${fileName}-${attachments.length}`,
            fileName,
            mimeType,
            sizeBytes: contentBytes.byteLength,
            contentBase64,
            dataUrl:
                kind === "image" ? `data:${mimeType};base64,${contentBase64}` : undefined,
            kind,
        });
    }

    return attachments;
}

/** Performs strip inline file markup. */
function stripInlineFileMarkup(text: string): string {
    return text
        .replaceAll(/^MEDIA:.+$/gm, "")
        .replaceAll(/^\[media attached: .*?\]\n?/gm, "")
        .replaceAll(/<file\s+name="[^"]+"\s+mime="[^"]+">[\s\S]*?<\/file>/g, "")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();
}

/** Extracts media reference attachments. */
function extractMediaReferenceAttachments(
    message: RawChatHistoryMessage
): ChatAttachmentDisplay[] {
    const paths = Array.isArray(message.MediaPaths)
        ? message.MediaPaths
        : message.MediaPath
          ? [message.MediaPath]
          : [];
    const types = Array.isArray(message.MediaTypes)
        ? message.MediaTypes
        : message.MediaType
          ? [message.MediaType]
          : [];

    return paths.map((path, index) => {
        const mimeType = types[index] || mimeTypeFromPath(path);

        const kind = attachmentKind(mimeType);

        return {
            id: `${path}-${index}`,
            fileName: fileNameFromPath(path),
            mimeType,
            dataUrl: kind === "image" ? mediaUrlFromPath(path) : undefined,
            kind,
        };
    });
}

/** Returns whether tool role. */
function isToolRole(role: string): boolean {
    const normalizedRole = role.toLowerCase();
    return (
        normalizedRole === "tool" ||
        normalizedRole === "toolresult" ||
        normalizedRole === "tool_result"
    );
}

const INTERNAL_DELIVERY_TOOL_NAMES = new Set([
    "message",
    "messages",
    "reply",
    "send",
    "reaction",
    "react",
    "typing",
]);

/** Returns whether a tool name is an internal delivery helper. */
export function isInternalDeliveryToolName(value?: string): boolean {
    if (!value) {
        return false;
    }

    const normalized = value
        .replace(/^functions\./, "")
        .replaceAll("_", "-")
        .trim()
        .toLowerCase();
    return INTERNAL_DELIVERY_TOOL_NAMES.has(normalized);
}

/** Parses a record from direct or JSON-encoded content. */
function contentRecord(content: unknown): Record<string, unknown> | null {
    if (isRecord(content)) {
        return content;
    }

    if (typeof content !== "string" || !content.trim().startsWith("{")) {
        return null;
    }

    try {
        const parsed = JSON.parse(content) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Extracts the visible source reply text from a delivery tool result. */
function deliverySourceReplyText(content: unknown): string | undefined {
    const record = contentRecord(content);
    if (!record) {
        return undefined;
    }

    const sourceReply = isRecord(record.sourceReply) ? record.sourceReply : null;
    const text =
        (typeof sourceReply?.text === "string" && sourceReply.text.trim()) ||
        (typeof record.message === "string" && record.message.trim());

    return text || undefined;
}

/** Extracts tool result. */
function extractToolResult(
    message: RawChatHistoryMessage,
    content: unknown
): ChatToolResultDisplay | undefined {
    const role = message.role || "";
    if (!isToolRole(role)) {
        return undefined;
    }

    return {
        id:
            typeof message.toolCallId === "string"
                ? message.toolCallId
                : typeof message.tool_call_id === "string"
                  ? message.tool_call_id
                  : undefined,
        name:
            typeof message.toolName === "string"
                ? message.toolName
                : typeof message.tool_name === "string"
                  ? message.tool_name
                  : undefined,
        content: normalizeText(content),
        isError: message.isError,
        images: extractImages(content),
    };
}

/** Performs strip generated media only text. */
function stripGeneratedMediaOnlyText(
    text: string,
    images: ChatImageBlock[],
    attachments: ChatAttachmentDisplay[]
): string {
    const trimmed = text.trim();
    const hasRenderableMedia = images.length > 0 || attachments.length > 0;

    if (!hasRenderableMedia) {
        return text;
    }

    if (trimmed === "[image]") {
        return "";
    }

    return text
        .split("\n")
        .filter((line) => line.trim() !== "[image]")
        .join("\n")
        .trimEnd();
}

/** Normalizes chat history message. */
export function normalizeChatHistoryMessage(
    message: RawChatHistoryMessage
): ChatHistoryMessage {
    const content = message.content ?? message.text ?? "";
    const images = extractImages(content);
    const thinking = extractThinkingBlocks(content);
    const toolCalls = extractToolCalls(content);
    const toolResult = extractToolResult(message, content);
    const normalizedText = normalizeText(content);
    const attachments = [
        ...extractMediaReferenceAttachments(message),
        ...extractMediaDirectiveAttachments(normalizedText),
        ...extractInlineFileAttachments(normalizedText),
    ];
    const text = stripGeneratedMediaOnlyText(
        stripInlineFileMarkup(normalizedText),
        images,
        attachments
    );

    return {
        role: message.role || "unknown",
        content,
        text,
        images,
        attachments,
        thinking,
        toolCalls,
        toolResult,
        timestamp:
            typeof message.timestamp === "number"
                ? new Date(message.timestamp).toISOString()
                : message.timestamp,
    };
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

                if (block.type === "image") {
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

/** Returns whether renderable chat history message. */
export function isRenderableChatHistoryMessage(
    message: ChatHistoryMessage,
    visibility: ChatVisibilitySettings = DEFAULT_CHAT_VISIBILITY
): boolean {
    const role = message.role.toLowerCase();
    if (isToolRole(role)) {
        return Boolean(
            visibility.showTools &&
            ((message.toolResult?.content.trim() || "").length > 0 ||
                (message.toolResult?.images?.length || 0) > 0)
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
        (visibility.showThinking && (message.thinking?.length || 0) > 0) ||
        (visibility.showTools && (message.toolCalls?.length || 0) > 0)
    );
}

/** Normalizes visible chat history messages. */
export function normalizeVisibleChatHistoryMessages(
    messages: RawChatHistoryMessage[],
    visibility: ChatVisibilitySettings = DEFAULT_CHAT_VISIBILITY
): ChatHistoryMessage[] {
    const visibleMessages: ChatHistoryMessage[] = [];
    let pendingHiddenToolMedia: ChatAttachmentDisplay[] = [];

    for (const normalizedMessage of messages.map(normalizeChatHistoryMessage)) {
        const internalDeliveryToolResult =
            isToolRole(normalizedMessage.role) &&
            isInternalDeliveryToolName(normalizedMessage.toolResult?.name);
        if (internalDeliveryToolResult) {
            const sourceReplyText = deliverySourceReplyText(normalizedMessage.content);
            if (sourceReplyText) {
                visibleMessages.push({
                    role: "assistant",
                    content: sourceReplyText,
                    text: sourceReplyText,
                    images: [],
                    attachments: [],
                    timestamp: normalizedMessage.timestamp,
                });
            }
            continue;
        }

        const filteredToolCalls = normalizedMessage.toolCalls?.filter(
            (toolCall) => !isInternalDeliveryToolName(toolCall.name)
        );
        const message =
            filteredToolCalls &&
            filteredToolCalls.length !== normalizedMessage.toolCalls?.length
                ? { ...normalizedMessage, toolCalls: filteredToolCalls }
                : normalizedMessage;
        const isToolMessage = isToolRole(message.role);
        const hiddenToolMedia =
            isToolMessage &&
            !visibility.showTools &&
            (message.attachments || []).length > 0;

        if (hiddenToolMedia) {
            pendingHiddenToolMedia = [
                ...pendingHiddenToolMedia,
                ...(message.attachments || []),
            ];
            continue;
        }

        if (!isRenderableChatHistoryMessage(message, visibility)) {
            continue;
        }

        if (
            pendingHiddenToolMedia.length > 0 &&
            message.role.toLowerCase() === "assistant"
        ) {
            visibleMessages.push({
                ...message,
                attachments: [...(message.attachments || []), ...pendingHiddenToolMedia],
            });
            pendingHiddenToolMedia = [];
            continue;
        }

        visibleMessages.push(message);
    }

    if (pendingHiddenToolMedia.length > 0) {
        visibleMessages.push({
            role: "assistant",
            content: "",
            text: "",
            attachments: pendingHiddenToolMedia,
        });
    }

    return visibleMessages;
}
