import { canonicalChatContentFingerprint } from "../../../../../../contracts/chat/canonicalMessage";
import { messageDeleteKey, stableChatStringify } from "../chatMessageIdentity";
import {
    type ChatHistoryMessage,
    type ChatMessageSourceReference,
    mergeChatImages,
    TOOL_ROLE_VARIANTS,
} from "../chatTypes";
import { hasPrimaryAnswerContent } from "./chatPresentation";
import type { ChatRunState, ChatSessionRuntimeState } from "./chatState";

export const RUN_START_USER_SKEW_MS = 1000;
export const RUNTIME_FINAL_SKEW_MS = 5000;
export const RUNTIME_USER_ECHO_WINDOW_MS = 5000;

export function orderedRuns(session?: ChatSessionRuntimeState): ChatRunState[] {
    return Object.values(session?.runs || {}).toSorted((left, right) => {
        const leftSequence =
            left.phase === "active"
                ? left.lastSequence
                : (left.terminalSequence ?? left.lastSequence);
        const rightSequence =
            right.phase === "active"
                ? right.lastSequence
                : (right.terminalSequence ?? right.lastSequence);
        const sequenceDifference = leftSequence - rightSequence;
        return sequenceDifference || left.runId.localeCompare(right.runId);
    });
}

export function currentResponseStart(messages: ChatHistoryMessage[]): number {
    return messages.findLastIndex((message) => message.role.toLowerCase() === "user") + 1;
}

export interface ResponseSegment {
    end: number;
    start: number;
}

export function isUserMessage(message: ChatHistoryMessage): boolean {
    return message.role.toLowerCase() === "user";
}

export function isGatewayRestartContinuation(message: ChatHistoryMessage): boolean {
    return (
        isUserMessage(message) &&
        /^\[System\]\s+Your previous turn was interrupted by a gateway restart\b/iu.test(
            message.text.trim()
        )
    );
}

export function messageTimestamp(message: ChatHistoryMessage): number | undefined {
    const timestamp = Date.parse(message.timestamp || "");
    return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function isRunMatchingMessage(
    run: ChatRunState,
    message: ChatHistoryMessage
): boolean {
    return Boolean(
        message.runId &&
        (message.runId === run.runId || run.aliases.includes(message.runId))
    );
}

export function isDashboardRunId(runId?: string): boolean {
    return Boolean(
        runId?.startsWith("dashboard-chat-") || runId?.startsWith("dashboard-compact-")
    );
}

export function isStandaloneDiagnostic(message: ChatHistoryMessage): boolean {
    const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
    return Boolean(
        (message.isToolUse && message.isFinal !== true) ||
        (hasToolDetails && message.isFinal !== true) ||
        (message.thinking?.length &&
            (!message.text.trim() ||
                TOOL_ROLE_VARIANTS.includes(message.role.toLowerCase())))
    );
}

function stableDiagnosticRowKey(message: ChatHistoryMessage): string | undefined {
    if (!message.runId || !isStandaloneDiagnostic(message)) {
        return undefined;
    }
    if (message.thinking?.length && !message.toolCalls?.length && !message.toolResult) {
        return `diagnostic-${message.runId}-thinking`;
    }
    const toolCalls = message.toolCalls || [];
    const toolCallIds = toolCalls
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => Boolean(id));
    const expectedCallRuntimeKey =
        toolCallIds.length === 1 ? `tool:${toolCallIds[0]}` : undefined;
    if (
        toolCalls.length > 0 &&
        toolCallIds.length === toolCalls.length &&
        (!message.runtimeKey || message.runtimeKey === expectedCallRuntimeKey)
    ) {
        return `diagnostic-${message.runId}-tool-call-${toolCallIds.join(":")}`;
    }
    if (
        toolCalls.length === 0 &&
        message.toolResult?.id &&
        (!message.runtimeKey || message.runtimeKey === `tool:${message.toolResult.id}`)
    ) {
        return `diagnostic-${message.runId}-tool-result-${message.toolResult.id}`;
    }
    const facet = toolCalls.length > 0 ? "tool-call" : "tool-result";
    if (message.runtimeKey) {
        const runtimeIdentity = canonicalChatContentFingerprint(message.runtimeKey);
        return `diagnostic-${message.runId}-${facet}-runtime-${runtimeIdentity}`;
    }
    return undefined;
}

function historyMessageDeleteKey(message: ChatHistoryMessage): string {
    return messageDeleteKey({
        ...message,
        runId: undefined,
        runtimeKey: undefined,
    });
}

/**
 * Gives an optimistic prompt and its history echo one bounded run-independent alias.
 * Two overlapping buckets cover the runtime echo window without hiding the same
 * prompt sent much later. Local rows also carry the no-time alias because Gateway
 * history may omit the provider timestamp together with the run identity.
 * @returns Bounded run-independent aliases for recovered user history.
 */
