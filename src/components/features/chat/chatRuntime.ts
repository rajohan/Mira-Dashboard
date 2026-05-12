import {
    type ChatHistoryMessage,
    type ChatStreamEventMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    normalizeChatHistoryMessage,
    normalizeVisibleChatHistoryMessages,
    type RawChatHistoryMessage,
} from "./chatTypes";

/** Represents active chat stream. */
export interface ActiveChatStream {
    sessionKey: string;
    runId: string;
    aliases: string[];
    text: string;
    message?: ChatHistoryMessage;
    statusText?: string;
    updatedAt: string;
}

/** Defines active chat streams. */
export type ActiveChatStreams = Record<string, ActiveChatStream>;

/** Performs merge stream text. */
export function mergeStreamText(previous: string, next: string): string {
    if (!next.trim()) {
        return previous;
    }

    if (!previous) {
        return next;
    }

    if (next.startsWith(previous)) {
        return next;
    }

    if (previous.endsWith(next)) {
        return previous;
    }

    return `${previous}${next}`;
}

/** Performs unique strings. */
export function uniqueStrings(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter(Boolean))] as string[];
}

/** Represents parsed agent session key. */
interface ParsedAgentSessionKey {
    agentId: string;
    rest: string;
}

/** Parses agent session key. */
function parseAgentSessionKey(sessionKey: string): ParsedAgentSessionKey | null {
    const match = sessionKey.match(/^agent:([^:]+):(.+)$/i);
    if (!match) {
        return null;
    }

    return {
        agentId: match[1]?.toLowerCase() || "",
        rest: match[2]?.toLowerCase() || "",
    };
}

/** Returns whether same session key. */
export function isSameSessionKey(left?: string, right?: string): boolean {
    const normalizedLeft = left?.trim().toLowerCase();
    const normalizedRight = right?.trim().toLowerCase();

    if (!normalizedLeft || !normalizedRight) {
        return false;
    }

    if (normalizedLeft === normalizedRight) {
        return true;
    }

    const parsedLeft = parseAgentSessionKey(normalizedLeft);
    const parsedRight = parseAgentSessionKey(normalizedRight);

    if (parsedLeft && parsedRight) {
        return (
            parsedLeft.agentId === parsedRight.agentId &&
            parsedLeft.rest === parsedRight.rest
        );
    }

    if (parsedLeft) {
        return parsedLeft.rest === normalizedRight;
    }

    if (parsedRight) {
        return normalizedLeft === parsedRight.rest;
    }

    return false;
}

/** Normalizes assistant payload. */
export function normalizeAssistantPayload(value: unknown): ChatHistoryMessage {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as RawChatHistoryMessage;
        if ("content" in record || "text" in record || "role" in record) {
            return normalizeChatHistoryMessage({
                ...record,
                role: record.role || "assistant",
            });
        }
    }

    return normalizeChatHistoryMessage({
        role: "assistant",
        content: value,
    });
}

/** Performs final message from payload. */
export function finalMessageFromPayload(
    payload: ChatStreamEventMessage
): ChatHistoryMessage {
    return {
        ...normalizeAssistantPayload(payload.message ?? payload.content ?? payload.text),
        timestamp: new Date().toISOString(),
        runId: payload.runId,
    };
}

/** Performs merge stream message. */
export function mergeStreamMessage(
    previous: ChatHistoryMessage | undefined,
    next: ChatHistoryMessage,
    text: string,
    runId?: string
): ChatHistoryMessage {
    return {
        role: "assistant",
        content: next.content,
        text,
        images: next.images?.length ? next.images : previous?.images || [],
        attachments: next.attachments?.length
            ? next.attachments
            : previous?.attachments || [],
        thinking: next.thinking?.length ? next.thinking : previous?.thinking,
        toolCalls: next.toolCalls?.length ? next.toolCalls : previous?.toolCalls,
        timestamp: new Date().toISOString(),
        runId,
    };
}

/** Returns whether record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Performs payload is command message. */
export function payloadIsCommandMessage(value: unknown): boolean {
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { command?: unknown }).command === true
    );
}

/** Creates local system message. */
export function createLocalSystemMessage(text: string): ChatHistoryMessage {
    return {
        role: "system",
        content: text,
        text,
        images: [],
        attachments: [],
        timestamp: new Date().toISOString(),
        local: true,
    };
}

/** Performs text looks like recovered stream. */
function textLooksLikeRecoveredStream(historyText: string, streamText: string): boolean {
    const normalizedHistoryText = historyText.trim();
    const normalizedStreamText = streamText.trim();

    return Boolean(
        normalizedHistoryText &&
        normalizedStreamText &&
        (normalizedHistoryText === normalizedStreamText ||
            normalizedHistoryText.includes(normalizedStreamText) ||
            normalizedStreamText.includes(normalizedHistoryText))
    );
}

/** Performs history contains recovered stream. */
export function historyContainsRecoveredStream(
    messages: ChatHistoryMessage[],
    streamText: string
): boolean {
    return messages.some(
        (message) =>
            message.role.toLowerCase() === "assistant" &&
            textLooksLikeRecoveredStream(message.text, streamText)
    );
}

/** Performs visible history messages. */
export function visibleHistoryMessages(
    messages: RawChatHistoryMessage[] = [],
    visibility: ChatVisibilitySettings
) {
    return normalizeVisibleChatHistoryMessages(messages, visibility);
}

/** Creates chat visibility. */
export function createChatVisibility(
    showThinking: boolean,
    showTools: boolean
): ChatVisibilitySettings {
    return { showThinking, showTools };
}

/** Performs should show stream row. */
export function shouldShowStreamRow(
    selectedStreamText: string,
    selectedStreamMessage: ChatHistoryMessage | undefined,
    visibility: ChatVisibilitySettings
): boolean {
    return Boolean(
        selectedStreamText ||
        (selectedStreamMessage &&
            isRenderableChatHistoryMessage(selectedStreamMessage, visibility))
    );
}
