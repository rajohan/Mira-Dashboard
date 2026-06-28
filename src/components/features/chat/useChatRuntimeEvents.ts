import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import { currentIsoString, isoStringFromDate } from "../../../utils/date";
import {
    type ActiveChatStreams,
    createChatVisibility,
    createLocalSystemMessage,
    finalMessageFromPayload,
    isCommandMessagePayload,
    isRecord,
    isSameSessionKey,
    mergeStreamMessage,
    mergeStreamText,
    normalizeAssistantPayload,
    uniqueStrings,
    visibleHistoryMessages,
} from "./chatRuntime";
import {
    type ChatHistoryMessage,
    type ChatStreamEventMessage,
    extractImages,
    isRenderableChatHistoryMessage,
    normalizeText,
    type RawChatHistoryMessage,
} from "./chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    dedupeMessages,
    mergeWithRecentOptimisticMessages,
} from "./chatUtilities";

/** Represents mutable reference. */
interface MutableReference<T> {
    current: T;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** Represents pending delta update. */
interface PendingDeltaUpdate {
    runId: string;
    aliases: string[];
    deltas: ChatHistoryMessage[];
}

const TERMINAL_LIFECYCLE_PHASES = new Set(["end", "error"]);
const TERMINAL_RUNTIME_EVENTS = new Set(["model.completed", "session.ended"]);
const TERMINAL_CHAT_STATES = new Set(["aborted", "error", "final"]);
const WORK_STREAMS = new Set([
    "assistant",
    "thinking",
    "reasoning",
    "tool",
    "item",
    "plan",
    "approval",
    "patch",
    "compaction",
]);
const NON_WORK_TOOL_NAMES = new Set([
    "message",
    "messages",
    "reply",
    "send",
    "reaction",
    "react",
    "typing",
]);

/** Returns a tool name without provider/runtime namespace. */
function normalizedToolName(value: string): string {
    return value.startsWith("functions.") ? value.slice("functions.".length) : value;
}

/** Returns whether a tool is chat delivery noise rather than agent work. */
function isNonWorkToolName(value: string): boolean {
    return NON_WORK_TOOL_NAMES.has(normalizedToolName(value).toLowerCase());
}

/** Returns whether a stream carries assistant reasoning text. */
function isRuntimeThinkingStream(stream: string): boolean {
    return stream === "thinking" || stream === "reasoning";
}

/** Returns whether a queued delta used its session key as a provisional run id. */
function isProvisionalRunId(streamSessionKey: string, runId: string): boolean {
    return runId === streamSessionKey;
}

/** Returns whether a stream run id came from an optimistic dashboard send. */
function isOptimisticRunId(runId: string): boolean {
    return runId.startsWith("dashboard-chat-");
}

/** Returns an internal active stream key for runtime work. */
function runtimeWorkStreamKey(
    sessionKey: string,
    stream: string,
    eventName: string,
    runId?: string
) {
    const channel = stream || eventName || "work";
    return runId ? `${sessionKey}::${runId}::${channel}` : `${sessionKey}::${channel}`;
}

/** Performs compact status text. */
export function compactStatusText(value: string): string {
    const normalized = value.replaceAll(/\s+/g, " ").trim();
    return normalized.length > 120
        ? `${normalized.slice(0, 119).trimEnd()}…`
        : normalized;
}

/** Performs string value. */
export function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Returns non-empty raw string fields without trimming stream whitespace. */
function rawStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Formats tool name for display. */
export function formatToolName(value: string): string {
    const withoutNamespace = value.startsWith("functions.")
        ? value.slice("functions.".length)
        : value;
    const normalized = withoutNamespace
        .replaceAll(/[_-]/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim();

    return normalized
        ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
        : normalized;
}

/** Performs detail from args. */
export function detailFromArguments(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return stringValue(value);
    }

    const keys = [
        "command",
        "cmd",
        "query",
        "url",
        "path",
        "filePath",
        "message",
        "text",
        "title",
        "name",
    ];

    for (const key of keys) {
        const detail = stringValue(value[key]);
        if (detail) {
            return detail;
        }
    }

    return undefined;
}

/** Normalizes runtime stream. */
export function normalizeRuntimeStream(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }

    return value === "command_output" ? "command-output" : value;
}

/** Performs runtime progress text. */
export function runtimeProgressText(
    eventName: string,
    stream: string,
    phase: string,
    data: Record<string, unknown>
): string | undefined {
    if (stream === "lifecycle") {
        return phase === "start" ? "Thinking" : undefined;
    }

    if (isRuntimeThinkingStream(stream)) {
        return "Thinking";
    }

    if (stream === "tool" || eventName === "session.tool") {
        const toolName = stringValue(data.name) || stringValue(data.toolName) || "tool";
        if (isNonWorkToolName(toolName)) {
            return undefined;
        }

        const detail =
            detailFromArguments(data.args) ||
            stringValue(data.title) ||
            stringValue(data.summary) ||
            stringValue(data.progressText);
        const statusText = detail
            ? `${formatToolName(toolName)}: ${detail}`
            : formatToolName(toolName);
        return compactStatusText(statusText);
    }

    if (stream === "item") {
        if (data.suppressChannelProgress === true || isRuntimeThinkingItem(data)) {
            return undefined;
        }

        const itemName = stringValue(data.name) || stringValue(data.itemKind);
        const detail =
            stringValue(data.meta) ||
            stringValue(data.summary) ||
            stringValue(data.progressText) ||
            stringValue(data.title);

        if (!itemName && !detail) {
            return undefined;
        }

        return compactStatusText(
            [itemName ? formatToolName(itemName) : undefined, detail]
                .filter(Boolean)
                .join(": ")
        );
    }

    if (stream === "plan") {
        return compactStatusText(
            stringValue(data.explanation) || stringValue(data.title) || "Updating plan"
        );
    }

    if (stream === "approval") {
        return compactStatusText(
            stringValue(data.command) ||
                stringValue(data.message) ||
                stringValue(data.reason) ||
                "Waiting for approval"
        );
    }

    if (stream === "patch") {
        return compactStatusText(
            stringValue(data.summary) || stringValue(data.title) || "Applying patch"
        );
    }

    if (stream === "command-output") {
        if (phase && phase !== "end") {
            return undefined;
        }

        const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
        let status = stringValue(data.status);
        if (exitCode === 0) {
            status = "completed";
        } else if (exitCode !== undefined) {
            status = `exit ${exitCode}`;
        }
        const title = stringValue(data.title);
        return compactStatusText(
            [formatToolName(stringValue(data.name) || "exec"), status, title]
                .filter(Boolean)
                .join(": ")
        );
    }

    if (stream === "compaction") {
        return phase === "end" ? undefined : "Compacting context";
    }

    return undefined;
}

