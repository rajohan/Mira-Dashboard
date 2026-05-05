import { type Dispatch, type SetStateAction, useEffect } from "react";

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
    type RawChatHistoryMessage,
} from "./chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    clearActiveRunMarker,
    dedupeMessages,
    markActiveRun,
    mergeWithRecentOptimisticMessages,
} from "./chatUtils";

interface MutableReference<T> {
    current: T;
}

interface UseChatRuntimeEventsParams {
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
    setIsAssistantTyping: Dispatch<SetStateAction<boolean>>;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    setHistoryLoadVersion: Dispatch<SetStateAction<number>>;
}

export function useChatRuntimeEvents({
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
    setIsAssistantTyping,
    setIsAtBottom,
    setHistoryLoadVersion,
}: UseChatRuntimeEventsParams) {
    useEffect(() => {
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

            const stream = typeof payload.stream === "string" ? payload.stream : "";
            const data = isRecord(payload.data) ? payload.data : {};
            const phase = typeof data.phase === "string" ? data.phase : "";
            const shouldRefreshDiagnostics =
                showThinkingOutput ||
                showToolOutput ||
                eventName === "session.tool" ||
                stream === "tool" ||
                stream === "item";

            if (!shouldRefreshDiagnostics) {
                return;
            }

            const isTerminalLifecycleEvent =
                stream === "lifecycle" && (phase === "end" || phase === "error");

            if (isTerminalLifecycleEvent) {
                setIsAssistantTyping(false);
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
                clearActiveRunMarker(selectedSessionKey);
            } else {
                setIsAssistantTyping(true);
                markActiveRun(selectedSessionKey);
            }

            if (eventRunId) {
                updateActiveStreams((previous) => {
                    const existing = previous[selectedSessionKey];
                    const runId = existing?.runId || eventRunId;
                    return {
                        ...previous,
                        [selectedSessionKey]: {
                            sessionKey: selectedSessionKey,
                            runId,
                            aliases: uniqueStrings([
                                ...(existing?.aliases || []),
                                eventRunId,
                                runId,
                            ]),
                            text: existing?.text || "",
                            message: existing?.message,
                            updatedAt: new Date().toISOString(),
                        },
                    };
                });
            }

            refreshSelectedHistorySoon(phase === "end" ? 150 : 500);
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
                    payload.message ?? payload.delta ?? payload.content ?? payload.text
                );
                const nextText = deltaMessage.text;
                if (eventMatchesSelected) {
                    setIsAssistantTyping(true);
                }
                markActiveRun(streamSessionKey);

                if (
                    nextText.trim() ||
                    deltaMessage.thinking?.length ||
                    deltaMessage.toolCalls?.length
                ) {
                    updateActiveStreams((previous) => {
                        const existing = previous[streamSessionKey];
                        const runId =
                            payload.runId || existing?.runId || streamSessionKey;
                        const text = mergeStreamText(existing?.text || "", nextText);
                        return {
                            ...previous,
                            [streamSessionKey]: {
                                sessionKey: streamSessionKey,
                                runId,
                                aliases: uniqueStrings([
                                    ...(existing?.aliases || []),
                                    payload.runId,
                                    runId,
                                ]),
                                text,
                                message: mergeStreamMessage(
                                    existing?.message,
                                    deltaMessage,
                                    text,
                                    runId
                                ),
                                updatedAt: new Date().toISOString(),
                            },
                        };
                    });
                }
                return;
            }

            if (payload.state === "final") {
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

                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[streamSessionKey];
                    return next;
                });
                if (eventMatchesSelected) {
                    setIsAssistantTyping(false);
                }
                clearActiveRunMarker(streamSessionKey);
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "aborted") {
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
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[streamSessionKey];
                    return next;
                });
                if (eventMatchesSelected) {
                    setIsAssistantTyping(false);
                }
                clearActiveRunMarker(streamSessionKey);
                refreshHistoryAfterTerminalEvent(streamSessionKey);
                return;
            }

            if (payload.state === "error") {
                if (eventMatchesSelected) {
                    setSendError(payload.errorMessage || "Chat request failed");
                }
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[streamSessionKey];
                    return next;
                });
                if (eventMatchesSelected) {
                    setIsAssistantTyping(false);
                }
                clearActiveRunMarker(streamSessionKey);
            }
        });

        return () => {
            unsubscribe();
            if (liveHistoryRefreshTimerReference.current !== null) {
                window.clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = null;
            }
        };
    }, [
        activeStreamsReference,
        liveHistoryRefreshTimerReference,
        request,
        selectedSessionKey,
        setHistoryLoadVersion,
        setIsAssistantTyping,
        setIsAtBottom,
        setMessages,
        setSendError,
        shouldStickToBottomReference,
        showThinkingOutput,
        showToolOutput,
        subscribe,
        updateActiveStreams,
    ]);
}