function unscopedUserRecoveryDeleteKeys(message: ChatHistoryMessage): string[] {
    const contentIdentity = canonicalChatContentFingerprint(
        messageDeleteKey({
            ...message,
            runId: undefined,
            runtimeKey: undefined,
            timestamp: undefined,
        })
    );
    const timestamp = messageTimestamp(message);
    const scopes = new Set<string>();
    if (timestamp === undefined || message.local === true) {
        scopes.add("no-time");
    }
    if (timestamp !== undefined) {
        const bucketWidth = RUNTIME_USER_ECHO_WINDOW_MS * 2;
        scopes.add(`time-${Math.floor(timestamp / bucketWidth)}`);
        scopes.add(
            `time-${Math.floor((timestamp + RUNTIME_USER_ECHO_WINDOW_MS) / bucketWidth)}`
        );
    }
    return [...scopes].map(
        (scope) => `chat-user-recovery:v1:${scope}:${contentIdentity}`
    );
}

function scopedUserRecoveryDeleteKeys(
    message: ChatHistoryMessage,
    runs: ChatRunState[]
): string[] {
    const runId = message.runId?.trim();
    const unscopedKeys = unscopedUserRecoveryDeleteKeys(message);
    if (!runId) {
        return unscopedKeys;
    }
    const matchingRun = runs.find((run) => isRunMatchingMessage(run, message));
    const runIds = matchingRun ? [matchingRun.runId, ...matchingRun.aliases] : [runId];
    return [
        ...new Set([
            ...runIds.map((candidateRunId) =>
                messageDeleteKey({
                    ...message,
                    runId: candidateRunId,
                    runtimeKey: undefined,
                    timestamp: undefined,
                })
            ),
            ...unscopedKeys,
        ]),
    ];
}

function userMessageDeleteKeys(
    message: ChatHistoryMessage,
    runs: ChatRunState[]
): string[] {
    const historyKey = historyMessageDeleteKey(message);
    const recoveryKeys = scopedUserRecoveryDeleteKeys(message, runs);
    return [
        historyKey,
        ...recoveryKeys.filter((recoveryKey) => recoveryKey !== historyKey),
    ];
}

export function projectedMessageRowKey(message: ChatHistoryMessage): string {
    if (isUserMessage(message)) {
        return historyMessageDeleteKey(message);
    }
    if (message.intent === "control") {
        return `control-${
            message.controlId ||
            message.runtimeKey ||
            canonicalChatContentFingerprint(
                `${message.timestamp || ""}\u0000${message.text}`
            )
        }`;
    }
    const diagnosticKey = stableDiagnosticRowKey(message);
    if (diagnosticKey) {
        return diagnosticKey;
    }
    const role = message.role.toLowerCase();
    if (
        message.runId &&
        (role === "assistant" || role === "system") &&
        hasPrimaryAnswerContent(message)
    ) {
        return `response-${message.runId}`;
    }
    return message.local === true && message.runId
        ? `stream-${message.runId}-${message.runtimeKey || messageDeleteKey(message)}`
        : messageDeleteKey(message);
}

function projectedMessageSourceFacet(message: ChatHistoryMessage): string {
    if (message.intent) {
        return message.intent;
    }
    const role = message.role.toLowerCase();
    if (role === "user") {
        return "user";
    }
    if (
        message.thinking?.length &&
        !message.toolCalls?.length &&
        !message.toolResult &&
        !hasPrimaryAnswerContent(message)
    ) {
        return "thinking";
    }
    if (message.toolCalls?.length || message.toolResult || message.isToolUse) {
        return "tool";
    }
    return "assistant";
}

function projectedMessageSources(
    message: ChatHistoryMessage
): ChatMessageSourceReference[] {
    const provenance = message.provenance;
    if (!provenance) {
        return [];
    }
    const { relatedSources = [], ...primarySource } = provenance;
    return [primarySource, ...relatedSources];
}

function projectedMessageSourceDeleteKeys(message: ChatHistoryMessage): string[] {
    const sourcesByIdentity = new Map<string, ChatMessageSourceReference>();
    for (const source of projectedMessageSources(message)) {
        const identity = stableChatStringify({
            id: source.id,
            sequence: source.sequence,
            source: source.source,
        });
        if (!sourcesByIdentity.has(identity)) {
            sourcesByIdentity.set(identity, source);
        }
    }
    const facet = projectedMessageSourceFacet(message);
    return sourcesByIdentity
        .entries()
        .toArray()
        .toSorted(([, left], [, right]) => {
            const sequenceDifference =
                (left.sequence ?? Number.MAX_SAFE_INTEGER) -
                (right.sequence ?? Number.MAX_SAFE_INTEGER);
            return (
                sequenceDifference ||
                left.source.localeCompare(right.source) ||
                left.id.localeCompare(right.id)
            );
        })
        .map(
            ([sourceIdentity]) =>
                `chat-message-source:v1:${canonicalChatContentFingerprint(
                    stableChatStringify({ facet, sourceIdentity })
                )}`
        );
}

