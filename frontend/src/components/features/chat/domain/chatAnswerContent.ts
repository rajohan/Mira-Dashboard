import type { ChatHistoryMessage } from "../chatTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isAnswerCapableRole(role: string): boolean {
    const normalizedRole = role.toLowerCase();
    return normalizedRole === "assistant" || normalizedRole === "system";
}

// Removes thinking content without disturbing explicit media on the message.
export function stripThinkingFromMessage(
    message: ChatHistoryMessage
): ChatHistoryMessage {
    if (!Array.isArray(message.content)) {
        return { ...message, thinking: undefined };
    }

    const content = message.content.filter(
        (block) => !isRecord(block) || block.type !== "thinking"
    );
    return { ...message, content, thinking: undefined };
}

export interface ChatAnswerDetails {
    hasPrimaryContent: boolean;
    hasToolOutput: boolean;
    isPrimaryAnswerContent: boolean;
    withoutThinking: ChatHistoryMessage;
}

export function chatAnswerDetails(message: ChatHistoryMessage): ChatAnswerDetails {
    const withoutThinking = stripThinkingFromMessage(message);
    const hasToolOutput = Boolean(message.toolCalls?.length || message.toolResult);
    const hasVisibleAttachments = Boolean(
        withoutThinking.attachments?.length &&
        !withoutThinking.hasOnlyHiddenToolAttachments &&
        (!hasToolOutput || message.isFinal === true)
    );
    const hasPrimaryContent = Boolean(
        hasVisibleAttachments ||
        (!message.isToolUse && withoutThinking.text.trim()) ||
        withoutThinking.images?.length
    );
    return {
        hasPrimaryContent,
        hasToolOutput,
        isPrimaryAnswerContent:
            message.intent !== "commentary" &&
            message.intent !== "control" &&
            !message.isToolUse &&
            hasPrimaryContent &&
            (!hasToolOutput || message.isFinal === true),
        withoutThinking,
    };
}

// Identifies answer content independently from role and visibility settings.
export function hasPrimaryAnswerContent(message: ChatHistoryMessage): boolean {
    return chatAnswerDetails(message).isPrimaryAnswerContent;
}

export function isThinkingOnlyMessage(message: ChatHistoryMessage): boolean {
    return Boolean(message.thinking?.length && !hasPrimaryAnswerContent(message));
}