/** Returns whether new run for stream. */
export function isNewRunForStream(
    existing: undefined | { runId?: string; aliases?: string[] },
    incomingRunId?: string
): boolean {
    return Boolean(
        existing &&
        incomingRunId &&
        existing.runId !== incomingRunId &&
        !existing.aliases?.includes(incomingRunId)
    );
}

/** Returns whether runtime work event. */
export function isRuntimeWorkEvent(
    eventName: string,
    stream: string,
    phase: string,
    statusText?: string
): boolean {
    if (eventName === "session.tool" || stream === "tool") {
        return Boolean(statusText);
    }

    return (
        Boolean(statusText) ||
        (stream === "lifecycle" && phase === "start") ||
        WORK_STREAMS.has(stream)
    );
}

/** Returns a compact display string for runtime payload values. */
function runtimeDisplayText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        const text = normalizeText(value);
        if (text) {
            return text;
        }
    }

    if (value === undefined || value === null) {
        return "";
    }

    try {
        return JSON.stringify(value, undefined, 2);
    } catch {
        return String(value);
    }
}

/** Builds transient chat rows for Gateway v4 tool transcript events. */
function runtimeToolMessages(
    data: Record<string, unknown>,
    runId?: string
): ChatHistoryMessage[] {
    const name = stringValue(data.name) || stringValue(data.toolName) || "tool";
    if (isNonWorkToolName(name)) {
        return [];
    }

    const id =
        stringValue(data.id) ||
        stringValue(data.toolCallId) ||
        stringValue(data.tool_call_id) ||
        stringValue(data.callId);
    const arguments_ = data.args ?? data.arguments ?? data.input;
    const result = data.result ?? data.output ?? data.content ?? data.text ?? data.error;
    const phase = stringValue(data.phase);
    const hasResult =
        phase === "result" ||
        phase === "end" ||
        phase === "error" ||
        result !== undefined;

    const timestamp = currentIsoString();
    const messages: ChatHistoryMessage[] = [];
    const resultContent = runtimeDisplayText(result);
    const resultImages = extractImages(result);
    const hasResultOutput = resultContent.length > 0 || resultImages.length > 0;
    const shouldCreateToolResult =
        hasResult && (phase !== "end" || hasResultOutput || data.isError === true);
    const toolCall =
        arguments_ !== undefined || !hasResult
            ? {
                  id,
                  name,
                  arguments: arguments_,
                  toolResult: undefined,
              }
            : undefined;
    const toolResult = shouldCreateToolResult
        ? {
              id,
              name,
              content: resultContent,
              isError: phase === "error" || data.isError === true,
              images: resultImages,
          }
        : undefined;

    if (toolCall) {
        messages.push({
            role: "assistant",
            content: "",
            text: "",
            images: [],
            attachments: [],
            toolCalls: [{ ...toolCall, toolResult }],
            toolResult,
            timestamp,
            local: true,
            runId,
        });
    }

    if (!toolCall && toolResult) {
        messages.push({
            role: "tool",
            content: toolResult.content,
            text: toolResult.content,
            images: [],
            attachments: [],
            toolResult,
            timestamp: isoStringFromDate(Date.now() + messages.length),
            local: true,
            runId,
        });
    }

    return messages;
}

/** Returns the best tool call index for a result. */
function matchingToolCallIndex(
    toolCalls: ChatHistoryMessage["toolCalls"],
    result: NonNullable<ChatHistoryMessage["toolResult"]>,
    incomingToolCall?: NonNullable<ChatHistoryMessage["toolCalls"]>[number]
): number {
    if (!toolCalls?.length) {
        return -1;
    }

    if (result.id) {
        const idMatchIndex = toolCalls.findIndex(
            (toolCall) => toolCall.id && toolCall.id === result.id
        );
        if (idMatchIndex !== -1) {
            return idMatchIndex;
        }

        if (incomingToolCall?.id === result.id) {
            const incomingArguments = JSON.stringify(
                incomingToolCall.arguments ?? undefined
            );
            return toolCalls.findIndex(
                (toolCall) =>
                    !toolCall.id &&
                    !toolCall.toolResult &&
                    toolCall.name === incomingToolCall.name &&
                    JSON.stringify(toolCall.arguments ?? undefined) === incomingArguments
            );
        }

        return -1;
    }

    if (!result.name) {
        return -1;
    }

    return toolCalls.findIndex(
        (toolCall) => toolCall.name === result.name && !toolCall.toolResult
    );
}

/** Finds the latest assistant row with an unfilled matching tool call. */
function matchingToolMessageIndex(
    messages: ChatHistoryMessage[],
    result: NonNullable<ChatHistoryMessage["toolResult"]>,
    incomingToolCall?: NonNullable<ChatHistoryMessage["toolCalls"]>[number]
): { messageIndex: number; toolCallIndex: number } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const existing = messages[index]!;
        if (existing.role.toLowerCase() === "assistant") {
            const toolCallIndex = matchingToolCallIndex(
                existing.toolCalls,
                result,
                incomingToolCall
            );
            if (toolCallIndex !== -1) {
                return { messageIndex: index, toolCallIndex };
            }
        }
    }

    return undefined;
}

/** Finds an existing live tool call row for a repeated call update. */
function matchingToolCallUpdateIndex(
    messages: ChatHistoryMessage[],
    incomingToolCall: NonNullable<ChatHistoryMessage["toolCalls"]>[number]
): { messageIndex: number; toolCallIndex: number } | undefined {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const existing = messages[messageIndex];
        if (existing?.role.toLowerCase() !== "assistant") {
            continue;
        }

        const toolCallIndex = (existing.toolCalls || []).findIndex((toolCall) => {
            if (incomingToolCall.id) {
                return toolCall.id === incomingToolCall.id;
            }

            return (
                !toolCall.id &&
                toolCall.name === incomingToolCall.name &&
                JSON.stringify(toolCall.arguments ?? undefined) ===
                    JSON.stringify(incomingToolCall.arguments ?? undefined)
            );
        });

        if (toolCallIndex !== -1) {
            return { messageIndex, toolCallIndex };
        }
    }

    return undefined;
}

