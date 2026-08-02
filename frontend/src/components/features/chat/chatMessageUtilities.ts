import { timestampFromDateString } from "../../../utils/date";
import {
    chatAttachmentIdentity,
    chatContentFingerprint,
    chatImageDownloadUrl,
    type ChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
    TOOL_ROLE_VARIANTS,
} from "./chatTypes";

/** Defines chat history limit. */
export const CHAT_HISTORY_LIMIT = 1000;
/** Defines optimistic message retention milliseconds. */
export const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;
function canonicalChatValue(value: unknown, ancestors: Set<object>): unknown {
    if (value === null) {
        return ["null"];
    }
    if (value === undefined) {
        return ["undefined"];
    }
    if (typeof value === "bigint") {
        return ["bigint", value.toString()];
    }
    if (typeof value === "number") {
        let encoded: number | string = Number.isFinite(value) ? value : String(value);
        if (Object.is(value, -0)) {
            encoded = "-0";
        }
        return ["number", encoded];
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return [typeof value, value];
    }
    if (typeof value === "symbol") {
        return ["symbol", value.description ?? ""];
    }
    if (typeof value === "function") {
        return ["function", value.name || "anonymous"];
    }
    if (typeof value !== "object") {
        return [typeof value];
    }
    if (ancestors.has(value)) {
        return ["circular"];
    }

    const nestedAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return ["array", value.map((item) => canonicalChatValue(item, nestedAncestors))];
    }
    const constructorName = value.constructor?.name || "Object";
    return [
        "object",
        constructorName,
        Object.entries(value as Record<string, unknown>)
            .toSorted(([left], [right]) => {
                if (left < right) {
                    return -1;
                }
                if (left > right) {
                    return 1;
                }
                return 0;
            })
            .map(([key, item]) => [key, canonicalChatValue(item, nestedAncestors)]),
    ];
}

/**
 * Serializes JSON-like chat payloads independently of object key order.
 * @param value Value to process.
 * @returns Serialized JSON-like chat payloads independently of object key order.
 */
export function stableChatStringify(value: unknown): string {
    return JSON.stringify(canonicalChatValue(value, new Set())) ?? "undefined";
}

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
 * Returns a stable media identity independent of the turn carrying it.
 * @returns a stable media identity independent of the turn carrying it.
 */
export function messageMediaIdentity(message: ChatHistoryMessage): string | undefined {
    if (!message.images?.length && !message.attachments?.length) {
        return undefined;
    }

    return [
        "media",
        ...(message.images || []).map((image) => {
            const data =
                image.data || image.source?.data || chatImageDownloadUrl(image) || "";
            return [
                image.mimeType || image.source?.media_type || "image",
                chatContentFingerprint(data),
            ].join(":");
        }),
        ...(message.attachments || []).map((attachment) =>
            chatAttachmentIdentity(attachment)
        ),
    ].join("::");
}

/**
 * Returns a diagnostic identity for tool/thinking rows without primary text.
 * @returns a diagnostic identity for tool/thinking rows without primary text.
 */
function diagnosticMessageIdentity(message: ChatHistoryMessage): string | undefined {
    if (message.runtimeKey) {
        return `runtime:${message.runtimeKey}`;
    }

    const toolCalls = message.toolCalls || [];
    if (toolCalls.length > 0) {
        const fallbackScope = message.timestamp || message.runId || "unknown";
        return [
            "tool-calls",
            ...toolCalls.map((toolCall, index) =>
                [
                    toolCall.id || "no-id-" + fallbackScope + "-" + index,
                    toolCall.name,
                    stableChatStringify(toolCall.arguments ?? undefined),
                ].join("::")
            ),
        ].join("::");
    }

    if (message.toolResult) {
        const fallbackScope = message.timestamp || message.runId || "unknown";
        return [
            "tool-result",
            message.toolResult.id || "no-id-" + fallbackScope,
            message.toolResult.name || "tool",
            message.toolResult.content.trim(),
        ].join("::");
    }

    if (message.thinking?.length) {
        return ["thinking", message.thinking.map((block) => block.text).join("\n")].join(
            "::"
        );
    }

    return messageMediaIdentity(message);
}

