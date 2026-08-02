import { timestampFromDateString } from "../../../utils/date";
import {
    diagnosticMessageIdentity,
    hasChatMessageDetails,
    isRecoveredAssistantText,
    mergeChatMessageDetails,
    mergeToolCallsWithResults,
    messageDeleteKey,
    messageIdentity,
    messageMediaIdentity,
    toolCallRowIdentity,
} from "./chatMessageIdentity";
import type { ChatHistoryMessage } from "./chatTypes";

/** Defines chat history limit. */
export const CHAT_HISTORY_LIMIT = 1000;
/** Defines optimistic message retention milliseconds. */
export const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;

/**
 * Removes a failed optimistic row and restores same-identity rows it replaced.
 * @param messages Messages value.
 * @param failedMessage Failed message value.
 * @param replacedMessages Replaced messages value.
 * @returns Rollback failed optimistic message result.
 */
export function rollbackFailedOptimisticMessage(
    messages: ChatHistoryMessage[],
    failedMessage: ChatHistoryMessage,
    replacedMessages: Array<{ index: number; message: ChatHistoryMessage }>
): ChatHistoryMessage[] {
    const restored = messages.filter((message) => message !== failedMessage);
    for (const replaced of replacedMessages) {
        if (!restored.includes(replaced.message)) {
            restored.splice(
                Math.min(replaced.index, restored.length),
                0,
                replaced.message
            );
        }
    }
    return restored;
}
/**
 * Carries local diagnostic details onto matching history text rows.
 * @param previousMessages Previous messages value.
 * @param nextMessages Next messages value.
 * @returns Merge diagnostic details result.
 */
function mergeDiagnosticDetails(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const previousResponseStart =
        previousMessages.findLastIndex(
            (message) => message.role.toLowerCase() === "user"
        ) + 1;
    const nextResponseStart =
        nextMessages.findLastIndex((message) => message.role.toLowerCase() === "user") +
        1;
    const unmatchedPrevious = previousMessages
        .slice(previousResponseStart)
        .filter(
            (candidate) =>
                candidate.local === true &&
                candidate.role.toLowerCase() === "assistant" &&
                candidate.text.trim() &&
                hasChatMessageDetails(candidate)
        );

    return nextMessages.map((message, messageIndex) => {
        if (
            messageIndex < nextResponseStart ||
            message.role.toLowerCase() !== "assistant" ||
            !message.text.trim()
        ) {
            return message;
        }

        const previousIndex = unmatchedPrevious.findIndex(
            (candidate) =>
                candidate.text.trim() === message.text.trim() &&
                (!candidate.runId || !message.runId || candidate.runId === message.runId)
        );

        if (previousIndex === -1) {
            return message;
        }

        const previous = unmatchedPrevious[previousIndex];
        unmatchedPrevious.splice(previousIndex, 1);

        if (!previous) {
            return message;
        }

        return mergeChatMessageDetails(message, previous);
    });
}
/**
 * Performs dedupe messages.
 * @param messages Messages value.
 * @returns Dedupe messages result.
 */
