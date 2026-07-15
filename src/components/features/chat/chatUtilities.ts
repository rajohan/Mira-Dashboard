import type { Session } from "../../../types/session";
import { timestampFromDateString } from "../../../utils/date";
import { stripThinkingFromMessage } from "./chatRuntime";
import {
    chatAttachmentIdentity,
    chatContentFingerprint,
    type ChatHistoryMessage,
    mergeChatAttachments,
    mergeChatImages,
    TOOL_ROLE_VARIANTS,
} from "./chatTypes";

/** Defines max attachment bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Defines max attachments. */
export const MAX_ATTACHMENTS = 10;
/** Defines chat history limit. */
export const CHAT_HISTORY_LIMIT = 1000;
/** Defines optimistic message retention milliseconds. */
export const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;

/** Returns a displayable error message with a stable fallback. */
export function chatErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message || fallback;
    }

    return fallback;
}

/** Represents chat model option. */
export interface ChatModelOption {
    id?: string;
    label?: string;
    name?: string;
}

interface ChatSettingOption {
    value: string;
    label: string;
}

/** Normalizes legacy thinking labels to OpenClaw's canonical level ids. */
function normalizeThinkingLevel(level: string): string | undefined {
    const collapsed = level
        .trim()
        .toLowerCase()
        .replaceAll(/[\s_-]+/g, "");
    if (["adaptive", "auto"].includes(collapsed)) return "adaptive";
    if (["xhigh", "extrahigh"].includes(collapsed)) return "xhigh";
    if (["max", "off"].includes(collapsed)) return collapsed;
    if (["on", "enable", "enabled"].includes(collapsed)) return "low";
    if (["min", "minimal", "think"].includes(collapsed)) return "minimal";
    if (["low", "thinkhard"].includes(collapsed)) return "low";
    if (["mid", "med", "medium", "thinkharder", "harder"].includes(collapsed)) {
        return "medium";
    }
    if (["high", "ultra", "ultrathink", "thinkhardest", "highest"].includes(collapsed)) {
        return "high";
    }
    return undefined;
}

/** Returns the model-supported thinking options exposed by OpenClaw. */
export function chatThinkingOptions(session: Session | undefined): ChatSettingOption[] {
    const seenIds = new Set<string>();
    const levels = session?.thinkingLevels?.length
        ? session.thinkingLevels
        : (session?.thinkingOptions || []).flatMap((label) => {
              const id = normalizeThinkingLevel(label);
              if (!id || seenIds.has(id)) return [];
              seenIds.add(id);
              return [{ id, label }];
          });
    const options = levels.map((level) => ({
        label: level.label || level.id,
        value: level.id,
    }));
    const currentLevel = session?.thinkingLevel;
    if (currentLevel && options.every((option) => option.value !== currentLevel)) {
        options.push({ label: currentLevel, value: currentLevel });
    }
    const defaultLabel = session?.thinkingDefault
        ? `Default (${session.thinkingDefault})`
        : "Default";
    return [{ label: defaultLabel, value: "" }, ...options];
}

/** Returns the OpenClaw fast-mode choices. */
export function chatSpeedOptions(session?: Session): ChatSettingOption[] {
    const effectiveMode = session?.effectiveFastMode;
    const effectiveLabel =
        effectiveMode === "auto"
            ? "Auto"
            : effectiveMode === true
              ? "Fast"
              : effectiveMode === false
                ? "Standard"
                : undefined;
    return [
        { label: effectiveLabel ? `Default (${effectiveLabel})` : "Default", value: "" },
        { label: "Fast", value: "on" },
        { label: "Standard", value: "off" },
        { label: "Auto", value: "auto" },
    ];
}

/** Returns the selected fast-mode override value. */
export function selectedChatSpeed(session: Session | undefined): string {
    if (session?.fastMode === "auto") return "auto";
    if (session?.fastMode === true) return "on";
    if (session?.fastMode === false) return "off";
    return "";
}

/** Performs data URL to base64. */
export function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/** Performs base64 to text. */
export function base64ToText(base64: string): string | undefined {
    try {
        const bytes = Uint8Array.fromBase64(base64);
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    } catch {
        return undefined;
    }
}