/**
 * Returns a stable key for carrying tool results between matching tool rows.
 * @returns a stable key for carrying tool results between matching tool rows.
 */
function toolCallRowIdentity(message: ChatHistoryMessage): string | undefined {
    if (!message.toolCalls?.length) {
        return undefined;
    }

    return [
        "tool-calls",
        message.runId || message.timestamp || message.text.trim() || "no-row",
        ...message.toolCalls.map((toolCall, index) =>
            [
                toolCall.id || `no-id-${index}`,
                toolCall.name,
                stableChatStringify(toolCall.arguments ?? undefined),
            ].join("::")
        ),
    ].join("::");
}

/**
 * Returns whether message carries non-text details beyond primary text.
 * @returns Whether message carries non-text details beyond primary text.
 */
export function hasChatMessageDetails(message: ChatHistoryMessage): boolean {
    return Boolean(
        (message.thinking?.length || 0) > 0 ||
        (message.toolCalls?.length || 0) > 0 ||
        message.toolResult ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    );
}

/**
 * Carries non-text message details from a richer copy onto a canonical row.
 * @returns Merge chat message details result.
 */
export function mergeChatMessageDetails(
    message: ChatHistoryMessage,
    fallback: ChatHistoryMessage
): ChatHistoryMessage {
    return {
        ...message,
        images: mergeChatImages(message.images, fallback.images),
        attachments: mergeChatAttachments(message.attachments, fallback.attachments),
        thinking: (message.thinking?.length ? message : fallback).thinking,
        toolCalls:
            message.toolCalls?.length && fallback.toolCalls?.length
                ? mergeToolCallsWithResults(message.toolCalls, fallback.toolCalls)
                : (message.toolCalls?.length ? message : fallback).toolCalls,
        toolResult: message.toolResult || fallback.toolResult,
    };
}

/**
 * Returns user text normalized to the whitespace rendered by Markdown.
 * @param text Text value.
 * @returns user text normalized to the whitespace rendered by Markdown.
 */
