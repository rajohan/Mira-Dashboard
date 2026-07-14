import { currentIsoString } from "../../../utils/date";
import {
    chatAttachmentIdentity,
    type ChatHistoryMessage,
    type ChatStreamEventMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
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
    operation?: "compact";
    statusText?: string;
    updatedAt: string;
}

/** Defines active chat streams. */
export type ActiveChatStreams = Record<string, ActiveChatStream>;

/** Performs merge stream text. */
export function mergeStreamText(previousText: string, next: string): string {
    if (next.length === 0) {
        return previousText;
    }

    if (!previousText) {
        return next;
    }

    if (next.startsWith(previousText)) {
        return next;
    }

    if (previousText.endsWith(next)) {
        return previousText;
    }

    return `${previousText}${next}`;
}

/** Merges thinking blocks from stream events. */
function mergeThinkingBlocks(
    wasPrevious: ChatHistoryMessage | undefined,
    next: ChatHistoryMessage
): ChatHistoryMessage["thinking"] {
    if (!next.thinking?.length) {
        return wasPrevious?.thinking;
    }

    if (!wasPrevious?.thinking?.length) {
        return next.thinking;
    }

    const merged = [...wasPrevious.thinking];
    for (const [nextIndex, nextBlock] of next.thinking.entries()) {
        if (nextBlock.id) {
            const index = merged.findIndex((block) => block.id === nextBlock.id);
            if (index !== -1) {
                const previousBlock = merged[index]!;
                merged[index] = {
                    ...previousBlock,
                    ...nextBlock,
                    text: nextBlock.snapshot
                        ? nextBlock.text
                        : `${previousBlock.text}${nextBlock.text}`,
                };
                continue;
            }
        }

        const previousBlockAtIndex = merged[nextIndex];
        if (!nextBlock.id && previousBlockAtIndex && !previousBlockAtIndex.id) {
            merged[nextIndex] = {
                ...previousBlockAtIndex,
                ...nextBlock,
                text: nextBlock.snapshot
                    ? nextBlock.text
                    : `${previousBlockAtIndex.text}${nextBlock.text}`,
            };
            continue;
        }

        merged.push(nextBlock);
    }

    return merged;
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
export function parseAgentSessionKey(
    sessionKey: string
): ParsedAgentSessionKey | undefined {
    const match = sessionKey.match(/^agent:([^:]+):(.+)$/i);
    if (!match || !match[1] || !match[2]) {
        return undefined;
    }

    return {
        agentId: match[1]!.toLowerCase(),
        rest: match[2]!.toLowerCase(),
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
    if (typeof value === "string" && value.length > 0 && !value.trim()) {
        return {
            role: "assistant",
            content: value,
            text: value,
            images: [],
            attachments: [],
        };
    }

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
        timestamp: currentIsoString(),
        runId: payload.runId,
    };
}

/** Removes thinking metadata and thinking content blocks from a message. */
export function stripThinkingFromMessage(
    message: ChatHistoryMessage
): ChatHistoryMessage {
    if (!Array.isArray(message.content)) {
        return { ...message, thinking: undefined };
    }

    const content = Array.isArray(message.content)
        ? message.content.filter(
              (block) =>
                  !isRecord(block) ||
                  (block as Record<string, unknown>).type !== "thinking"
          )
        : message.content;
    const normalizedWithThinking = normalizeChatHistoryMessage({
        ...message,
        content: message.content,
    });
    const normalizedWithoutThinking = normalizeChatHistoryMessage({
        ...message,
        content,
    });
    const derivedAttachmentIdentities = new Set(
        (normalizedWithThinking.attachments || []).map((attachment) =>
            chatAttachmentIdentity(attachment)
        )
    );
    const explicitAttachments = (message.attachments || []).filter(
        (attachment) =>
            !derivedAttachmentIdentities.has(chatAttachmentIdentity(attachment))
    );
    const derivedImageIdentities = new Set(
        (normalizedWithThinking.images || []).map((image) => JSON.stringify(image))
    );
    const explicitImages = (message.images || []).filter(
        (image) => !derivedImageIdentities.has(JSON.stringify(image))
    );

    return {
        ...message,
        attachments: mergeChatAttachments(
            explicitAttachments,
            normalizedWithoutThinking.attachments
        ),
        content,
        images: mergeChatImages(explicitImages, normalizedWithoutThinking.images),
        text: normalizedWithoutThinking.text,
        thinking: undefined,
    };
}

/** Applies the user's terminal-thinking persistence preference. */
export function applyFinalThinkingPersistence(
    message: ChatHistoryMessage,
    shouldKeepThinkingAfterFinal: boolean
): ChatHistoryMessage {
    return shouldKeepThinkingAfterFinal ? message : stripThinkingFromMessage(message);
}

/** Performs merge stream message. */
export function mergeStreamMessage(
    wasPrevious: ChatHistoryMessage | undefined,
    next: ChatHistoryMessage,
    text: string,
    runId?: string
): ChatHistoryMessage {
    return {
        role: "assistant",
        content: next.content,
        text,
        images: mergeChatImages(wasPrevious?.images, next.images),
        attachments: mergeChatAttachments(wasPrevious?.attachments, next.attachments),
        thinking: mergeThinkingBlocks(wasPrevious, next),
        toolCalls: next.toolCalls?.length ? next.toolCalls : wasPrevious?.toolCalls,
        toolResult: next.toolResult || wasPrevious?.toolResult,
        timestamp: currentIsoString(),
        runId,
    };
}

/** Returns whether record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Performs payload is command message. */
export function isCommandMessagePayload(value: unknown): boolean {
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
        timestamp: currentIsoString(),
        local: true,
    };
}