export function dedupeMessages(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const seen = new Map<
        string,
        Array<{ isLocal: boolean; runId: string | undefined }>
    >();
    const seenExactUserEvents = new Set<string>();
    const deduped: ChatHistoryMessage[] = [];
    let hasCrossedResponseMessages = false;
    let nextUserIdentity: string | undefined;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }

        const identity = messageIdentity(message);
        const role = message.role.toLowerCase();
        const exactUserEvent =
            role === "user" && message.runId && message.timestamp
                ? messageDeleteKey({ ...message, runtimeKey: undefined })
                : undefined;
        if (exactUserEvent && seenExactUserEvents.has(exactUserEvent)) {
            continue;
        }
        if (exactUserEvent) {
            seenExactUserEvents.add(exactUserEvent);
        }
        if (role === "user") {
            if (
                hasCrossedResponseMessages ||
                (nextUserIdentity !== undefined && nextUserIdentity !== identity)
            ) {
                seen.clear();
            }
            hasCrossedResponseMessages = false;
            nextUserIdentity = identity;
        } else {
            hasCrossedResponseMessages = true;
            nextUserIdentity = undefined;
        }
        const seenMessages = seen.get(identity) || [];
        const isCompatibleRun = (runId: string | undefined) =>
            !runId || !message.runId || runId === message.runId;
        const isUnscopedTextlessConversationalMedia = Boolean(
            (role === "user" || role === "assistant") &&
            !message.text.trim() &&
            messageMediaIdentity(message) &&
            !message.runId &&
            !message.timestamp
        );
        const canDeduplicate = Boolean(
            !isUnscopedTextlessConversationalMedia &&
            (message.text.trim() || diagnosticMessageIdentity(message))
        );
        const isMessageLocal = message.local === true;
        if (canDeduplicate && role === "user") {
            const oppositeLocalityIndex = seenMessages.findIndex(
                (candidate) =>
                    isCompatibleRun(candidate.runId) &&
                    candidate.isLocal === !isMessageLocal
            );
            if (oppositeLocalityIndex !== -1) {
                seenMessages.splice(oppositeLocalityIndex, 1);
                seen.set(identity, seenMessages);
                continue;
            }
        } else if (
            canDeduplicate &&
            seenMessages.some((candidate) => isCompatibleRun(candidate.runId))
        ) {
            continue;
        }

        seen.set(identity, [
            ...seenMessages,
            { isLocal: isMessageLocal, runId: message.runId },
        ]);
        deduped.unshift(message);
    }

    return deduped;
}

/**
 * Performs message timestamp milliseconds.
 * @returns Message timestamp milliseconds result.
 */
function messageTimestampMs(message: ChatHistoryMessage): number | undefined {
    return message.timestamp ? timestampFromDateString(message.timestamp) : undefined;
}

/**
 * Performs insert messages by timestamp.
 * @param baseMessages Base messages value.
 * @param messagesToInsert Messages to insert value.
 * @returns Insert messages by timestamp result.
 */
export function insertMessagesByTimestamp(
    baseMessages: ChatHistoryMessage[],
    messagesToInsert: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const merged = [...baseMessages];
    const orderedInsertions = [...messagesToInsert].toSorted((left, right) => {
        const leftTimestamp = messageTimestampMs(left);
        const rightTimestamp = messageTimestampMs(right);

        if (leftTimestamp === undefined && rightTimestamp === undefined) {
            return 0;
        }

        if (leftTimestamp === undefined) {
            return 1;
        }

        if (rightTimestamp === undefined) {
            return -1;
        }

        return leftTimestamp - rightTimestamp;
    });

    for (const message of orderedInsertions) {
        const timestamp = messageTimestampMs(message);

        if (timestamp === undefined) {
            merged.push(message);
            continue;
        }

        const insertionIndex = merged.findIndex((candidate) => {
            const candidateTimestamp = messageTimestampMs(candidate);
            return candidateTimestamp !== undefined && candidateTimestamp > timestamp;
        });

        if (insertionIndex === -1) {
            merged.push(message);
        } else {
            merged.splice(insertionIndex, 0, message);
        }
    }

    return merged;
}

/**
 * Copies live tool results onto matching history tool calls.
 * @param previousMessages Previous messages value.
 * @param nextMessages Next messages value.
 * @returns Merge tool call results result.
 */