function userMessageTextIdentity(text: string): string {
    const lines = text
        .replaceAll(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd());
    const identityLines: string[] = [];
    let isInCodeFence = false;
    let wasBlankLine = false;

    for (const line of lines) {
        const isFenceDelimiter = /^\s*(?:```|~~~)/u.test(line);
        const isCollapsibleBlankLine = !isInCodeFence && line.length === 0;
        if (!isCollapsibleBlankLine || !wasBlankLine) {
            identityLines.push(line);
        }
        wasBlankLine = isCollapsibleBlankLine;
        if (isFenceDelimiter) {
            isInCodeFence = !isInCodeFence;
            wasBlankLine = false;
        }
    }

    return identityLines.join("\n").trim();
}

/**
 * Carries local tool results onto matching history tool calls.
 * @returns Merge tool calls with results result.
 */
function mergeToolCallsWithResults(
    messageToolCalls: NonNullable<ChatHistoryMessage["toolCalls"]>,
    previousToolCalls: NonNullable<ChatHistoryMessage["toolCalls"]>
): NonNullable<ChatHistoryMessage["toolCalls"]> {
    const consumedPreviousIndexes = new Set<number>();

    return messageToolCalls.map((toolCall) => {
        if (toolCall.toolResult) {
            return toolCall;
        }

        const previousToolCallIndex = previousToolCalls.findIndex((candidate, index) => {
            if (consumedPreviousIndexes.has(index)) {
                return false;
            }

            if (toolCall.id || candidate.id) {
                return Boolean(
                    toolCall.id && candidate.id && toolCall.id === candidate.id
                );
            }

            return (
                toolCall.name === candidate.name &&
                stableChatStringify(toolCall.arguments ?? undefined) ===
                    stableChatStringify(candidate.arguments ?? undefined)
            );
        });

        if (previousToolCallIndex === -1) {
            return toolCall;
        }

        consumedPreviousIndexes.add(previousToolCallIndex);
        const previousToolCall = previousToolCalls[previousToolCallIndex];

        return previousToolCall?.toolResult
            ? { ...toolCall, toolResult: previousToolCall.toolResult }
            : toolCall;
    });
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
 * Performs message IDentity.
 * @returns Message IDentity result.
 */
export function messageIdentity(message: ChatHistoryMessage): string {
    const role = message.role.toLowerCase();
    const controlIdentity =
        message.intent === "control"
            ? message.controlId || message.runtimeKey
            : undefined;
    if (controlIdentity) {
        return `${role}::control::${controlIdentity}`;
    }
    const diagnosticIdentity = diagnosticMessageIdentity(message);
    const mediaIdentity = messageMediaIdentity(message);
    const textIdentity =
        role === "user" ? userMessageTextIdentity(message.text) : message.text.trim();
    const userMediaTurnIdentity =
        role === "user" && !textIdentity && mediaIdentity
            ? [mediaIdentity, message.runId || message.timestamp || "no-turn"].join("::")
            : undefined;
    const assistantMediaTurnIdentity =
        role === "assistant" && !textIdentity && mediaIdentity
            ? [mediaIdentity, message.runId || message.timestamp || "no-turn"].join("::")
            : undefined;
    const isToolResultRole = TOOL_ROLE_VARIANTS.includes(role);
    const identity = isToolResultRole
        ? diagnosticIdentity || textIdentity
        : textIdentity ||
          userMediaTurnIdentity ||
          assistantMediaTurnIdentity ||
          diagnosticIdentity;
    return `${role}::${identity || ""}`;
}

/**
 * Performs message delete key.
 * @returns Message delete key result.
 */
export function messageDeleteKey(message: ChatHistoryMessage): string {
    const textIdentity = message.text.trim();
    const diagnosticIdentity = diagnosticMessageIdentity(message);
    const stableTextDiagnosticIdentity =
        message.toolCalls?.length || message.toolResult
            ? diagnosticIdentity
            : messageMediaIdentity(message);
    const contentIdentity = textIdentity
        ? [textIdentity, stableTextDiagnosticIdentity].filter(Boolean).join("::")
        : diagnosticIdentity || "no-text";
    const keyParts = [
        message.role.toLowerCase(),
        message.timestamp || "no-time",
        message.runId || "no-run",
    ];
    if (message.runtimeKey) {
        keyParts.push(message.runtimeKey);
    }
    keyParts.push(`v2:${chatContentFingerprint(contentIdentity)}`);
    return keyParts.join("::");
}

/**
 * Performs assistant text looks recovered.
 * @param left Left value.
 * @param right Right value.
 * @returns Assistant text looks recovered result.
 */
export function isRecoveredAssistantText(left: string, right: string): boolean {
    const normalizedLeft = left.trim();
    const normalizedRight = right.trim();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    if (normalizedLeft.length < 20 || normalizedRight.length < 20) {
        return false;
    }

    return (
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)
    );
}

const CHAT_TEXT_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

function normalizedChatTextPrefix(text: string): string {
    return text.normalize("NFKC").replaceAll(/\s+/gu, " ");
}

/**
 * Removes a semantically equivalent prefix while preserving the original remainder.
 * This tolerates Unicode normalization and collapsed whitespace from provider finals.
 * @param text Full provider text.
 * @param prefix Previously sealed assistant text.
 * @returns The untouched remainder, or undefined when the prefix does not match.
 */
export function stripEquivalentChatTextPrefix(
    text: string,
    prefix: string
): string | undefined {
    if (text.startsWith(prefix)) {
        return text.slice(prefix.length);
    }
    const normalizedPrefix = normalizedChatTextPrefix(prefix);
    if (!normalizedPrefix) {
        return undefined;
    }
    let normalizedCandidate = "";
    for (const part of CHAT_TEXT_GRAPHEME_SEGMENTER.segment(text)) {
        const normalizedPart = normalizedChatTextPrefix(part.segment);
        normalizedCandidate +=
            normalizedCandidate.endsWith(" ") && normalizedPart.startsWith(" ")
                ? normalizedPart.slice(1)
                : normalizedPart;
        if (!normalizedPrefix.startsWith(normalizedCandidate)) {
            return undefined;
        }
        if (normalizedCandidate === normalizedPrefix) {
            let end = part.index + part.segment.length;
            if (normalizedPrefix.endsWith(" ")) {
                end += text.slice(end).match(/^\s+/u)?.[0].length ?? 0;
            }
            return text.slice(end);
        }
    }
    return undefined;
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