/** Performs text looks like recovered stream. */
function isRecoveredStreamText(historyText: string, streamText: string): boolean {
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
export function hasRecoveredStreamHistory(
    messages: ChatHistoryMessage[],
    streamText: string
): boolean {
    return messages.some(
        (message) =>
            message.role.toLowerCase() === "assistant" &&
            isRecoveredStreamText(message.text, streamText)
    );
}

/** Performs visible history messages. */
export function visibleHistoryMessages(
    messages: RawChatHistoryMessage[] = [],
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal = true
) {
    const visibleMessages = normalizeVisibleChatHistoryMessages(messages, visibility);
    if (shouldKeepThinkingAfterFinal && visibility.shouldShowThinking) {
        return visibleMessages;
    }

    const nextMessages: ChatHistoryMessage[] = [];
    let responseSegment: Array<{
        message: ChatHistoryMessage;
        messageWithoutThinking: ChatHistoryMessage;
        isThinkingOnlyAssistant: boolean;
    }> = [];
    let hasPrimaryAssistantAnswer = false;

    const flushResponseSegment = () => {
        for (const entry of responseSegment) {
            nextMessages.push(
                entry.isThinkingOnlyAssistant && !hasPrimaryAssistantAnswer
                    ? entry.message
                    : entry.messageWithoutThinking
            );
        }
        responseSegment = [];
        hasPrimaryAssistantAnswer = false;
    };

    for (
        let messageIndex = visibleMessages.length - 1;
        messageIndex >= 0;
        messageIndex -= 1
    ) {
        const message = visibleMessages[messageIndex]!;
        const messageWithoutThinking = stripThinkingFromMessage(message);
        if (message.role.toLowerCase() === "user") {
            flushResponseSegment();
            nextMessages.push(messageWithoutThinking);
            continue;
        }

        const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
        const hasPrimaryAssistantContent = Boolean(
            messageWithoutThinking.text.trim() ||
            messageWithoutThinking.images?.length ||
            messageWithoutThinking.attachments?.length
        );
        const isDiagnosticToolMessage = Boolean(
            hasToolDetails && (message.diagnostic || !hasPrimaryAssistantContent)
        );
        if (
            message.role.toLowerCase() === "assistant" &&
            !isDiagnosticToolMessage &&
            isRenderableChatHistoryMessage(messageWithoutThinking, visibility)
        ) {
            hasPrimaryAssistantAnswer = true;
        }
        responseSegment.push({
            message,
            messageWithoutThinking,
            isThinkingOnlyAssistant: Boolean(
                visibility.shouldShowThinking &&
                message.role.toLowerCase() === "assistant" &&
                message.thinking?.length &&
                !isRenderableChatHistoryMessage(messageWithoutThinking, visibility)
            ),
        });
    }
    flushResponseSegment();

    return nextMessages
        .toReversed()
        .filter((message) => isRenderableChatHistoryMessage(message, visibility));
}

/** Creates chat visibility. */
export function createChatVisibility(
    shouldShowThinking: boolean,
    shouldShowTools: boolean
): ChatVisibilitySettings {
    return { shouldShowThinking, shouldShowTools };
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