/** Merges tool result rows into their matching tool call row when possible. */
function mergeRuntimeToolMessages(
    wasPrevious: ChatHistoryMessage[],
    incoming: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    const next = [...wasPrevious];
    const unmerged: ChatHistoryMessage[] = [];

    for (const message of incoming) {
        if (!message.toolResult) {
            const incomingToolCall = message.toolCalls?.[0];
            const match = incomingToolCall
                ? matchingToolCallUpdateIndex(next, incomingToolCall)
                : undefined;
            if (incomingToolCall && match) {
                const existing = next[match.messageIndex]!;
                const nextToolCalls = [...(existing.toolCalls || [])];
                const matchingToolCall = nextToolCalls[match.toolCallIndex]!;
                nextToolCalls[match.toolCallIndex] = {
                    ...matchingToolCall,
                    ...incomingToolCall,
                    id: incomingToolCall.id || matchingToolCall.id,
                    name: incomingToolCall.name || matchingToolCall.name,
                    toolResult: matchingToolCall.toolResult,
                };
                next[match.messageIndex] = {
                    ...existing,
                    toolCalls: nextToolCalls,
                };
                continue;
            }

            unmerged.push(message);
            continue;
        }

        const result = message.toolResult;
        const incomingToolCall = message.toolCalls?.[0];
        const match = matchingToolMessageIndex(next, result, incomingToolCall);

        if (match) {
            const existing = next[match.messageIndex]!;
            const nextToolCalls = [...(existing.toolCalls || [])];
            const matchingToolCall = nextToolCalls[match.toolCallIndex]!;
            const hasIncomingOutput = Boolean(
                result.content.length > 0 || result.images?.length
            );
            const toolResult =
                hasIncomingOutput || !matchingToolCall.toolResult
                    ? result
                    : matchingToolCall.toolResult;
            const mergedToolCall = incomingToolCall
                ? {
                      ...matchingToolCall,
                      ...incomingToolCall,
                  }
                : matchingToolCall;
            nextToolCalls[match.toolCallIndex] = {
                ...mergedToolCall,
                id: mergedToolCall.id || matchingToolCall.id,
                name: mergedToolCall.name || matchingToolCall.name,
                arguments: mergedToolCall.arguments ?? matchingToolCall.arguments,
                toolResult,
            };
            next[match.messageIndex] = {
                ...existing,
                toolCalls: nextToolCalls,
                toolResult:
                    existing.toolResult ||
                    (nextToolCalls.length === 1 ? toolResult : undefined),
            };
        } else {
            unmerged.push(message);
        }
    }

    return dedupeMessages([...next, ...unmerged]);
}
/** Returns a record nested in common runtime event fields. */
function nestedRuntimeRecord(data: Record<string, unknown>): Record<string, unknown> {
    for (const key of ["item", "payload", "message"]) {
        const nested = data[key];
        if (isRecord(nested)) {
            return nested;
        }
    }

    return data;
}

/** Returns string fields from an item and its common wrapper fields. */
function runtimeItemStringValues(
    data: Record<string, unknown>,
    keys: string[]
): string[] {
    const item = nestedRuntimeRecord(data);
    const values: string[] = [];
    const sources = item === data ? [data] : [data, item];

    for (const source of sources) {
        for (const key of keys) {
            const value = rawStringValue(source[key]);
            if (value) {
                values.push(value);
            }
        }
    }

    return uniqueStrings(values);
}

/** Returns text from string fields or block arrays in common runtime wrappers. */
function runtimeItemTextValues(data: Record<string, unknown>, keys: string[]): string[] {
    const item = nestedRuntimeRecord(data);
    const values: string[] = [];
    const sources = item === data ? [data] : [data, item];

    for (const source of sources) {
        for (const key of keys) {
            const rawValue = source[key];
            const value = rawStringValue(rawValue);
            if (value) {
                values.push(value);
            } else if (Array.isArray(rawValue)) {
                const text = normalizeText(rawValue);
                if (text.trim()) {
                    values.push(text);
                }
            }
        }
    }

    return uniqueStrings(values);
}

/** Returns text carried by a reasoning item event. */
function runtimeReasoningItemText(data: Record<string, unknown>): string | undefined {
    return runtimeItemTextValues(data, [
        "progressText",
        "summary",
        "text",
        "delta",
        "meta",
        "content",
    ]).find((value) => value.length > 0);
}

/** Returns whether an item-like payload represents a tool call. */
function isRuntimeToolCallItem(data: Record<string, unknown>): boolean {
    const type = stringValue(data.type)?.toLowerCase();
    return Boolean(
        type &&
        [
            "custom_tool_call",
            "function_call",
            "tool_call",
            "toolcall",
            "tool_use",
        ].includes(type)
    );
}

/** Returns whether an item-like payload represents a tool result. */
function isRuntimeToolOutputItem(data: Record<string, unknown>): boolean {
    const type = stringValue(data.type)?.toLowerCase();
    return Boolean(
        type &&
        [
            "custom_tool_call_output",
            "function_call_output",
            "tool_call_output",
            "tool_result",
            "toolresult",
        ].includes(type)
    );
}

/** Builds transient chat rows for OpenAI/Codex response item tool events. */
function runtimeItemToolMessages(
    data: Record<string, unknown>,
    runId?: string
): ChatHistoryMessage[] {
    const item = nestedRuntimeRecord(data);
    if (!isRuntimeToolCallItem(item) && !isRuntimeToolOutputItem(item)) {
        return [];
    }

    const normalized = {
        ...item,
        args: item.args ?? item.arguments ?? item.input,
        id: item.call_id ?? item.callId ?? item.toolCallId ?? item.id,
        name: item.name ?? item.toolName,
        phase: isRuntimeToolOutputItem(item) ? "result" : (data.phase ?? item.phase),
        result: item.output ?? item.result ?? item.content ?? item.text,
    };
    return runtimeToolMessages(normalized, runId);
}

/** Returns whether an item event is Codex preamble/status text. */
function isRuntimePreambleItem(data: Record<string, unknown>): boolean {
    const markers = runtimeItemStringValues(data, ["kind", "type", "title", "name"]).map(
        (value) => value.toLowerCase()
    );

    return markers.includes("preamble");
}

/** Returns whether an item event marks model reasoning/thinking activity. */
function isRuntimeReasoningMarkerItem(data: Record<string, unknown>): boolean {
    const markers = runtimeItemStringValues(data, [
        "itemId",
        "itemKind",
        "kind",
        "type",
        "title",
        "name",
        "role",
        "stream",
    ]);
    const markerText = markers.join(" ").toLowerCase();
    const hasReasoningMarker =
        /\b(reasoning|reason|thinking|analysis)\b/.test(markerText) ||
        markerText.includes("reasoning");

    return hasReasoningMarker;
}