function mergeToolCallResults(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const previousByIdentity = new Map<string, ChatHistoryMessage>();
    const previousByMessageIdentity = new Map<string, ChatHistoryMessage[]>();
    for (const message of previousMessages) {
        const identity = toolCallRowIdentity(message);
        if (identity) {
            previousByIdentity.set(identity, message);
        }
        const canUseMessageIdentityFallback =
            !message.text.trim() || message.toolCalls?.every((toolCall) => toolCall.id);
        if (
            canUseMessageIdentityFallback &&
            message.toolCalls?.some((toolCall) => toolCall.toolResult)
        ) {
            const identity = messageIdentity(message);
            previousByMessageIdentity.set(identity, [
                ...(previousByMessageIdentity.get(identity) || []),
                message,
            ]);
        }
    }

    return nextMessages.map((message) => {
        const identity = toolCallRowIdentity(message);
        if (!identity || !message.toolCalls?.length) {
            return message;
        }

        let previous = previousByIdentity.get(identity);
        if (!previous) {
            const identityFallback = messageIdentity(message);
            const candidates = previousByMessageIdentity.get(identityFallback) || [];
            previous = candidates.shift();
            if (candidates.length === 0) {
                previousByMessageIdentity.delete(identityFallback);
            }
        }
        if (!previous?.toolCalls?.length) {
            return message;
        }

        const toolCalls = mergeToolCallsWithResults(
            message.toolCalls,
            previous.toolCalls
        );

        return {
            ...message,
            timestamp: message.timestamp || previous.timestamp,
            toolCalls,
        };
    });
}

/**
 * Performs merge with recent optimistic messages.
 * @param previousMessages Previous messages value.
 * @param nextMessages Next messages value.
 * @returns Merge with recent optimistic messages result.
 */
