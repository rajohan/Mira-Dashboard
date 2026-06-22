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
const TERMINAL_CHAT_STATES = new Set(["aborted", "error", "final"]);
const WORK_STREAMS = new Set(["tool", "item", "plan", "approval", "patch", "compaction"]);
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

/** Returns whether a queued delta used its session key as a provisional run id. */
function isProvisionalRunId(streamSessionKey: string, runId: string): boolean {
    return runId === streamSessionKey;
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

    if (value === undefined || value === undefined) {
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

    if (arguments_ !== undefined || !hasResult) {
        messages.push({
            role: "assistant",
            content: "",
            text: "",
            images: [],
            attachments: [],
            toolCalls: [
                {
                    id,
                    name,
                    arguments: arguments_,
                },
            ],
            timestamp,
            local: true,
            runId,
        });
    }

    if (hasResult) {
        const content = runtimeDisplayText(result);
        messages.push({
            role: "tool",
            content,
            text: content,
            images: [],
            attachments: [],
            toolResult: {
                id,
                name,
                content,
                isError: phase === "error" || data.isError === true,
            },
            timestamp: isoStringFromDate(Date.now() + messages.length),
            local: true,
            runId,
        });
    }

    return messages;
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
        message.text.trim() ||
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
                ? Object.values(activeStreamsReference.current).find((stream) =>
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
            const isTerminalLifecycleEvent =
                stream === "lifecycle" && TERMINAL_LIFECYCLE_PHASES.has(phase);

            if (isTerminalLifecycleEvent) {
                flushPendingDeltaUpdates();
                updateActiveStreamsReference.current((wasPrevious) => {
                    const existing = wasPrevious[selectedSessionKey];
                    if (
                        !existing ||
                        (eventRunId &&
                            existing.runId !== eventRunId &&
                            !existing.aliases.includes(eventRunId))
                    ) {
                        return wasPrevious;
                    }

                    const next = { ...wasPrevious };
                    delete next[selectedSessionKey];
                    return next;
                });
                refreshSelectedHistorySoon(150);
                return;
            }

            if (eventName === "session.tool" && showToolOutput) {
                const toolMessages = runtimeToolMessages(data, eventRunId);
                if (toolMessages.length > 0) {
                    setMessages((wasPrevious) =>
                        dedupeMessages([...wasPrevious, ...toolMessages])
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
                    : undefined;
            const shouldApplyRuntimeMessage = runtimeMessage
                ? hasActiveStreamContent(runtimeMessage)
                : false;
            const runtimeMessageToApply = shouldApplyRuntimeMessage
                ? runtimeMessage
                : undefined;

            if (runtimeMessage && !runtimeMessageToApply) {
                flushPendingDeltaUpdates();
                updateActiveStreamsReference.current((wasPrevious) => {
                    const existing = wasPrevious[selectedSessionKey];
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
                    delete next[selectedSessionKey];
                    return next;
                });
            }

            if (shouldTrackActivity || runtimeMessageToApply) {
                if (runtimeMessageToApply) {
                    flushPendingDeltaUpdates();
                }

                updateActiveStreamsReference.current((wasPrevious) => {
                    const existing = wasPrevious[selectedSessionKey];
                    const incomingRunId =
                        eventRunId || existing?.runId || selectedSessionKey;
                    const isStartsNewRun = isNewRunForStream(existing, eventRunId);
                    const runId = isStartsNewRun
                        ? incomingRunId
                        : existing?.runId || incomingRunId;
                    const text = runtimeMessageToApply
                        ? runtimeMessageToApply.text
                        : isStartsNewRun
                          ? ""
                          : existing?.text || "";
                    const nextStatusText = shouldTrackActivity
                        ? statusText ||
                          (isStartsNewRun ? undefined : existing?.statusText) ||
                          "Thinking"
                        : statusText;
                    return {
                        ...wasPrevious,
                        [selectedSessionKey]: {
                            sessionKey: selectedSessionKey,
                            runId,
                            aliases: uniqueStrings([
                                ...(isStartsNewRun ? [] : existing?.aliases || []),
                                eventRunId,
                                runId,
                            ]),
                            text,
                            message: runtimeMessageToApply
                                ? mergeStreamMessage(
                                      isStartsNewRun ? undefined : existing?.message,
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
                payload.runId &&
                TERMINAL_CHAT_STATES.has(payload.state || "") &&
                !selectedStreamRunIds.includes(payload.runId);
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
                const bufferedText =
                    activeStreamsReference.current[streamSessionKey]?.text || "";
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

                updateActiveStreamsReference.current((wasPrevious) => {
                    const next = { ...wasPrevious };
                    delete next[streamSessionKey];
                    return next;
                });
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "aborted") {
                flushPendingDeltaUpdates();
                const bufferedText =
                    activeStreamsReference.current[streamSessionKey]?.text || "";
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
                updateActiveStreamsReference.current((wasPrevious) => {
                    const next = { ...wasPrevious };
                    delete next[streamSessionKey];
                    return next;
                });
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "error") {
                flushPendingDeltaUpdates();
                if (eventMatchesSelected) {
                    setSendError(payload.errorMessage || "Chat request failed");
                }
                updateActiveStreamsReference.current((wasPrevious) => {
                    const next = { ...wasPrevious };
                    delete next[streamSessionKey];
                    return next;
                });
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
