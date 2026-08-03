import type {
    CanonicalChatEvent,
    CanonicalChatProviderMetadata,
} from "../../../../../contracts/chat/canonical";
import { extractCanonicalChatImages } from "../../../../../contracts/chat/canonicalImages";
import type { ChatTransportAttachment } from "../../../../../contracts/chat/transport";
import { normalizeChatMimeType } from "./media/identity";
import { mergeChatImages } from "./media/merge";
import type {
    ChatAttachmentDisplay,
    ChatImageBlock,
    ChatSendAttachment,
} from "./media/types";

export {
    chatAttachmentIdentity,
    chatContentFingerprint,
    normalizeChatMimeType,
} from "./media/identity";
export {
    chatAttachmentPreviewUrl,
    chatImageDisplayUrl,
    chatImageDownloadUrl,
    chatImageMimeType,
    chatImageUrl,
    chatLocalMediaPathFromUrl,
} from "./media/imageUrls";
export { mergeChatAttachments, mergeChatImages } from "./media/merge";
export type {
    ChatAttachmentDisplay,
    ChatAttachmentError,
    ChatAttachmentInputSource,
    ChatImageBlock,
    ChatPreviewItem,
    ChatSendAttachment,
} from "./media/types";

/** Defines normalized role variants that represent tool result rows. */
export const TOOL_ROLE_VARIANTS: readonly string[] = [
    "tool",
    "tool_result",
    "toolresult",
];

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
 * Keeps one primary source while retaining every folded source.
 * @param primary Primary source provenance.
 * @param folded Source provenance folded into the primary row.
 * @returns Merged provenance when either source is available.
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
 * @param message Chat message to inspect.
 * @returns Deduplicated images carried by the message.
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
    /** Runtime reconciliation aliases for this visible row. */
    identityKeys?: string[];
    key: string;
    kind: "message" | "status" | "stream" | "typing";
    message: ChatHistoryMessage;
}

/** Defines default chat visibility. */
export const DEFAULT_CHAT_VISIBILITY: ChatVisibilitySettings = {
    shouldShowThinking: false,
    shouldShowTools: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Extracts canonical images from provider content.
 * @param content Provider content to inspect.
 * @returns Extracted image blocks.
 */
export function extractImages(content: unknown): ChatImageBlock[] {
    return extractCanonicalChatImages(content);
}

/**
 * Extracts thinking blocks from provider content.
 * @param content Provider content to inspect.
 * @returns Extracted thinking blocks.
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
 * Extracts tool calls from provider content.
 * @param content Provider content to inspect.
 * @returns Extracted tool calls.
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
 * Returns the display kind for a MIME type.
 * @param mimeType MIME type to classify.
 * @returns Attachment display kind.
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
 * Converts composer attachments to Gateway transport attachments.
 * @param attachments Composer attachments to convert.
 * @returns Gateway transport attachments.
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
 * Creates optimistic attachment rows from composer attachments.
 * @param attachments Composer attachments to convert.
 * @returns Optimistic attachment rows.
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
 * Normalizes text from supported chat content blocks.
 * @param content Provider content to normalize.
 * @returns Normalized display text.
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

function isToolRole(role: string): boolean {
    return TOOL_ROLE_VARIANTS.includes(role);
}

/**
 * Returns whether a history message should be rendered.
 * @param message History message to evaluate.
 * @param visibility Current chat visibility settings.
 * @returns Whether the message has visible content.
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