function hasPositionFallbackHistorySource(message: ChatHistoryMessage): boolean {
    return projectedMessageSources(message).some(
        (source) =>
            source.source === "openclaw-history" &&
            source.sequence === undefined &&
            /^openclaw-history:[^:]+:position%3A/iu.test(source.id)
    );
}

/** Separates persisted delete keys from runtime-only fallback identities. */
export interface ProjectedMessageDeleteIdentity {
    baseKeys: string[];
    persistedKeyCount: number;
}

/**
 * Keeps persisted delete keys valid when runtime reconciliation adds a run id.
 * @returns Projected message delete keys and the persisted-key boundary.
 */
export function projectedMessageDeleteIdentity(
    message: ChatHistoryMessage,
    runs: ChatRunState[]
): ProjectedMessageDeleteIdentity {
    const sourceKeys = projectedMessageSourceDeleteKeys(message);
    const userKeys = isUserMessage(message) ? userMessageDeleteKeys(message, runs) : [];
    if (sourceKeys.length > 0) {
        const stableFallbackKey = hasPositionFallbackHistorySource(message)
            ? projectedMessageRowKey(message)
            : undefined;
        const persistedKeys = stableFallbackKey
            ? [
                  stableFallbackKey,
                  ...sourceKeys.filter((key) => key !== stableFallbackKey),
              ]
            : sourceKeys;
        const baseKeys = [
            ...persistedKeys,
            ...userKeys.filter((key) => !persistedKeys.includes(key)),
        ];
        return {
            baseKeys,
            persistedKeyCount: persistedKeys.length,
        };
    }
    if (userKeys.length > 0) {
        const persistedKeyCount =
            !message.runId && message.local !== true ? 1 : userKeys.length;
        return { baseKeys: userKeys, persistedKeyCount };
    }
    const currentKey = projectedMessageRowKey(message);
    if (!message.runId || message.local === true) {
        return { baseKeys: [currentKey], persistedKeyCount: 1 };
    }
    const persistedHistoryKey = historyMessageDeleteKey(message);
    const baseKeys =
        currentKey === persistedHistoryKey
            ? [currentKey]
            : [currentKey, persistedHistoryKey];
    return { baseKeys, persistedKeyCount: baseKeys.length };
}

export function asAssistantToolResultMessage(
    message: ChatHistoryMessage
): ChatHistoryMessage {
    const toolResult = message.toolResult;
    const isToolResultRole = TOOL_ROLE_VARIANTS.includes(message.role.toLowerCase());
    if (!toolResult || !isToolResultRole) {
        return message;
    }

    const nestedToolResult = {
        ...toolResult,
        images: mergeChatImages(toolResult.images, message.images),
        name: toolResult.name || "tool",
    };
    const existingToolCalls = message.toolCalls || [];
    const matchingNestedResultIndex = existingToolCalls.findIndex((toolCall) => {
        const nestedResult = toolCall.toolResult;
        if (!nestedResult) {
            return false;
        }
        if (nestedResult.id || nestedToolResult.id) {
            return Boolean(
                nestedResult.id &&
                nestedToolResult.id &&
                nestedResult.id === nestedToolResult.id
            );
        }
        return (nestedResult.name || toolCall.name) === nestedToolResult.name;
    });
    const matchingCallIndex =
        matchingNestedResultIndex === -1
            ? existingToolCalls.findIndex((toolCall) =>
                  toolCall.id || nestedToolResult.id
                      ? Boolean(
                            toolCall.id &&
                            nestedToolResult.id &&
                            toolCall.id === nestedToolResult.id
                        )
                      : toolCall.name === nestedToolResult.name
              )
            : -1;
    const toolCalls = existingToolCalls.map((toolCall, index) => {
        if (index === matchingNestedResultIndex) {
            return {
                ...toolCall,
                toolResult: {
                    ...toolCall.toolResult,
                    ...nestedToolResult,
                    images: mergeChatImages(
                        toolCall.toolResult?.images,
                        nestedToolResult.images
                    ),
                },
            };
        }
        return index === matchingCallIndex
            ? { ...toolCall, toolResult: nestedToolResult }
            : toolCall;
    });
    if (
        toolCalls.length === 0 ||
        (matchingNestedResultIndex === -1 && matchingCallIndex === -1)
    ) {
        toolCalls.push({
            id: nestedToolResult.id,
            name: nestedToolResult.name,
            toolResult: nestedToolResult,
        });
    }
    return {
        ...message,
        images: [],
        role: "assistant",
        text: "",
        toolCalls,
        toolResult: undefined,
    };
}