/** Returns whether an item event belongs in the thinking/reasoning bubble. */
function isRuntimeThinkingItem(data: Record<string, unknown>): boolean {
    return isRuntimePreambleItem(data) || isRuntimeReasoningMarkerItem(data);
}

/** Builds a thinking message from reasoning item events. */
function runtimeReasoningItemMessage(
    payload: Record<string, unknown>,
    data: Record<string, unknown>
): ChatHistoryMessage | undefined {
    if (!isRuntimeThinkingItem(data)) {
        return undefined;
    }

    const text = runtimeReasoningItemText(data) || "";
    if (text.length === 0) {
        return undefined;
    }
    const thinkingId = runtimeItemStringValues(data, ["itemId", "id"]).at(0);

    return {
        role: "assistant",
        content: [{ id: thinkingId, text, type: "thinking" }],
        text: "",
        images: [],
        attachments: [],
        thinking: [{ id: thinkingId, text }],
        timestamp: currentIsoString(),
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
    };
}

/** Builds an active stream message from runtime text streams. */
function runtimeStreamMessage(
    stream: string,
    payload: Record<string, unknown>,
    data: Record<string, unknown>
): ChatHistoryMessage | undefined {
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    const text =
        rawStringValue(data.delta) ||
        rawStringValue(data.text) ||
        rawStringValue(data.deltaText) ||
        rawStringValue(data.summary) ||
        rawStringValue(data.content) ||
        "";

    if (stream === "assistant") {
        if (text.length === 0) {
            return undefined;
        }

        return {
            role: "assistant",
            content: text,
            text,
            images: [],
            attachments: [],
            timestamp: currentIsoString(),
            runId,
        };
    }

    if (isRuntimeThinkingStream(stream)) {
        if (text.length === 0) {
            return undefined;
        }

        return {
            role: "assistant",
            content: [{ text, type: "thinking" }],
            text: "",
            images: [],
            attachments: [],
            thinking: [{ text }],
            timestamp: currentIsoString(),
            runId,
        };
    }

    return undefined;
}

/** Builds a transient assistant message for Gateway v4 session.message events. */
function runtimeSessionMessage(
    payload: Record<string, unknown>
): ChatHistoryMessage | undefined {
    const message = normalizeAssistantPayload(
        payload.message ?? payload.content ?? payload.deltaText ?? payload.text
    );

    if (message.role.toLowerCase() !== "assistant") {
        return undefined;
    }

    return {
        ...message,
        timestamp: currentIsoString(),
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
    };
}

/** Returns whether a transcript message should occupy active stream state. */
function hasActiveStreamContent(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.text.length > 0 ||
        message.thinking?.length ||
        message.toolCalls?.length ||
        message.images?.length ||
        message.attachments?.length
    );
}

/** Represents use chat runtime events paramilliseconds. */
interface UseChatRuntimeEventsParameters {
    connectionId: number;
    isConnected: boolean;
    request: <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>
    ) => Promise<T>;
    subscribe: (listener: (data: unknown) => void) => () => void;
    selectedSessionKey: string;
    showThinkingOutput: boolean;
    showToolOutput: boolean;
    activeStreamsReference: MutableReference<ActiveChatStreams>;
    liveHistoryRefreshTimerReference: MutableReference<TimerHandle | undefined>;
    shouldStickToBottomReference: MutableReference<boolean>;
    updateActiveStreams: (
        updater: (wasPrevious: ActiveChatStreams) => ActiveChatStreams
    ) => void;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    setHistoryLoadVersion: Dispatch<SetStateAction<number>>;
}

