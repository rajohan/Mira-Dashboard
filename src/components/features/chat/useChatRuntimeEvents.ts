import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import {
    type ActiveChatStreams,
    createChatVisibility,
    createLocalSystemMessage,
    finalMessageFromPayload,
    isRecord,
    isSameSessionKey,
    mergeStreamMessage,
    mergeStreamText,
    normalizeAssistantPayload,
    payloadIsCommandMessage,
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
} from "./chatUtils";

/** Represents mutable reference. */
interface MutableReference<T> {
    current: T;
}

/** Represents pending delta update. */
interface PendingDeltaUpdate {
    runId?: string;
    aliases: string[];
    deltas: ChatHistoryMessage[];
}

const TERMINAL_LIFECYCLE_PHASES = new Set(["end", "error"]);
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
        .replaceAll("_", " ")
        .replaceAll("-", " ")
        .replaceAll(/\s+/g, " ")
        .trim();

    return normalized
        ? `${normalized[0].toUpperCase()}${normalized.slice(1)}`
        : normalized;
}

/** Performs detail from args. */
export function detailFromArgs(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return stringValue(value);
    }

    const keys = [
        "command",
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
export function normalizeRuntimeStream(value: string): string {
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
        const toolName = stringValue(data.name) || "tool";
        if (isNonWorkToolName(toolName)) {
            return undefined;
        }

        const detail =
            detailFromArgs(data.args) ||
            stringValue(data.title) ||
            stringValue(data.summary) ||
            stringValue(data.progressText);
        return compactStatusText(
            detail ? `${formatToolName(toolName)}: ${detail}` : formatToolName(toolName)
        );
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
    existing: { runId?: string; aliases?: string[] } | undefined,
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
    return (
        Boolean(statusText) ||
        eventName === "session.tool" ||
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
        return normalizeText(value);
    }

    if (value === undefined || value === null) {
        return "";
    }

    try {
        return JSON.stringify(value, null, 2);
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
    const args = data.args ?? data.arguments ?? data.input;
    const result = data.result ?? data.output ?? data.content ?? data.text ?? data.error;
    const phase = stringValue(data.phase);
    const hasResult =
        phase === "result" ||
        phase === "end" ||
        phase === "error" ||
        result !== undefined;

    const timestamp = new Date().toISOString();
    const messages: ChatHistoryMessage[] = [];

    if (args !== undefined || !hasResult) {
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
                    arguments: args,
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
            timestamp: new Date(Date.now() + messages.length).toISOString(),
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
        timestamp: new Date().toISOString(),
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
    };
}

/** Represents use chat runtime events paramilliseconds. */
interface UseChatRuntimeEventsParams {
    connectionId: number;
    isConnected: boolean;
    request: <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ) => Promise<T>;
    subscribe: (listener: (data: unknown) => void) => () => void;
    selectedSessionKey: string;
    showThinkingOutput: boolean;
    showToolOutput: boolean;
    activeStreamsReference: MutableReference<ActiveChatStreams>;
    liveHistoryRefreshTimerReference: MutableReference<number | null>;
    shouldStickToBottomReference: MutableReference<boolean>;
    updateActiveStreams: (
        updater: (previous: ActiveChatStreams) => ActiveChatStreams
    ) => void;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setSendError: Dispatch<SetStateAction<string | null>>;
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
}: UseChatRuntimeEventsParams) {
    const pendingDeltaUpdatesReference = useRef<Record<string, PendingDeltaUpdate>>({});
    const pendingDeltaFlushTimerReference = useRef<number | null>(null);
    const updateActiveStreamsReference = useRef(updateActiveStreams);
    const requestReference = useRef(request);

    updateActiveStreamsReference.current = updateActiveStreams;
    requestReference.current = request;

    useEffect(() => {
        /** Performs flush pending delta updates. */
        const flushPendingDeltaUpdates = () => {
            if (pendingDeltaFlushTimerReference.current !== null) {
                window.clearTimeout(pendingDeltaFlushTimerReference.current);
                pendingDeltaFlushTimerReference.current = null;
            }

            const pendingUpdates = pendingDeltaUpdatesReference.current;
            pendingDeltaUpdatesReference.current = {};

            if (Object.keys(pendingUpdates).length === 0) {
                return;
            }

            const next = { ...activeStreamsReference.current };

            for (const [streamSessionKey, pending] of Object.entries(pendingUpdates)) {
                const existing = next[streamSessionKey];
                const incomingRunId = pending.runId || streamSessionKey;
                const startsNewRun = isNewRunForStream(existing, incomingRunId);
                const runId = startsNewRun
                    ? incomingRunId
                    : existing?.runId || incomingRunId;
                let text = startsNewRun ? "" : existing?.text || "";
                let message = startsNewRun ? undefined : existing?.message;

                for (const deltaMessage of pending.deltas) {
                    text = mergeStreamText(text, deltaMessage.text);
                    message = mergeStreamMessage(message, deltaMessage, text, runId);
                }

                next[streamSessionKey] = {
                    sessionKey: streamSessionKey,
                    runId,
                    aliases: uniqueStrings([
                        ...(startsNewRun ? [] : existing?.aliases || []),
                        ...pending.aliases,
                        runId,
                    ]),
                    text,
                    message,
                    statusText: text.trim()
                        ? undefined
                        : startsNewRun
                          ? undefined
                          : existing?.statusText,
                    updatedAt: new Date().toISOString(),
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
            const pending = pendingDeltaUpdatesReference.current[streamSessionKey] || {
                aliases: [],
                deltas: [],
            };

            pending.runId ||= runId;
            pending.aliases = uniqueStrings([...pending.aliases, runId]);
            pending.deltas = [...pending.deltas, deltaMessage];
            pendingDeltaUpdatesReference.current[streamSessionKey] = pending;

            if (pendingDeltaFlushTimerReference.current === null) {
                pendingDeltaFlushTimerReference.current = window.setTimeout(
                    flushPendingDeltaUpdates,
                    75
                );
            }
        };

        /** Performs refresh selected history soon. */
        const refreshSelectedHistorySoon = (delayMs = 450) => {
            if (!selectedSessionKey) {
                return;
            }

            if (liveHistoryRefreshTimerReference.current !== null) {
                window.clearTimeout(liveHistoryRefreshTimerReference.current);
            }

            liveHistoryRefreshTimerReference.current = window.setTimeout(async () => {
                liveHistoryRefreshTimerReference.current = null;

                if (!shouldStickToBottomReference.current) {
                    return;
                }

                try {
                    const result = await request<{ messages?: RawChatHistoryMessage[] }>(
                        "chat.history",
                        {
                            sessionKey: selectedSessionKey,
                            limit: CHAT_HISTORY_LIMIT,
                        }
                    );

                    setMessages((previous) =>
                        mergeWithRecentOptimisticMessages(
                            previous,
                            visibleHistoryMessages(
                                result.messages,
                                createChatVisibility(showThinkingOutput, showToolOutput)
                            )
                        )
                    );

                    if (shouldStickToBottomReference.current) {
                        setIsAtBottom(true);
                    }
                    setHistoryLoadVersion((previous) => previous + 1);
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

            const stream = normalizeRuntimeStream(
                typeof payload.stream === "string" ? payload.stream : ""
            );
            const data = isRecord(payload.data) ? payload.data : {};
            const phase = typeof data.phase === "string" ? data.phase : "";
            const isTerminalLifecycleEvent =
                stream === "lifecycle" && TERMINAL_LIFECYCLE_PHASES.has(phase);

            if (isTerminalLifecycleEvent) {
                updateActiveStreamsReference.current((previous) => {
                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
                refreshSelectedHistorySoon(150);
                return;
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

            if (eventName === "session.tool" && showToolOutput) {
                const toolMessages = runtimeToolMessages(data, eventRunId);
                if (toolMessages.length > 0) {
                    setMessages((previous) =>
                        dedupeMessages([...previous, ...toolMessages])
                    );
                }
            }

            if (shouldTrackActivity || runtimeMessage) {
                if (runtimeMessage) {
                    flushPendingDeltaUpdates();
                }

                updateActiveStreamsReference.current((previous) => {
                    const existing = previous[selectedSessionKey];
                    const incomingRunId =
                        eventRunId || existing?.runId || selectedSessionKey;
                    const startsNewRun = isNewRunForStream(existing, eventRunId);
                    const runId = startsNewRun
                        ? incomingRunId
                        : existing?.runId || incomingRunId;
                    const text = runtimeMessage
                        ? runtimeMessage.text
                        : startsNewRun
                          ? ""
                          : existing?.text || "";
                    const nextStatusText = shouldTrackActivity
                        ? statusText ||
                          (startsNewRun ? undefined : existing?.statusText) ||
                          "Thinking"
                        : statusText;
                    return {
                        ...previous,
                        [selectedSessionKey]: {
                            sessionKey: selectedSessionKey,
                            runId,
                            aliases: uniqueStrings([
                                ...(startsNewRun ? [] : existing?.aliases || []),
                                eventRunId,
                                runId,
                            ]),
                            text,
                            message: runtimeMessage
                                ? mergeStreamMessage(
                                      startsNewRun ? undefined : existing?.message,
                                      runtimeMessage,
                                      text,
                                      runId
                                  )
                                : startsNewRun
                                  ? undefined
                                  : existing?.message,
                            statusText: nextStatusText,
                            updatedAt: new Date().toISOString(),
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
                ? Object.values(streams).find((stream) =>
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
                : streamForRun?.sessionKey || eventSessionKey;

            /** Performs refresh history after terminal event. */
            const refreshHistoryAfterTerminalEvent = (sessionKey: string) => {
                window.setTimeout(async () => {
                    if (!shouldStickToBottomReference.current) {
                        return;
                    }

                    try {
                        const result = await request<{
                            messages?: RawChatHistoryMessage[];
                        }>("chat.history", {
                            sessionKey,
                            limit: CHAT_HISTORY_LIMIT,
                        });

                        if (sessionKey !== selectedSessionKey) {
                            return;
                        }

                        setMessages((previous) =>
                            mergeWithRecentOptimisticMessages(
                                previous,
                                visibleHistoryMessages(
                                    result.messages,
                                    createChatVisibility(
                                        showThinkingOutput,
                                        showToolOutput
                                    )
                                )
                            )
                        );
                        if (shouldStickToBottomReference.current) {
                            setIsAtBottom(true);
                        }
                        setHistoryLoadVersion((previous) => previous + 1);
                    } catch {
                        // Keep local stream/final state if history refresh is unavailable.
                    }
                }, 500);
            };

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
                            pendingDeltaFlushTimerReference.current !== null &&
                            Object.keys(pendingDeltaUpdatesReference.current).length === 0
                        ) {
                            window.clearTimeout(pendingDeltaFlushTimerReference.current);
                            pendingDeltaFlushTimerReference.current = null;
                        }

                        const message = mergeStreamMessage(
                            undefined,
                            deltaMessage,
                            nextText,
                            runId
                        );
                        updateActiveStreamsReference.current((previous) => ({
                            ...previous,
                            [streamSessionKey]: {
                                sessionKey: streamSessionKey,
                                runId,
                                aliases: uniqueStrings([
                                    ...(existing?.aliases || []),
                                    payload.runId,
                                    runId,
                                ]),
                                text: nextText,
                                message,
                                updatedAt: new Date().toISOString(),
                            },
                        }));
                        return;
                    }
                    queueDeltaUpdate(streamSessionKey, runId, deltaMessage);
                }
                return;
            }

            if (payload.state === "final") {
                flushPendingDeltaUpdates();
                const finalMessage = finalMessageFromPayload(payload);
                const bufferedText =
                    activeStreamsReference.current[streamSessionKey]?.text || "";
                const messageToAppend = payloadIsCommandMessage(payload.message)
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
                              timestamp: new Date().toISOString(),
                              runId: payload.runId,
                          }
                        : null;

                if (messageToAppend && eventMatchesSelected) {
                    setMessages((previous) =>
                        dedupeMessages([...previous, messageToAppend])
                    );
                }

                updateActiveStreamsReference.current((previous) => {
                    const next = { ...previous };
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
                    setMessages((previous) =>
                        dedupeMessages([
                            ...previous,
                            {
                                role: "assistant",
                                content: bufferedText,
                                text: bufferedText,
                                images: [],
                                attachments: [],
                                timestamp: new Date().toISOString(),
                                runId: payload.runId,
                            },
                        ])
                    );
                }
                updateActiveStreamsReference.current((previous) => {
                    const next = { ...previous };
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
                updateActiveStreamsReference.current((previous) => {
                    const next = { ...previous };
                    delete next[streamSessionKey];
                    return next;
                });
            }
        });

        return () => {
            flushPendingDeltaUpdates();
            unsubscribe();
            if (liveHistoryRefreshTimerReference.current !== null) {
                window.clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = null;
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

        void requestForSubscription("sessions.messages.subscribe", {
            key: selectedSessionKey,
        }).catch(() => {
            // Older gateways or narrow tokens may not expose transcript subscriptions.
        });

        return () => {
            void requestForSubscription("sessions.messages.unsubscribe", {
                key: selectedSessionKey,
            }).catch(() => {
                // The backend WebSocket teardown also drops Gateway-side subscriptions.
            });
        };
    }, [connectionId, isConnected, selectedSessionKey]);
}
