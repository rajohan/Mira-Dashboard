/** Defines normalized role variants that represent tool result rows. */
export const TOOL_ROLE_VARIANTS: readonly string[] = [
    "tool",
    "tool_result",
    "toolresult",
];

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
    const content = attachment.contentBase64 || attachment.dataUrl || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? chatContentFingerprint(content) : attachment.id,
    ].join("::");
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