/** Provides chat runtime events. */
export function useChatRuntimeEvents({
    connectionId,
    isConnected,
    request,
    subscribe,
    selectedSessionKey,
    showThinkingOutput,
    showToolOutput,
    activeStreamsReference,
    liveHistoryRefreshTimerReference,
    shouldStickToBottomReference,
    updateActiveStreams,
    setMessages,
    setSendError,
    setIsAtBottom,
    setHistoryLoadVersion,
}: UseChatRuntimeEventsParameters) {
    const pendingDeltaUpdatesReference = useRef<Record<string, PendingDeltaUpdate>>({});
    const pendingDeltaFlushTimerReference = useRef<TimerHandle | undefined>(undefined);
    const selectedSessionKeyReference = useRef(selectedSessionKey);
    const updateActiveStreamsReference = useRef(updateActiveStreams);
    const requestReference = useRef(request);

    updateActiveStreamsReference.current = updateActiveStreams;
    requestReference.current = request;

    useEffect(() => {
        selectedSessionKeyReference.current = selectedSessionKey;
    }, [selectedSessionKey]);

    useEffect(() => {
        let isCancelled = false;

        /** Performs flush pending delta updates. */
        const flushPendingDeltaUpdates = () => {
            if (pendingDeltaFlushTimerReference.current !== undefined) {
                clearTimeout(pendingDeltaFlushTimerReference.current);
                pendingDeltaFlushTimerReference.current = undefined;
            }

            const pendingUpdates = pendingDeltaUpdatesReference.current;
            pendingDeltaUpdatesReference.current = {};

            if (Object.keys(pendingUpdates).length === 0) {
                return;
            }

            const next = { ...activeStreamsReference.current };

            for (const [streamSessionKey, pending] of Object.entries(pendingUpdates)) {
                const existing = next[streamSessionKey];
                const incomingRunId = pending.runId;
                const isStartsNewRun = isNewRunForStream(existing, incomingRunId);
                const runId = isStartsNewRun
                    ? incomingRunId
                    : existing?.runId || incomingRunId;
                const promotesProvisionalRun =
                    isStartsNewRun &&
                    existing &&
                    isProvisionalRunId(streamSessionKey, existing.runId);
                let text =
                    isStartsNewRun && !promotesProvisionalRun ? "" : existing?.text || "";
                let message =
                    isStartsNewRun && !promotesProvisionalRun
                        ? undefined
                        : existing?.message;

                for (const deltaMessage of pending.deltas) {
                    text = mergeStreamText(text, deltaMessage.text);
                    message = mergeStreamMessage(message, deltaMessage, text, runId);
                }

                next[streamSessionKey] = {
                    sessionKey: streamSessionKey,
                    runId,
                    aliases: uniqueStrings([
                        ...(isStartsNewRun ? [] : existing?.aliases || []),
                        ...pending.aliases,
                        runId,
                    ]),
                    text,
                    message,
                    statusText: undefined,
                    updatedAt: currentIsoString(),
                };
            }

            activeStreamsReference.current = next;
            updateActiveStreamsReference.current(() => next);
        };

        /** Performs queue delta update. */
        const queueDeltaUpdate = (
            streamSessionKey: string,
            runId: string,
            deltaMessage: ChatHistoryMessage
        ) => {
            const existingPending =
                pendingDeltaUpdatesReference.current[streamSessionKey];
            const migratesProvisionalRun =
                existingPending &&
                isProvisionalRunId(streamSessionKey, existingPending.runId) &&
                !isProvisionalRunId(streamSessionKey, runId);
            const usesProvisionalFallback =
                existingPending && isProvisionalRunId(streamSessionKey, runId);

            if (migratesProvisionalRun) {
                existingPending.runId = runId;
            } else if (
                !usesProvisionalFallback &&
                isNewRunForStream(existingPending, runId)
            ) {
                flushPendingDeltaUpdates();
            }

            const pending = pendingDeltaUpdatesReference.current[streamSessionKey] || {
                aliases: [],
                deltas: [],
                runId,
            };

            pending.aliases = uniqueStrings([...pending.aliases, runId]);
            pending.deltas = [...pending.deltas, deltaMessage];
            pendingDeltaUpdatesReference.current[streamSessionKey] = pending;

            if (pendingDeltaFlushTimerReference.current === undefined) {
                pendingDeltaFlushTimerReference.current = setTimeout(
                    flushPendingDeltaUpdates,
                    75
                );
            }
        };

        /** Performs refresh selected history soon. */
        const refreshSelectedHistorySoon = (delayMs = 450) => {
            const sessionKeyAtCall = selectedSessionKey;
            if (liveHistoryRefreshTimerReference.current !== undefined) {
                clearTimeout(liveHistoryRefreshTimerReference.current);
            }

            liveHistoryRefreshTimerReference.current = setTimeout(async () => {
                liveHistoryRefreshTimerReference.current = undefined;

                if (isCancelled || !shouldStickToBottomReference.current) {
                    return;
                }

                try {
                    const result = await request<{ messages?: RawChatHistoryMessage[] }>(
                        "chat.history",
                        {
                            sessionKey: sessionKeyAtCall,
                            limit: CHAT_HISTORY_LIMIT,
                        }
                    );

                    const shouldApplyResult =
                        !isCancelled &&
                        isSameSessionKey(
                            sessionKeyAtCall,
                            selectedSessionKeyReference.current
                        );

                    if (shouldApplyResult) {
                        setMessages((wasPrevious) =>
                            mergeWithRecentOptimisticMessages(
                                wasPrevious,
                                visibleHistoryMessages(
                                    result.messages,
                                    createChatVisibility(
                                        showThinkingOutput,
                                        showToolOutput
                                    )
                                )
                            )
                        );

                        setIsAtBottom(shouldStickToBottomReference.current);
                        setHistoryLoadVersion((wasPrevious) => wasPrevious + 1);
                    }
                } catch {
                    // Keep existing live state if an opportunistic refresh fails.
                }
            }, delayMs);
        };

        /** Clears active streams belonging to a finished chat run. */
        const clearActiveStreamsForRun = (sessionKey: string, runId?: string) => {
            updateActiveStreamsReference.current((wasPrevious) => {
                const next = { ...wasPrevious };
                for (const [key, streamEntry] of Object.entries(wasPrevious)) {
                    if (!isSameSessionKey(streamEntry.sessionKey, sessionKey)) {
                        continue;
                    }

                    if (
                        runId &&
                        streamEntry.runId !== runId &&
                        !streamEntry.aliases.includes(runId) &&
                        !isProvisionalRunId(sessionKey, streamEntry.runId)
                    ) {
                        continue;
                    }

                    delete next[key];
                }
                return next;
            });
        };

        /** Returns buffered assistant text from base or per-stream runtime rows. */
        const activeAssistantTextForRun = (
            sessionKey: string,
            runId?: string
        ): string => {
            const matchingTexts = Object.values(activeStreamsReference.current)
                .filter((streamEntry) => {
                    if (!isSameSessionKey(streamEntry.sessionKey, sessionKey)) {
                        return false;
                    }

                    if (!runId) {
                        return true;
                    }

                    return (
                        streamEntry.runId === runId ||
                        streamEntry.aliases.includes(runId) ||
                        isProvisionalRunId(sessionKey, streamEntry.runId)
                    );
                })
                .map((streamEntry) => streamEntry.text)
                .filter((text) => text.trim());

            const completeTexts = uniqueStrings(matchingTexts).filter(
                (text, _index, texts) =>
                    texts.every(
                        (candidate) => candidate === text || !candidate.includes(text)
                    )
            );

            return completeTexts.join("");
        };

        /** Returns renderable non-text diagnostics from active stream rows. */
        const activeDiagnosticMessagesForRun = (
            sessionKey: string,
            runId?: string
        ): ChatHistoryMessage[] => {
            const visibility = createChatVisibility(showThinkingOutput, showToolOutput);
            return Object.values(activeStreamsReference.current)
                .filter((streamEntry) => {
                    if (!isSameSessionKey(streamEntry.sessionKey, sessionKey)) {
                        return false;
                    }

                    if (!runId) {
                        return true;
                    }

                    return (
                        streamEntry.runId === runId ||
                        streamEntry.aliases.includes(runId) ||
                        isProvisionalRunId(sessionKey, streamEntry.runId)
                    );
                })
                .map((streamEntry) => streamEntry.message)
                .filter((message): message is ChatHistoryMessage =>
                    Boolean(
                        message &&
                        !message.text.trim() &&
                        ((message.thinking?.length || 0) > 0 ||
                            (message.toolCalls?.length || 0) > 0 ||
                            message.toolResult) &&
                        isRenderableChatHistoryMessage(message, visibility)
                    )
                );
        };

        /** Responds to runtime transcript event events. */
        const handleRuntimeTranscriptEvent = (
            eventName: string | undefined,
            payload: unknown
        ) => {
            if (!eventName || !selectedSessionKey || !isRecord(payload)) {
                return;
            }

            const eventSessionKey =
                typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
            const eventRunId =
                typeof payload.runId === "string" ? payload.runId : undefined;
            const streamForRun = eventRunId
                ? Object.values(activeStreamsReference.current).find(
                      (stream) =>
                          stream.runId === eventRunId ||
                          stream.aliases.includes(eventRunId)
                  )
                : undefined;
            const eventMatchesSelected = isSameSessionKey(
                eventSessionKey || streamForRun?.sessionKey,
                selectedSessionKey
            );

            if (!eventMatchesSelected) {
                return;
            }

            const stream = normalizeRuntimeStream(payload.stream);
            const data = isRecord(payload.data) ? payload.data : {};
            const phase = typeof data.phase === "string" ? data.phase : "";
            const isWholeRunTerminalEvent =
                (stream === "lifecycle" && TERMINAL_LIFECYCLE_PHASES.has(phase)) ||
                TERMINAL_RUNTIME_EVENTS.has(eventName);
            const isChannelTerminalEvent =
                (stream === "assistant" || isRuntimeThinkingStream(stream)) &&
                TERMINAL_LIFECYCLE_PHASES.has(phase);

            if (isChannelTerminalEvent && !isWholeRunTerminalEvent) {
                flushPendingDeltaUpdates();
                const bufferedText =
                    stream === "assistant"
                        ? activeAssistantTextForRun(selectedSessionKey, eventRunId)
                        : "";
                const diagnosticMessages =
                    stream === "assistant"
                        ? []
                        : activeDiagnosticMessagesForRun(selectedSessionKey, eventRunId);
                const messagesToAppend: ChatHistoryMessage[] = [
                    ...(bufferedText.trim()
                        ? [
                              {
                                  role: "assistant" as const,
                                  content: bufferedText,
                                  text: bufferedText,
                                  images: [],
                                  attachments: [],
                                  timestamp: currentIsoString(),
                                  runId: eventRunId,
                              },
                          ]
                        : []),
                    ...diagnosticMessages,
                ];
                if (messagesToAppend.length > 0) {
                    setMessages((wasPrevious) =>
                        dedupeMessages([...wasPrevious, ...messagesToAppend])
                    );
                }
                updateActiveStreamsReference.current((wasPrevious) => {
                    const next = { ...wasPrevious };
                    for (const [key, streamEntry] of Object.entries(wasPrevious)) {
                        if (
                            !isSameSessionKey(streamEntry.sessionKey, selectedSessionKey)
                        ) {
                            continue;
                        }

                        if (
                            eventRunId &&
                            streamEntry.runId !== eventRunId &&
                            !streamEntry.aliases.includes(eventRunId) &&
                            !isProvisionalRunId(selectedSessionKey, streamEntry.runId)
                        ) {
                            continue;
                        }

                        if (key.endsWith(`::${stream}`)) {
                            delete next[key];
                        }
                    }
                    return next;
                });
                refreshSelectedHistorySoon(150);
                return;
            }

            if (isWholeRunTerminalEvent) {
                flushPendingDeltaUpdates();
                const bufferedText = activeAssistantTextForRun(
                    selectedSessionKey,
                    eventRunId
                );
                const diagnosticMessages = activeDiagnosticMessagesForRun(
                    selectedSessionKey,
                    eventRunId
                );
                const messagesToAppend: ChatHistoryMessage[] = [
                    ...(bufferedText.trim()
                        ? [
                              {
                                  role: "assistant" as const,
                                  content: bufferedText,
                                  text: bufferedText,
                                  images: [],
                                  attachments: [],
                                  timestamp: currentIsoString(),
                                  runId: eventRunId,
                              },
                          ]
                        : []),
                    ...diagnosticMessages,
                ];
                if (messagesToAppend.length > 0) {
                    setMessages((wasPrevious) =>
                        dedupeMessages([...wasPrevious, ...messagesToAppend])
                    );
                }
                updateActiveStreamsReference.current((wasPrevious) => {
                    const next = { ...wasPrevious };
                    for (const [key, streamEntry] of Object.entries(wasPrevious)) {
                        if (
                            !isSameSessionKey(streamEntry.sessionKey, selectedSessionKey)
                        ) {
                            continue;
                        }

                        if (
                            eventRunId &&
                            streamEntry.runId !== eventRunId &&
                            !streamEntry.aliases.includes(eventRunId) &&
                            !isProvisionalRunId(selectedSessionKey, streamEntry.runId)
                        ) {
                            continue;
                        }

                        delete next[key];
                    }
                    return next;
                });
                refreshSelectedHistorySoon(150);
                return;
            }

            if ((eventName === "session.tool" || stream === "tool") && showToolOutput) {
                const toolMessages = runtimeToolMessages(data, eventRunId);
                if (toolMessages.length > 0) {
                    setMessages((wasPrevious) =>
                        mergeRuntimeToolMessages(wasPrevious, toolMessages)
                    );
                }
            }

            if (stream === "item" && showToolOutput) {
                const toolMessages = runtimeItemToolMessages(data, eventRunId);
                if (toolMessages.length > 0) {
                    setMessages((wasPrevious) =>
                        mergeRuntimeToolMessages(wasPrevious, toolMessages)
                    );
                }
            }

            const statusText = runtimeProgressText(eventName, stream, phase, data);
            const shouldTrackActivity = isRuntimeWorkEvent(
                eventName,
                stream,
                phase,
                statusText
            );
            const runtimeMessage =
                eventName === "session.message"
                    ? runtimeSessionMessage(payload)
                    : stream === "assistant" || isRuntimeThinkingStream(stream)
                      ? runtimeStreamMessage(stream, payload, data)
                      : stream === "item"
                        ? runtimeReasoningItemMessage(payload, data)
                        : undefined;
            const shouldApplyRuntimeMessage = runtimeMessage
                ? hasActiveStreamContent(runtimeMessage)
                : false;
            const runtimeMessageToApply = shouldApplyRuntimeMessage
                ? runtimeMessage
                : undefined;
            const isRuntimeMessageRenderable = runtimeMessageToApply
                ? isRenderableChatHistoryMessage(
                      runtimeMessageToApply,
                      createChatVisibility(showThinkingOutput, showToolOutput)
                  )
                : false;

            if (runtimeMessage && !runtimeMessageToApply) {
                flushPendingDeltaUpdates();
                updateActiveStreamsReference.current((wasPrevious) => {
                    const streamKey =
                        stream === "assistant" || isRuntimeThinkingStream(stream)
                            ? runtimeWorkStreamKey(
                                  selectedSessionKey,
                                  stream,
                                  eventName,
                                  eventRunId
                              )
                            : selectedSessionKey;
                    const fallbackStreamKey =
                        eventRunId &&
                        (stream === "assistant" || isRuntimeThinkingStream(stream))
                            ? runtimeWorkStreamKey(selectedSessionKey, stream, eventName)
                            : streamKey;
                    const fallbackExisting =
                        fallbackStreamKey === streamKey
                            ? undefined
                            : wasPrevious[fallbackStreamKey];
                    const existing = wasPrevious[streamKey] || fallbackExisting;
                    const incomingRunId = eventRunId;
                    if (
                        !existing ||
                        (incomingRunId &&
                            existing.runId !== incomingRunId &&
                            !existing.aliases.includes(incomingRunId))
                    ) {
                        return wasPrevious;
                    }

                    const next = { ...wasPrevious };
                    delete next[streamKey];
                    if (fallbackStreamKey !== streamKey) {
                        delete next[fallbackStreamKey];
                    }
                    return next;
                });
            }

            if (shouldTrackActivity || runtimeMessageToApply) {
                if (runtimeMessageToApply) {
                    flushPendingDeltaUpdates();
                }

                updateActiveStreamsReference.current((wasPrevious) => {
                    const streamChannel =
                        stream === "item" && isRuntimeThinkingItem(data)
                            ? "reasoning"
                            : stream;
                    const streamKey =
                        runtimeMessageToApply &&
                        (stream === "assistant" ||
                            isRuntimeThinkingStream(stream) ||
                            (stream === "item" && isRuntimeThinkingItem(data)))
                            ? runtimeWorkStreamKey(
                                  selectedSessionKey,
                                  streamChannel,
                                  eventName,
                                  eventRunId
                              )
                            : runtimeMessageToApply
                              ? selectedSessionKey
                              : runtimeWorkStreamKey(
                                    selectedSessionKey,
                                    streamChannel,
                                    eventName,
                                    eventRunId
                                );
                    const fallbackStreamKey =
                        eventRunId && streamKey !== selectedSessionKey
                            ? runtimeWorkStreamKey(
                                  selectedSessionKey,
                                  streamChannel,
                                  eventName
                              )
                            : streamKey;
                    const fallbackExisting =
                        fallbackStreamKey === streamKey
                            ? undefined
                            : wasPrevious[fallbackStreamKey];
                    const existing = wasPrevious[streamKey] || fallbackExisting;
                    const incomingRunId =
                        eventRunId || existing?.runId || selectedSessionKey;
                    const isStartsNewRun = isNewRunForStream(existing, eventRunId);
                    const promotesProvisionalRun =
                        isStartsNewRun &&
                        existing &&
                        isProvisionalRunId(selectedSessionKey, existing.runId);
                    const runId = isStartsNewRun
                        ? incomingRunId
                        : existing?.runId || incomingRunId;
                    const text = runtimeMessageToApply
                        ? mergeStreamText(
                              isStartsNewRun && !promotesProvisionalRun
                                  ? ""
                                  : existing?.text || "",
                              runtimeMessageToApply.text
                          )
                        : isStartsNewRun
                          ? ""
                          : existing?.text || "";
                    const nextStatusText =
                        runtimeMessageToApply && isRuntimeMessageRenderable
                            ? undefined
                            : shouldTrackActivity || runtimeMessageToApply
                              ? statusText ||
                                (isStartsNewRun && !promotesProvisionalRun
                                    ? undefined
                                    : existing?.statusText) ||
                                "Thinking"
                              : statusText;
                    const next = { ...wasPrevious };
                    if (fallbackStreamKey !== streamKey) {
                        delete next[fallbackStreamKey];
                    }

                    return {
                        ...next,
                        [streamKey]: {
                            sessionKey: selectedSessionKey,
                            runId,
                            aliases: uniqueStrings([
                                ...(isStartsNewRun && !promotesProvisionalRun
                                    ? []
                                    : existing?.aliases || []),
                                eventRunId,
                                runId,
                            ]),
                            text,
                            message: runtimeMessageToApply
                                ? mergeStreamMessage(
                                      isStartsNewRun && !promotesProvisionalRun
                                          ? undefined
                                          : existing?.message,
                                      runtimeMessageToApply,
                                      text,
                                      runId
                                  )
                                : isStartsNewRun
                                  ? undefined
                                  : existing?.message,
                            statusText: nextStatusText,
                            updatedAt: currentIsoString(),
                        },
                    };
                });
            }

            if (
                showThinkingOutput ||
                (eventName !== "session.tool" && showToolOutput) ||
                stream === "item"
            ) {
                refreshSelectedHistorySoon(500);
            }
        };

        const unsubscribe = subscribe((raw) => {
            const data = raw as {
                type?: string;
                event?: string;
                payload?: unknown;
            };

            if (data.type !== "event") {
                return;
            }

            if (data.event !== "chat") {
                handleRuntimeTranscriptEvent(data.event, data.payload);
                return;
            }

            const payload = data.payload as ChatStreamEventMessage | undefined;
            if (!payload) {
                return;
            }

            const streams = activeStreamsReference.current;
            const streamForRun = payload.runId
                ? Object.values(streams).find(
                      (stream) =>
                          stream.runId === payload.runId ||
                          stream.aliases.includes(payload.runId as string)
                  )
                : undefined;
            const eventSessionKey = payload.sessionKey || streamForRun?.sessionKey;

            if (!eventSessionKey) {
                return;
            }

            const eventMatchesSelected = isSameSessionKey(
                eventSessionKey,
                selectedSessionKey
            );
            const isRelevantEvent = eventMatchesSelected || Boolean(streamForRun);
            if (!isRelevantEvent) {
                return;
            }

            const streamSessionKey = eventMatchesSelected
                ? selectedSessionKey
                : streamForRun!.sessionKey;
            const selectedStream = eventMatchesSelected
                ? streams[selectedSessionKey]
                : undefined;
            const selectedStreamRunIds = uniqueStrings([
                selectedStream?.runId,
                ...(selectedStream?.aliases || []),
            ]);
            const isStaleSelectedTerminalEvent =
                eventMatchesSelected &&
                selectedStream &&
                !streamForRun &&
                payload.runId &&
                TERMINAL_CHAT_STATES.has(payload.state || "") &&
                !selectedStreamRunIds.includes(payload.runId) &&
                !isOptimisticRunId(selectedStream.runId);
            if (isStaleSelectedTerminalEvent) {
                return;
            }

            if (payload.state === "delta") {
                const deltaMessage = normalizeAssistantPayload(
                    payload.message ??
                        payload.deltaText ??
                        payload.delta ??
                        payload.content ??
                        payload.text
                );
                const nextText = deltaMessage.text;

                if (
                    nextText.trim() ||
                    deltaMessage.thinking?.length ||
                    deltaMessage.toolCalls?.length
                ) {
                    const existing = activeStreamsReference.current[streamSessionKey];
                    const runId = payload.runId || existing?.runId || streamSessionKey;
                    if (
                        payload.replace === true &&
                        payload.message === undefined &&
                        typeof payload.deltaText === "string"
                    ) {
                        delete pendingDeltaUpdatesReference.current[streamSessionKey];
                        if (
                            pendingDeltaFlushTimerReference.current !== undefined &&
                            Object.keys(pendingDeltaUpdatesReference.current).length === 0
                        ) {
                            clearTimeout(pendingDeltaFlushTimerReference.current);
                            pendingDeltaFlushTimerReference.current = undefined;
                        }

                        const message = mergeStreamMessage(
                            undefined,
                            deltaMessage,
                            nextText,
                            runId
                        );
                        const isStartsNewRun = isNewRunForStream(existing, payload.runId);
                        updateActiveStreamsReference.current((wasPrevious) => ({
                            ...wasPrevious,
                            [streamSessionKey]: {
                                sessionKey: streamSessionKey,
                                runId,
                                aliases: uniqueStrings([
                                    ...(isStartsNewRun ? [] : existing?.aliases || []),
                                    payload.runId,
                                    runId,
                                ]),
                                text: nextText,
                                message,
                                updatedAt: currentIsoString(),
                            },
                        }));
                        return;
                    }
                    queueDeltaUpdate(streamSessionKey, runId, deltaMessage);
                }
                return;
            }

            /** Performs refresh history after terminal event. */
            const refreshHistoryAfterTerminalEvent = (sessionKey: string) => {
                setTimeout(async () => {
                    if (isCancelled || !shouldStickToBottomReference.current) {
                        return;
                    }

                    try {
                        const result = await request<{
                            messages?: RawChatHistoryMessage[];
                        }>("chat.history", {
                            sessionKey,
                            limit: CHAT_HISTORY_LIMIT,
                        });

                        const shouldApplyResult =
                            !isCancelled &&
                            isSameSessionKey(
                                sessionKey,
                                selectedSessionKeyReference.current
                            );

                        if (shouldApplyResult) {
                            setMessages((wasPrevious) =>
                                mergeWithRecentOptimisticMessages(
                                    wasPrevious,
                                    visibleHistoryMessages(
                                        result.messages,
                                        createChatVisibility(
                                            showThinkingOutput,
                                            showToolOutput
                                        )
                                    )
                                )
                            );
                            setIsAtBottom(shouldStickToBottomReference.current);
                            setHistoryLoadVersion((wasPrevious) => wasPrevious + 1);
                        }
                    } catch {
                        // Keep local stream/final state if history refresh is unavailable.
                    }
                }, 500);
            };

            if (payload.state === "final") {
                flushPendingDeltaUpdates();
                const finalMessage = finalMessageFromPayload(payload);
                const bufferedText = activeAssistantTextForRun(
                    streamSessionKey,
                    payload.runId
                );
                const messageToAppend = isCommandMessagePayload(payload.message)
                    ? createLocalSystemMessage(finalMessage.text)
                    : isRenderableChatHistoryMessage(
                            finalMessage,
                            createChatVisibility(showThinkingOutput, showToolOutput)
                        )
                      ? finalMessage
                      : bufferedText.trim()
                        ? {
                              role: "assistant",
                              content: bufferedText,
                              text: bufferedText,
                              images: [],
                              attachments: [],
                              timestamp: currentIsoString(),
                              runId: payload.runId,
                          }
                        : undefined;

                if (messageToAppend && eventMatchesSelected) {
                    setMessages((wasPrevious) =>
                        dedupeMessages([...wasPrevious, messageToAppend])
                    );
                }

                clearActiveStreamsForRun(streamSessionKey, payload.runId);
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "aborted") {
                flushPendingDeltaUpdates();
                const bufferedText = activeAssistantTextForRun(
                    streamSessionKey,
                    payload.runId
                );
                if (bufferedText.trim() && eventMatchesSelected) {
                    setMessages((wasPrevious) =>
                        dedupeMessages([
                            ...wasPrevious,
                            {
                                role: "assistant",
                                content: bufferedText,
                                text: bufferedText,
                                images: [],
                                attachments: [],
                                timestamp: currentIsoString(),
                                runId: payload.runId,
                            },
                        ])
                    );
                }
                clearActiveStreamsForRun(streamSessionKey, payload.runId);
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "error") {
                flushPendingDeltaUpdates();
                if (eventMatchesSelected) {
                    setSendError(payload.errorMessage || "Chat request failed");
                }
                clearActiveStreamsForRun(streamSessionKey, payload.runId);
            }
        });

        return () => {
            isCancelled = true;
            flushPendingDeltaUpdates();
            unsubscribe();
            if (liveHistoryRefreshTimerReference.current !== undefined) {
                clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = undefined;
            }
            pendingDeltaUpdatesReference.current = {};
        };
    }, [
        activeStreamsReference,
        liveHistoryRefreshTimerReference,
        selectedSessionKey,
        setHistoryLoadVersion,
        setIsAtBottom,
        setMessages,
        setSendError,
        shouldStickToBottomReference,
        showThinkingOutput,
        showToolOutput,
        subscribe,
    ]);

    useEffect(() => {
        if (!isConnected || !selectedSessionKey) {
            return;
        }

        const requestForSubscription = requestReference.current;

        /** Ignores optional Gateway transcript subscription failures. */
        function ignoreTranscriptSubscriptionError(): void {
            // Older gateways or narrow tokens may not expose transcript subscriptions.
        }

        void (async () => {
            try {
                await requestForSubscription("sessions.messages.subscribe", {
                    key: selectedSessionKey,
                });
            } catch {
                ignoreTranscriptSubscriptionError();
            }
        })();

        /** Unsubscribes from selected session transcript messages. */
        function unsubscribeTranscriptMessages(): void {
            void (async () => {
                try {
                    await requestForSubscription("sessions.messages.unsubscribe", {
                        key: selectedSessionKey,
                    });
                } catch {
                    ignoreTranscriptSubscriptionError();
                }
            })();
        }

        return unsubscribeTranscriptMessages;
    }, [connectionId, isConnected, selectedSessionKey]);
}