export function mergeWithRecentOptimisticMessages(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    if (previousMessages.length === 0) {
        return dedupeMessages(nextMessages);
    }

    if (nextMessages.length === 0) {
        return previousMessages;
    }

    const enrichedNextMessages = mergeDiagnosticDetails(
        previousMessages,
        mergeToolCallResults(previousMessages, nextMessages)
    );
    const nextIdentityCounts = new Map<string, number>();
    const unmatchedNextMediaCounts = new Map<string, number>();
    const unmatchedNextDashboardUserMediaRunCounts = new Map<string, number>();
    const recoveredPreviousMessages = new Set<ChatHistoryMessage>();
    for (const message of enrichedNextMessages) {
        const identity = messageIdentity(message);
        nextIdentityCounts.set(identity, (nextIdentityCounts.get(identity) || 0) + 1);

        const mediaIdentity = messageMediaIdentity(message);
        const role = message.role.toLowerCase();
        if (mediaIdentity && (role === "user" || role === "assistant")) {
            const mediaKey = `${role}::${mediaIdentity}`;
            unmatchedNextMediaCounts.set(
                mediaKey,
                (unmatchedNextMediaCounts.get(mediaKey) || 0) + 1
            );
            if (
                role === "user" &&
                !message.text.trim() &&
                message.runId?.startsWith("dashboard-chat-")
            ) {
                unmatchedNextDashboardUserMediaRunCounts.set(
                    message.runId,
                    (unmatchedNextDashboardUserMediaRunCounts.get(message.runId) || 0) + 1
                );
            }
        }
    }
    for (const message of previousMessages) {
        if (message.local === true) {
            continue;
        }

        const identity = messageIdentity(message);
        const identityCount = nextIdentityCounts.get(identity) || 0;
        if (identityCount > 0) {
            nextIdentityCounts.set(identity, identityCount - 1);
            recoveredPreviousMessages.add(message);
        }
        const mediaIdentity = messageMediaIdentity(message);
        const role = message.role.toLowerCase();
        if (
            !mediaIdentity ||
            (role !== "user" && role !== "assistant") ||
            message.text.trim()
        ) {
            continue;
        }

        const mediaKey = `${role}::${mediaIdentity}`;
        const mediaCount = unmatchedNextMediaCounts.get(mediaKey) || 0;
        unmatchedNextMediaCounts.set(mediaKey, Math.max(0, mediaCount - 1));
        if (
            role === "user" &&
            mediaCount > 0 &&
            message.runId?.startsWith("dashboard-chat-")
        ) {
            const mediaRunCount =
                unmatchedNextDashboardUserMediaRunCounts.get(message.runId) || 0;
            unmatchedNextDashboardUserMediaRunCounts.set(
                message.runId,
                Math.max(0, mediaRunCount - 1)
            );
        }
    }
    const nextToolCallRowsByIdentity = new Map<string, ChatHistoryMessage>();
    for (const message of enrichedNextMessages) {
        const identity = toolCallRowIdentity(message);
        if (identity) {
            nextToolCallRowsByIdentity.set(identity, message);
        }
    }
    const nextResponseStart =
        nextMessages.findLastIndex((message) => message.role.toLowerCase() === "user") +
        1;
    const nextAssistantTexts = nextMessages
        .slice(nextResponseStart)
        .filter((message) => message.role.toLowerCase() === "assistant")
        .map((message) => message.text);
    const now = Date.now();
    const recentMissingMessages = previousMessages.filter((message) => {
        const role = message.role.toLowerCase();
        const isOptimisticRole = role === "user" || role === "assistant";
        const isLocalMessage = message.local === true;
        const isSystemMessage = role === "system";
        const isLocalUiMessage = isLocalMessage || isSystemMessage;
        const isLocalDiagnosticMessage =
            message.local === true && hasChatMessageDetails(message);

        if (!isOptimisticRole && !isLocalUiMessage && !isLocalDiagnosticMessage) {
            return false;
        }

        if (!isSystemMessage && !isLocalDiagnosticMessage && !message.text.trim()) {
            return false;
        }

        if (recoveredPreviousMessages.has(message)) {
            return false;
        }

        const identity = messageIdentity(message);
        const matchingNextCount = nextIdentityCounts.get(identity) || 0;
        if (matchingNextCount > 0) {
            nextIdentityCounts.set(identity, matchingNextCount - 1);
            return false;
        }

        const mediaIdentity = messageMediaIdentity(message);
        const mediaKey = `${role}::${mediaIdentity || ""}`;
        const unmatchedMediaCount = mediaIdentity
            ? unmatchedNextMediaCounts.get(mediaKey) || 0
            : 0;
        const dashboardUserMediaRunId =
            role === "user" && message.runId?.startsWith("dashboard-chat-")
                ? message.runId
                : undefined;
        const unmatchedMediaRunCount = dashboardUserMediaRunId
            ? unmatchedNextDashboardUserMediaRunCounts.get(dashboardUserMediaRunId) || 0
            : 0;
        if (
            isLocalMessage &&
            mediaIdentity &&
            (role === "user" || role === "assistant") &&
            !message.text.trim() &&
            (unmatchedMediaCount > 0 || unmatchedMediaRunCount > 0)
        ) {
            if (unmatchedMediaCount > 0) {
                unmatchedNextMediaCounts.set(mediaKey, unmatchedMediaCount - 1);
            }
            if (dashboardUserMediaRunId && unmatchedMediaRunCount > 0) {
                unmatchedNextDashboardUserMediaRunCounts.set(
                    dashboardUserMediaRunId,
                    unmatchedMediaRunCount - 1
                );
            }
            return false;
        }

        const toolCallIdentity = toolCallRowIdentity(message);
        const nextToolCallRow = toolCallIdentity
            ? nextToolCallRowsByIdentity.get(toolCallIdentity)
            : undefined;
        if (nextToolCallRow) {
            const localText = message.text.trim();
            if (
                !localText ||
                isRecoveredAssistantText(message.text, nextToolCallRow.text)
            ) {
                return false;
            }
        }

        if (
            role === "assistant" &&
            nextAssistantTexts.some((nextText) =>
                isRecoveredAssistantText(message.text, nextText)
            )
        ) {
            return false;
        }

        if (isLocalUiMessage) {
            return true;
        }

        const timestamp = message.timestamp
            ? timestampFromDateString(message.timestamp)
            : undefined;
        return (
            timestamp !== undefined && now - timestamp < OPTIMISTIC_MESSAGE_RETENTION_MS
        );
    });

    return dedupeMessages(
        insertMessagesByTimestamp(enrichedNextMessages, recentMissingMessages)
    );
}