/** Returns a stable media identity independent of the turn carrying it. */
function messageMediaIdentity(message: ChatHistoryMessage): string | undefined {
    if (!message.images?.length && !message.attachments?.length) {
        return undefined;
    }

    return [
        "media",
        ...(message.images || []).map((image) => {
            const data = image.data || image.source?.data || "";
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

/** Returns a diagnostic identity for tool/thinking rows without primary text. */
function diagnosticMessageIdentity(message: ChatHistoryMessage): string | undefined {
    const toolCalls = message.toolCalls || [];
    if (toolCalls.length > 0) {
        const fallbackScope = message.timestamp || message.runId || "unknown";
        return [
            "tool-calls",
            ...toolCalls.map((toolCall, index) =>
                [
                    toolCall.id || "no-id-" + fallbackScope + "-" + index,
                    toolCall.name,
                    JSON.stringify(toolCall.arguments ?? undefined),
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

/** Returns a stable key for carrying tool results between matching tool rows. */
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
                JSON.stringify(toolCall.arguments ?? undefined),
            ].join("::")
        ),
    ].join("::");
}

/** Returns whether message carries non-text details beyond primary text. */
export function hasChatMessageDetails(message: ChatHistoryMessage): boolean {
    return Boolean(
        (message.thinking?.length || 0) > 0 ||
        (message.toolCalls?.length || 0) > 0 ||
        message.toolResult ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    );
}

/** Carries non-text message details from a richer copy onto a canonical row. */
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

/** Returns user text normalized to the whitespace rendered by Markdown. */
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

/** Carries local tool results onto matching history tool calls. */
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
                JSON.stringify(toolCall.arguments ?? undefined) ===
                    JSON.stringify(candidate.arguments ?? undefined)
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

/** Carries local diagnostic details onto matching history text rows. */
function mergeDiagnosticDetails(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const unmatchedPrevious = previousMessages.filter(
        (candidate) =>
            candidate.local === true &&
            candidate.role.toLowerCase() === "assistant" &&
            candidate.text.trim() &&
            hasChatMessageDetails(candidate)
    );

    return nextMessages.map((message) => {
        if (message.role.toLowerCase() !== "assistant" || !message.text.trim()) {
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

/** Performs message IDentity. */
export function messageIdentity(message: ChatHistoryMessage): string {
    const role = message.role.toLowerCase();
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

/** Performs message delete key. */
export function messageDeleteKey(message: ChatHistoryMessage): string {
    const diagnosticIdentity = diagnosticMessageIdentity(message);
    return [
        message.role.toLowerCase(),
        message.timestamp || "no-time",
        message.runId || "no-run",
        diagnosticIdentity || message.text.trim() || "no-text",
    ].join("::");
}

/** Returns current and legacy local-delete identities for one message. */
export function messageDeleteKeys(message: ChatHistoryMessage): string[] {
    const currentKey = messageDeleteKey(message);
    if (!message.runId) {
        return [currentKey];
    }

    const legacyKey = messageDeleteKey({ ...message, runId: undefined });
    return currentKey === legacyKey ? [currentKey] : [currentKey, legacyKey];
}

/** Performs assistant text looks recovered. */
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

/** Performs dedupe messages. */
export function dedupeMessages(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const seen = new Set<string>();
    const deduped: ChatHistoryMessage[] = [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }

        const identity = messageIdentity(message);
        const role = message.role.toLowerCase();
        const isUnscopedTextlessConversationalMedia = Boolean(
            (role === "user" || role === "assistant") &&
            !message.text.trim() &&
            messageMediaIdentity(message) &&
            !message.runId &&
            !message.timestamp
        );
        if (
            (message.text.trim() || diagnosticMessageIdentity(message)) &&
            seen.has(identity) &&
            !isUnscopedTextlessConversationalMedia
        ) {
            continue;
        }

        seen.add(identity);
        deduped.unshift(message);
    }

    return deduped;
}

/** Performs message timestamp milliseconds. */
function messageTimestampMs(message: ChatHistoryMessage): number | undefined {
    return message.timestamp ? timestampFromDateString(message.timestamp) : undefined;
}

/** Performs insert messages by timestamp. */
function insertMessagesByTimestamp(
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
            return candidateTimestamp === undefined || candidateTimestamp > timestamp;
        });

        if (insertionIndex === -1) {
            merged.push(message);
        } else {
            merged.splice(insertionIndex, 0, message);
        }
    }

    return merged;
}

/** Copies live tool results onto matching history tool calls. */
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

/** Performs merge with recent optimistic messages. */
export function mergeWithRecentOptimisticMessages(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[],
    shouldMergeThinking = true,
    shouldPreserveNextThinking = shouldMergeThinking
): ChatHistoryMessage[] {
    const mergeablePreviousMessages = shouldMergeThinking
        ? previousMessages
        : previousMessages.map((message) => stripThinkingFromMessage(message));
    const mergeableNextMessages = shouldPreserveNextThinking
        ? nextMessages
        : nextMessages.map((message) => stripThinkingFromMessage(message));
    if (previousMessages.length === 0) {
        return dedupeMessages(mergeableNextMessages);
    }

    if (nextMessages.length === 0) {
        return mergeablePreviousMessages;
    }

    const enrichedNextMessages = mergeDiagnosticDetails(
        mergeablePreviousMessages,
        mergeToolCallResults(mergeablePreviousMessages, mergeableNextMessages)
    );
    const nextIdentities = new Set(
        enrichedNextMessages.map((message) => messageIdentity(message))
    );
    const nextIdentityCounts = new Map<string, number>();
    const unmatchedNextMediaCounts = new Map<string, number>();
    for (const message of enrichedNextMessages) {
        const identity = messageIdentity(message);
        nextIdentityCounts.set(identity, (nextIdentityCounts.get(identity) || 0) + 1);

        const mediaIdentity = messageMediaIdentity(message);
        const role = message.role.toLowerCase();
        if ((role === "user" || role === "assistant") && mediaIdentity) {
            const mediaKey = `${role}::${mediaIdentity}`;
            unmatchedNextMediaCounts.set(
                mediaKey,
                (unmatchedNextMediaCounts.get(mediaKey) || 0) + 1
            );
        }
    }
    for (const message of mergeablePreviousMessages) {
        if (message.local === true) {
            continue;
        }

        const identity = messageIdentity(message);
        const identityCount = nextIdentityCounts.get(identity) || 0;
        const mediaIdentity = messageMediaIdentity(message);
        const role = message.role.toLowerCase();
        if (
            identityCount === 0 ||
            (role !== "user" && role !== "assistant") ||
            message.text.trim() ||
            !mediaIdentity
        ) {
            continue;
        }

        nextIdentityCounts.set(identity, identityCount - 1);
        const mediaKey = `${role}::${mediaIdentity}`;
        const mediaCount = unmatchedNextMediaCounts.get(mediaKey) || 0;
        unmatchedNextMediaCounts.set(mediaKey, Math.max(0, mediaCount - 1));
    }
    const nextToolCallRowsByIdentity = new Map<string, ChatHistoryMessage>();
    for (const message of enrichedNextMessages) {
        const identity = toolCallRowIdentity(message);
        if (identity) {
            nextToolCallRowsByIdentity.set(identity, message);
        }
    }
    const nextAssistantTexts = mergeableNextMessages
        .filter((message) => message.role.toLowerCase() === "assistant")
        .map((message) => message.text);
    const now = Date.now();
    const recentMissingMessages = mergeablePreviousMessages.filter((message) => {
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

        if (!message.text.trim() && !isSystemMessage && !isLocalDiagnosticMessage) {
            return false;
        }

        if (nextIdentities.has(messageIdentity(message))) {
            return false;
        }

        const mediaIdentity = messageMediaIdentity(message);
        const mediaKey = `${role}::${mediaIdentity || ""}`;
        const unmatchedMediaCount = mediaIdentity
            ? unmatchedNextMediaCounts.get(mediaKey) || 0
            : 0;
        if (
            (role === "user" || role === "assistant") &&
            isLocalMessage &&
            !message.text.trim() &&
            mediaIdentity &&
            unmatchedMediaCount > 0
        ) {
            unmatchedNextMediaCounts.set(mediaKey, unmatchedMediaCount - 1);
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

/** Performs read file as data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
                return;
            }

            reject(new Error(`Could not read ${file.name}`));
        });
        reader.addEventListener("error", () =>
            reject(reader.error || new Error(`Could not read ${file.name}`))
        );
        reader.readAsDataURL(file);
    });
}

/** Performs display MIME type. */
export function displayMimeType(file: File): string {
    return file.type || "application/octet-stream";
}
