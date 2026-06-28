import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { AttachmentPreviewModal } from "../components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "../components/features/chat/ChatComposer";
import { ChatHeader } from "../components/features/chat/ChatHeader";
import { ChatMessagesList } from "../components/features/chat/ChatMessagesList";
import {
    type ActiveChatStream,
    type ActiveChatStreams,
    createChatVisibility,
    hasRecoveredStreamHistory,
    isSameSessionKey,
    shouldShowStreamRow as shouldRenderStreamRow,
    uniqueStrings,
    visibleHistoryMessages,
} from "../components/features/chat/chatRuntime";
import {
    attachmentKind,
    type ChatHistoryMessage,
    type ChatPreviewItem,
    type ChatRow,
    type ChatSendAttachment,
    gatewayAttachments,
    isRenderableChatHistoryMessage,
    optimisticAttachmentDisplay,
    type RawChatHistoryMessage,
} from "../components/features/chat/chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    chatErrorMessage,
    type ChatModelOption,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    isRecoveredAssistantText,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    readFileAsDataUrl,
} from "../components/features/chat/chatUtilities";
import { buildSlashCommandSuggestions } from "../components/features/chat/slashCommands";
import { useChatRuntimeEvents } from "../components/features/chat/useChatRuntimeEvents";
import { useChatSlashCommands } from "../components/features/chat/useChatSlashCommands";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import type { Session } from "../types/session";
import { currentIsoString, timestampFromDateString } from "../utils/date";
import { formatSize } from "../utils/format";
import {
    formatSessionType,
    sortSessionsByTypeAndActivity,
} from "../utils/sessionUtilities";

const CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY =
    "mira-dashboard-chat-diagnostic-visibility";
const CHAT_BOTTOM_THRESHOLD_PX = 32;
const LIVE_HISTORY_POLL_MS = 2000;
const ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS = 120_000;
const NO_CHAT_SCROLL_ELEMENT = JSON.parse("null") as HTMLDivElement | null;

/** Returns visible text carried by active stream message details. */
export function activeStreamRenderableText(stream: ActiveChatStream): string {
    return uniqueStrings([
        stream.text,
        stream.message?.thinking?.map((block) => block.text).join("\n"),
        stream.message?.text,
    ])
        .filter(Boolean)
        .join("\n");
}

/** Returns whether an active stream is already represented in visible history. */
export function isActiveStreamRecoveredInMessages(
    stream: ActiveChatStream,
    visibleMessages: ChatHistoryMessage[],
    now = Date.now()
): boolean {
    const streamText = activeStreamRenderableText(stream);
    const streamUpdatedAt = sessionTimestampMs(stream.updatedAt);
    const isStreamQuiet =
        streamUpdatedAt === undefined ||
        now - streamUpdatedAt >= ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS;

    return Boolean(
        streamText.trim() &&
        visibleMessages.some((message) => {
            if (message.role.toLowerCase() !== "assistant") {
                return false;
            }

            if (message.text.trim() === streamText.trim()) {
                return true;
            }

            const thinkingText =
                message.thinking?.map((block) => block.text).join("\n") || "";
            if (thinkingText.trim() === streamText.trim()) {
                return true;
            }

            return (
                isStreamQuiet &&
                (isRecoveredAssistantText(message.text, streamText) ||
                    isRecoveredAssistantText(thinkingText, streamText))
            );
        })
    );
}

/** Normalizes chat agent IDs for case-insensitive session bucketing. */
function normalizeChatAgentId(agentId: string): string {
    return agentId.toLowerCase();
}

/** Returns the top-level chat agent bucket for a session. */
function getChatAgentId(session: Session): string {
    const sessionKey = typeof session.key === "string" ? session.key : "";
    const [scope = "", agentId] = sessionKey.split(":");

    if (scope.toLowerCase() === "agent" && agentId) {
        return normalizeChatAgentId(agentId);
    }

    return normalizeChatAgentId(session.agentType || session.type || "unknown");
}

/** Returns whether a live session has a usable key. */
function hasSessionKey(session: Session): boolean {
    return typeof session.key === "string" && session.key.length > 0;
}

/** Formats the session label inside a selected chat agent bucket. */
function formatChatSessionLabel(session: Session, agentId: string): string {
    const sessionKey = session.key;
    const [scope = "", keyAgentId, ...sessionParts] = sessionKey.split(":");
    if (
        scope.toLowerCase() === "agent" &&
        keyAgentId &&
        normalizeChatAgentId(keyAgentId) === agentId
    ) {
        return sessionParts.join(":") || sessionKey;
    }

    return session.displayLabel || session.label || session.displayName || sessionKey;
}

/** Performs deleted messages storage key. */
function deletedMessagesStorageKey(sessionKey: string): string {
    return `openclaw:deleted:${sessionKey}`;
}

/** Returns whether text is a reset-like slash command. */
function isResetSlashCommand(text: string): boolean {
    return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}

/** Performs read deleted message keys. */
export function readDeletedMessageKeys(sessionKey: string): Set<string> {
    if (!sessionKey || typeof window === "undefined") {
        return new Set();
    }

    try {
        const raw = localStorage.getItem(deletedMessagesStorageKey(sessionKey));
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : []
        );
    } catch {
        return new Set();
    }
}

/** Performs write deleted message keys. */
export function writeDeletedMessageKeys(sessionKey: string, keys: Set<string>): void {
    if (!sessionKey) {
        return;
    }

    try {
        localStorage.setItem(
            deletedMessagesStorageKey(sessionKey),
            JSON.stringify([...keys])
        );
    } catch {
        // Keep in-memory deleted state if browser storage is unavailable.
    }
}

/** Represents stored chat diagnostic visibility. */
interface StoredChatDiagnosticVisibility {
    thinking: boolean;
    tools: boolean;
}

/** Performs session timestamp milliseconds. */
export function sessionTimestampMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        return timestampFromDateString(value);
    }

    return undefined;
}

/** Performs history has newer assistant message. */
export function hasNewerAssistantMessageInHistory(
    messages: ChatHistoryMessage[],
    updatedAt?: string
): boolean {
    const streamUpdatedAt = sessionTimestampMs(updatedAt);

    if (streamUpdatedAt === undefined) {
        return false;
    }

    return messages.some((message) => {
        if (message.role.toLowerCase() !== "assistant" || !message.text.trim()) {
            return false;
        }

        const messageTimestamp = sessionTimestampMs(message.timestamp);
        return messageTimestamp !== undefined && messageTimestamp >= streamUpdatedAt;
    });
}

/** Returns the next history-load bottom-following state. */
export function nextHistoryBottomState(
    wasPrevious: boolean,
    isNewSession: boolean,
    shouldStickToBottom: boolean
) {
    if (isNewSession || shouldStickToBottom) {
        return true;
    }

    return wasPrevious;
}

/** Returns the next send error after a history load failure. */
export function nextHistoryLoadSendError(
    wasPrevious: string | undefined,
    wasCanceled: boolean,
    historyLoadError: string
) {
    if (wasCanceled) {
        return wasPrevious;
    }

    return historyLoadError;
}

/** Calls a bottom-follow scheduler only when the view should stick to bottom. */
export function scheduleBottomFollowWhenNeeded(
    shouldStickToBottom: boolean,
    scheduleBottomFollow: () => void
) {
    if (!shouldStickToBottom) {
        return false;
    }

    scheduleBottomFollow();
    return true;
}

/** Performs read stored chat diagnostic visibility. */
export function readStoredChatDiagnosticVisibility(): StoredChatDiagnosticVisibility {
    if (typeof window === "undefined") {
        return { thinking: false, tools: false };
    }

    try {
        const raw = localStorage.getItem(CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY);
        if (!raw) {
            return { thinking: false, tools: false };
        }

        const parsed = JSON.parse(raw) as Partial<StoredChatDiagnosticVisibility>;
        return {
            thinking: parsed.thinking === true,
            tools: parsed.tools === true,
        };
    } catch {
        return { thinking: false, tools: false };
    }
}

/** Performs write stored chat diagnostic visibility. */
export function writeStoredChatDiagnosticVisibility(
    visibility: StoredChatDiagnosticVisibility
): void {
    try {
        localStorage.setItem(
            CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY,
            JSON.stringify(visibility)
        );
    } catch {
        // Keep the in-memory toggle state if browser storage is unavailable.
    }
}

/** Performs supported audio recording MIME type. */
export function supportedAudioRecordingMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") {
        return undefined;
    }

    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/ogg;codecs=opus",
    ];

    return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

/** Renders the chat UI. */
export function Chat() {
    const { connectionId, isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | undefined>(undefined);
    const messagesBottomReference = useRef<HTMLDivElement | undefined>(undefined);
    const fileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const shouldStickToBottomReference = useRef(true);
    const lastKnownMessagesScrollTopReference = useRef(0);
    const activeStreamsReference = useRef<ActiveChatStreams>({});
    const liveHistoryRefreshTimerReference = useRef<
        ReturnType<typeof setTimeout> | undefined
    >(undefined);
    const backgroundHistoryRefreshAbortReference = useRef<AbortController | undefined>(
        undefined
    );
    const mediaRecorderReference = useRef<MediaRecorder | undefined>(undefined);
    const recordingChunksReference = useRef<Blob[]>([]);
    const voiceFileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const loadedHistorySessionReference = useRef("");
    const selectedSessionKeyReference = useRef("");
    const previousChatRowsLengthReference = useRef(0);
    const previousSelectedSessionKeyReference = useRef("");
    const previousSelectedStreamTextReference = useRef("");
    const bottomFollowFrameReference = useRef<number | undefined>(undefined);
    const sendInFlightCountReference = useRef(0);
    const sendEpochReference = useRef(0);
    const resetConfirmResolverReference = useRef<
        ((wasConfirmed: boolean) => void) | undefined
    >(undefined);

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>({});
    const [sendError, setSendError] = useState<string | undefined>(undefined);
    const [deletedMessageKeys, setDeletedMessageKeys] = useState<Set<string>>(
        () => new Set()
    );
    const [pendingDeleteMessageKey, setPendingDeleteMessageKey] = useState<
        string | undefined
    >(undefined);
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | undefined>(
        undefined
    );
    const [showThinkingOutput, setShowThinkingOutput] = useState(
        () => readStoredChatDiagnosticVisibility().thinking
    );
    const [showToolOutput, setShowToolOutput] = useState(
        () => readStoredChatDiagnosticVisibility().tools
    );
    const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
    const [, setHistoryLoadVersion] = useState(0);

    const { data: sessions = [] } = useLiveQuery((query) =>
        query.from({ session: sessionsCollection })
    );
    const { data: agentsStatus } = useAgentsStatus();
    const agents = agentsStatus?.agents || [];

    /** Performs update active streamilliseconds. */
    const updateActiveStreams = (
        updater: (wasPrevious: ActiveChatStreams) => ActiveChatStreams
    ) => {
        setActiveStreams((wasPrevious) => {
            const next = updater(wasPrevious);
            activeStreamsReference.current = next;
            return next;
        });
    };
    /** Clears active streams for a session, including per-stream diagnostic keys. */
    const clearActiveStreamsForSession = (sessionKey: string) => {
        updateActiveStreams((wasPrevious) =>
            Object.fromEntries(
                Object.entries(wasPrevious).filter(
                    ([, stream]) => !isSameSessionKey(stream.sessionKey, sessionKey)
                )
            )
        );
    };

    const sortedSessions = useMemo(
        () => sortSessionsByTypeAndActivity(sessions),
        [sessions]
    );
    const sessionMap = useMemo(
        () => new Map(sortedSessions.map((session) => [session.key, session])),
        [sortedSessions]
    );
    const selectedSessionUpdatedAt = selectedSessionKey
        ? sessionMap.get(selectedSessionKey)?.updatedAt
        : undefined;
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || undefined
        : undefined;
    selectedSessionKeyReference.current = selectedSessionKey;
    const selectedAgentId = selectedSession ? getChatAgentId(selectedSession) : "";
    const sessionsForSelectedAgent = selectedAgentId
        ? sortedSessions.filter((session) => getChatAgentId(session) === selectedAgentId)
        : sortedSessions;
    const selectedStreams = selectedSessionKey
        ? Object.entries(activeStreams)
              .filter(([, stream]) =>
                  isSameSessionKey(stream.sessionKey, selectedSessionKey)
              )
              .toSorted(([leftKey], [rightKey]) => {
                  if (leftKey === selectedSessionKey) {
                      return -1;
                  }
                  if (rightKey === selectedSessionKey) {
                      return 1;
                  }
                  return leftKey.localeCompare(rightKey);
              })
        : [];
    const selectedStreamsText = selectedStreams
        .map(([, stream]) => activeStreamRenderableText(stream))
        .filter(Boolean)
        .join("\n");
    const chatVisibility = createChatVisibility(showThinkingOutput, showToolOutput);
    const visibleMessagesForRows = dedupeMessages(messages).filter(
        (message) =>
            !deletedMessageKeys.has(messageDeleteKey(message)) &&
            isRenderableChatHistoryMessage(message, chatVisibility)
    );
    /** Returns whether active stream text is already represented in history. */
    function isStreamRecoveredInMessages(stream: ActiveChatStream): boolean {
        return isActiveStreamRecoveredInMessages(
            stream,
            visibleMessagesForRows,
            Date.now()
        );
    }

    const chatRows: ChatRow[] = visibleMessagesForRows.map((message) => ({
        key: messageDeleteKey(message),
        kind: "message",
        message,
    }));
    let latestTypingStream:
        | { key: string; statusText: string; updatedAt?: string }
        | undefined;

    for (const [streamKey, stream] of selectedStreams) {
        const streamText = stream.text || "";
        const streamMessage = stream.message;
        const isStreamRecoveredInHistory = isStreamRecoveredInMessages(stream);
        const shouldShowStreamRow =
            !isStreamRecoveredInHistory &&
            shouldRenderStreamRow(streamText, streamMessage, chatVisibility);
        const shouldShowTypingIndicator = Boolean(
            !isStreamRecoveredInHistory && !shouldShowStreamRow && stream.statusText
        );

        if (shouldShowStreamRow) {
            chatRows.push({
                key: `stream-${streamKey}`,
                kind: "stream",
                message: streamMessage || {
                    role: "assistant",
                    content: streamText,
                    text: streamText,
                },
            });
        }

        if (shouldShowTypingIndicator) {
            const statusText = stream.statusText || "Thinking";
            const previousUpdatedAt = sessionTimestampMs(latestTypingStream?.updatedAt);
            const nextUpdatedAt = sessionTimestampMs(stream.updatedAt);
            if (
                !latestTypingStream ||
                previousUpdatedAt === undefined ||
                (nextUpdatedAt !== undefined && nextUpdatedAt >= previousUpdatedAt)
            ) {
                latestTypingStream = {
                    key: streamKey,
                    statusText,
                    updatedAt: stream.updatedAt,
                };
            }
        }
    }

    if (latestTypingStream) {
        chatRows.push({
            key: `typing-${latestTypingStream.key}-${latestTypingStream.statusText}`,
            kind: "typing",
            message: {
                role: "assistant",
                content: latestTypingStream.statusText,
                text: latestTypingStream.statusText,
            },
        });
    }

    useEffect(() => {
        if (sortedSessions.length === 0) {
            if (selectedSessionKey) {
                setSelectedSessionKey("");
            }
            if (isLoadingHistory) {
                setIsLoadingHistory(false);
            }
            return;
        }

        if (!selectedSessionKey || !sessionMap.has(selectedSessionKey)) {
            const fallbackSession = sortedSessions.find(
                (session) => session.key && sessionMap.has(session.key)
            );
            setSelectedSessionKey(fallbackSession?.key || "");
        }
    }, [isLoadingHistory, selectedSessionKey, sessionMap, sortedSessions]);

    useEffect(() => {
        setDeletedMessageKeys(
            selectedSessionKey ? readDeletedMessageKeys(selectedSessionKey) : new Set()
        );
        setPendingDeleteMessageKey(undefined);
    }, [selectedSessionKey]);

    useEffect(() => {
        if (!isConnected) {
            sendEpochReference.current += 1;
            sendInFlightCountReference.current = 0;
            setIsSending(false);

            updateActiveStreams(() => ({}));

            if (liveHistoryRefreshTimerReference.current !== undefined) {
                clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = undefined;
            }

            return;
        }

        let isCancelled = false;

        /** Performs load models. */
        const loadModels = async () => {
            try {
                const result = (await request("models.list", {
                    view: "configured",
                })) as { models?: ChatModelOption[] };

                if (!isCancelled) {
                    setChatModelOptions(result.models || []);
                }
            } catch {
                if (!isCancelled) {
                    setChatModelOptions([]);
                }
            }
        };

        void loadModels();

        return () => {
            isCancelled = true;
        };
    }, [isConnected, request, selectedSessionKey]);

    useEffect(() => {
        writeStoredChatDiagnosticVisibility({
            thinking: showThinkingOutput,
            tools: showToolOutput,
        });
    }, [showThinkingOutput, showToolOutput]);

    useEffect(() => {
        const isNewSession = loadedHistorySessionReference.current !== selectedSessionKey;
        if (isNewSession) {
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);
            setAttachments([]);
        }
        if (!selectedSessionKey) {
            loadedHistorySessionReference.current = "";
            setMessages([]);
            return;
        }

        if (!isConnected) {
            setIsLoadingHistory(false);
            return;
        }

        let isCancelled = false;

        /** Performs load history. */
        const loadHistory = async () => {
            setIsLoadingHistory(true);
            setSendError(undefined);

            try {
                const result = (await request("chat.history", {
                    sessionKey: selectedSessionKey,
                    limit: CHAT_HISTORY_LIMIT,
                })) as {
                    messages?: RawChatHistoryMessage[];
                };
                const shouldApplyResult =
                    !isCancelled &&
                    selectedSessionKeyReference.current === selectedSessionKey;
                if (!shouldApplyResult) {
                    return;
                }

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );
                setMessages((wasPrevious) => {
                    if (loadedHistorySessionReference.current !== selectedSessionKey) {
                        loadedHistorySessionReference.current = selectedSessionKey;
                        return nextMessages;
                    }

                    return mergeWithRecentOptimisticMessages(wasPrevious, nextMessages);
                });
                if (isNewSession) {
                    shouldStickToBottomReference.current = true;
                }
                setIsAtBottom((wasPrevious) =>
                    nextHistoryBottomState(
                        wasPrevious,
                        isNewSession,
                        shouldStickToBottomReference.current
                    )
                );
                setHistoryLoadVersion((wasPrevious) => wasPrevious + 1);
            } catch (error_) {
                const historyLoadError = chatErrorMessage(
                    error_,
                    "Failed to load chat history"
                );
                setSendError((wasPrevious) =>
                    nextHistoryLoadSendError(wasPrevious, isCancelled, historyLoadError)
                );
            } finally {
                if (!isCancelled) {
                    setIsLoadingHistory(false);
                }
            }
        };

        void loadHistory();

        return () => {
            isCancelled = true;
        };
    }, [isConnected, request, selectedSessionKey, showThinkingOutput, showToolOutput]);
    useEffect(() => {
        if (
            !isConnected ||
            !selectedSessionKey ||
            !selectedSessionUpdatedAt ||
            isLoadingHistory
        ) {
            return;
        }

        const requestSessionKey = selectedSessionKey;
        const abortController = new AbortController();
        backgroundHistoryRefreshAbortReference.current?.abort();
        backgroundHistoryRefreshAbortReference.current = abortController;
        let isCancelled = false;

        /** Performs refresh visible history. */
        const refreshVisibleHistory = async () => {
            try {
                const result = (await request("chat.history", {
                    sessionKey: requestSessionKey,
                    limit: CHAT_HISTORY_LIMIT,
                })) as {
                    messages?: RawChatHistoryMessage[];
                };
                const shouldApplyResult =
                    !isCancelled &&
                    !abortController.signal.aborted &&
                    selectedSessionKeyReference.current === requestSessionKey;
                if (!shouldApplyResult) {
                    return;
                }

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );
                const recoveredStreamKeys = Object.entries(activeStreamsReference.current)
                    .filter(([, stream]) =>
                        isSameSessionKey(stream.sessionKey, requestSessionKey)
                    )
                    .filter(([, stream]) => {
                        const streamText = activeStreamRenderableText(stream);
                        const activeStreamUpdatedAt = sessionTimestampMs(
                            stream.updatedAt
                        );
                        const isActiveStreamIsQuiet =
                            activeStreamUpdatedAt === undefined ||
                            Date.now() - activeStreamUpdatedAt >=
                                ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS;
                        return Boolean(
                            isActiveStreamIsQuiet &&
                            (isActiveStreamRecoveredInMessages(stream, nextMessages) ||
                                (streamText &&
                                    hasRecoveredStreamHistory(
                                        nextMessages,
                                        streamText
                                    )) ||
                                hasNewerAssistantMessageInHistory(
                                    nextMessages,
                                    stream.updatedAt
                                ))
                        );
                    })
                    .map(([key]) => key);
                const isRecoveredStreamInHistory = recoveredStreamKeys.length > 0;
                setMessages((wasPrevious) => {
                    const previousLast = wasPrevious.at(-1)?.timestamp;
                    const nextLast = nextMessages.at(-1)?.timestamp;

                    if (
                        wasPrevious.length === nextMessages.length &&
                        previousLast === nextLast
                    ) {
                        return wasPrevious;
                    }

                    return mergeWithRecentOptimisticMessages(wasPrevious, nextMessages);
                });
                setIsAtBottom(shouldStickToBottomReference.current);
                if (isRecoveredStreamInHistory) {
                    updateActiveStreams((wasPrevious) => {
                        const next = { ...wasPrevious };
                        for (const key of recoveredStreamKeys) {
                            delete next[key];
                        }
                        return next;
                    });
                }
            } catch {
                // Ignore background refresh failures.
            }
        };

        void refreshVisibleHistory();

        return () => {
            isCancelled = true;
            abortController.abort();
            backgroundHistoryRefreshAbortReference.current = undefined;
        };
    }, [
        isLoadingHistory,
        isConnected,
        request,
        selectedSessionKey,
        selectedSessionUpdatedAt,
        showThinkingOutput,
        showToolOutput,
    ]);

    useEffect(() => {
        if (!isConnected || !selectedSessionKey) {
            return;
        }

        let isCancelled = false;
        let isRefreshInFlight = false;

        /** Performs refresh visible history. */
        const refreshVisibleHistory = async () => {
            if (
                isRefreshInFlight ||
                document.visibilityState === "hidden" ||
                !shouldStickToBottomReference.current
            ) {
                return;
            }

            isRefreshInFlight = true;

            try {
                const result = (await request("chat.history", {
                    sessionKey: selectedSessionKey,
                    limit: CHAT_HISTORY_LIMIT,
                })) as {
                    messages?: RawChatHistoryMessage[];
                };
                const shouldApplyResult =
                    !isCancelled &&
                    selectedSessionKeyReference.current === selectedSessionKey;
                if (!shouldApplyResult) {
                    return;
                }

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );

                setMessages((wasPrevious) => {
                    const previousLast = wasPrevious.at(-1)?.timestamp;
                    const nextLast = nextMessages.at(-1)?.timestamp;

                    if (
                        wasPrevious.length === nextMessages.length &&
                        previousLast === nextLast
                    ) {
                        return wasPrevious;
                    }

                    return mergeWithRecentOptimisticMessages(wasPrevious, nextMessages);
                });

                setIsAtBottom(shouldStickToBottomReference.current);
                setHistoryLoadVersion((wasPrevious) => wasPrevious + 1);
            } catch {
                // Opportunistic live refresh; WebSocket events remain the primary path.
            } finally {
                isRefreshInFlight = false;
            }
        };

        const interval = setInterval(
            () => void refreshVisibleHistory(),
            LIVE_HISTORY_POLL_MS
        );

        return () => {
            isCancelled = true;
            clearInterval(interval);
        };
    }, [isConnected, request, selectedSessionKey, showThinkingOutput, showToolOutput]);

    useChatRuntimeEvents({
        request,
        subscribe,
        connectionId,
        isConnected,
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
    });

    /** Performs check is at bottom. */
    const checkIsAtBottom = () => {
        const container = messagesContainerReference.current;
        if (!container) {
            return true;
        }

        return (
            container.scrollHeight - container.scrollTop - container.clientHeight <=
            CHAT_BOTTOM_THRESHOLD_PX
        );
    };

    /** Responds to messages scroll events. */
    const handleMessagesScroll = () => {
        const container = messagesContainerReference.current;
        if (container) {
            lastKnownMessagesScrollTopReference.current = container.scrollTop;
        }

        const atBottom = checkIsAtBottom();
        shouldStickToBottomReference.current = atBottom;
        setIsAtBottom((wasPrevious) =>
            wasPrevious === atBottom ? wasPrevious : atBottom
        );
    };

    /** Performs scroll messages to bottom. */
    const scrollMessagesToBottom = () => {
        const container = messagesContainerReference.current;
        if (!container || chatRows.length === 0) {
            return;
        }

        messagesBottomReference.current?.scrollIntoView({ block: "end" });
        container.scrollTop = container.scrollHeight;
        lastKnownMessagesScrollTopReference.current = container.scrollTop;
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
    };

    /** Performs schedule bottom follow. */
    const scheduleBottomFollow = () => {
        if (bottomFollowFrameReference.current !== undefined) {
            return;
        }

        bottomFollowFrameReference.current = requestAnimationFrame(() => {
            bottomFollowFrameReference.current = undefined;
            scrollMessagesToBottom();
        });
    };

    const messagesVirtualizer = useVirtualizer({
        count: chatRows.length,
        getItemKey: (index) => chatRows[index]?.key ?? `row-${index}`,
        getScrollElement: () =>
            messagesContainerReference.current ?? NO_CHAT_SCROLL_ELEMENT,
        estimateSize: (index) => (chatRows[index]?.kind === "typing" ? 76 : 160),
        overscan: 12,
        useAnimationFrameWithResizeObserver: true,
        onChange: (_instance, sync) => {
            if (!sync && shouldStickToBottomReference.current) {
                scheduleBottomFollow();
            }
        },
    });

    /** Responds to dynamic row content load events. */
    const handleDynamicRowContentLoad = () => {
        scheduleBottomFollowWhenNeeded(
            shouldStickToBottomReference.current,
            scheduleBottomFollow
        );
    };

    useLayoutEffect(() => {
        const isSessionChanged =
            previousSelectedSessionKeyReference.current !== selectedSessionKey;
        const isRowsWereAdded = chatRows.length > previousChatRowsLengthReference.current;
        const isStreamTextChanged =
            previousSelectedStreamTextReference.current !== selectedStreamsText;

        previousSelectedSessionKeyReference.current = selectedSessionKey;
        previousChatRowsLengthReference.current = chatRows.length;
        previousSelectedStreamTextReference.current = selectedStreamsText;

        if (chatRows.length === 0) {
            return;
        }

        if (isSessionChanged) {
            shouldStickToBottomReference.current = true;
            scrollMessagesToBottom();
            return;
        }

        if (
            !shouldStickToBottomReference.current ||
            (!isRowsWereAdded && !isStreamTextChanged)
        ) {
            return;
        }

        scrollMessagesToBottom();

        const scrollFrame = requestAnimationFrame(scrollMessagesToBottom);

        return () => cancelAnimationFrame(scrollFrame);
    }, [chatRows.length, selectedStreamsText, selectedSessionKey]);

    const sessionOptions = sessionsForSelectedAgent
        .filter((session) => hasSessionKey(session))
        .map((session) => ({
            value: session.key,
            label: formatChatSessionLabel(session, selectedAgentId),
            description: `${formatSessionType(session)} · ${session.model || "Unknown"}`,
        }));

    const selectableSessions = sortedSessions.filter((session) => hasSessionKey(session));
    const agentSessionCounts = new Map<string, number>();
    for (const session of selectableSessions) {
        const agentId = getChatAgentId(session);
        agentSessionCounts.set(agentId, (agentSessionCounts.get(agentId) || 0) + 1);
    }

    const agentOptions = [...agentSessionCounts].map(([agentId, count]) => {
        const agent = agents.find((entry) => normalizeChatAgentId(entry.id) === agentId);
        return {
            value: agentId,
            label: agentId,
            description: `${count} session${count === 1 ? "" : "s"}${agent?.status ? ` · ${agent.status}` : ""}`,
        };
    });

    /** Selects newest/default session for selected agent. */
    const handleSelectAgent = (agentId: string) => {
        if (agentId === selectedAgentId) {
            return;
        }

        const agentSession = agents.find(
            (agent) => normalizeChatAgentId(agent.id) === agentId
        )?.sessionKey as string | undefined;
        const nextSession =
            sortedSessions.find(
                (session) =>
                    hasSessionKey(session) &&
                    isSameSessionKey(session.key, agentSession) &&
                    getChatAgentId(session) === agentId
            ) ||
            sortedSessions.find(
                (session) => hasSessionKey(session) && getChatAgentId(session) === agentId
            );
        if (nextSession) {
            setSelectedSessionKey(nextSession.key);
        }
    };

    const slashCommandSuggestions = buildSlashCommandSuggestions(draft, chatModelOptions);

    /** Performs apply slash suggestion. */
    const applySlashSuggestion = (value: string) => {
        setDraft(value);
    };

    /** Responds to delete message events. */
    const handleDeleteMessage = (messageKey: string) => {
        setPendingDeleteMessageKey(messageKey);
    };

    /** Performs confirm delete message. */
    const confirmDeleteMessage = () => {
        if (!selectedSessionKey || !pendingDeleteMessageKey) {
            return;
        }

        setDeletedMessageKeys((wasPrevious) => {
            const next = new Set(wasPrevious);
            next.add(pendingDeleteMessageKey);
            writeDeletedMessageKeys(selectedSessionKey, next);
            return next;
        });
        setPendingDeleteMessageKey(undefined);
    };

    /** Resolves a pending reset confirmation and hides the modal. */
    const closeResetConfirm = (wasConfirmed: boolean) => {
        resetConfirmResolverReference.current?.(wasConfirmed);
        resetConfirmResolverReference.current = undefined;
        setIsResetConfirmOpen(false);
    };

    /** Opens the reset confirmation modal and resolves with the user's choice. */
    const confirmResetSession = () =>
        new Promise<boolean>((resolve) => {
            resetConfirmResolverReference.current?.(false);
            resetConfirmResolverReference.current = resolve;
            setIsResetConfirmOpen(true);
        });

    useEffect(() => {
        return () => {
            resetConfirmResolverReference.current?.(false);
            resetConfirmResolverReference.current = undefined;
        };
    }, []);

    /** Responds to files selected events. */
    const handleFilesSelected = async (files: FileList | undefined) => {
        if (!files || files.length === 0) {
            return;
        }

        setSendError(undefined);

        const remainingSlots = MAX_ATTACHMENTS - attachments.length;
        const selectedFiles = [...files].slice(0, remainingSlots);

        if (files.length > remainingSlots) {
            setSendError(`Only ${MAX_ATTACHMENTS} attachments can be sent at once.`);
        }

        try {
            const nextAttachments = await Promise.all(
                selectedFiles.map(async (file) => {
                    if (file.size > MAX_ATTACHMENT_BYTES) {
                        throw new Error(
                            `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                        );
                    }

                    const dataUrl = await readFileAsDataUrl(file);
                    const mimeType = displayMimeType(file);
                    const kind = attachmentKind(mimeType);

                    return {
                        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
                        file,
                        fileName: file.name,
                        mimeType,
                        sizeBytes: file.size,
                        contentBase64: dataUrlToBase64(dataUrl),
                        dataUrl,
                        kind,
                    } satisfies ChatSendAttachment;
                })
            );

            setAttachments((wasPrevious) => [...wasPrevious, ...nextAttachments]);
        } catch (error_) {
            setSendError(chatErrorMessage(error_, "Failed to read attachment"));
        } finally {
            if (fileInputReference.current) {
                fileInputReference.current.value = "";
            }
        }
    };

    /** Performs remove attachment. */
    const removeAttachment = (attachmentId: string) => {
        setAttachments((wasPrevious) =>
            wasPrevious.filter((attachment) => attachment.id !== attachmentId)
        );
    };

    /** Performs transcribe recording. */
    const transcribeRecording = async (audioBlob: Blob) => {
        if (audioBlob.size === 0) {
            setSendError("No audio was recorded.");
            return;
        }

        setIsTranscribing(true);
        setSendError(undefined);

        try {
            const response = await fetch("/api/stt/transcribe", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": audioBlob.type || "audio/webm",
                },
                body: audioBlob,
            });

            if (!response.ok) {
                let error: { error?: string };
                try {
                    error = (await response.json()) as { error?: string };
                } catch {
                    error = { error: "Failed to transcribe audio" };
                }
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const result = (await response.json()) as { text?: string };
            const text = result.text?.trim();
            if (!text) {
                setSendError("Whisper did not detect any speech.");
                return;
            }

            setDraft((wasPrevious) => {
                const trimmedPrevious = wasPrevious.trimEnd();
                return trimmedPrevious ? `${trimmedPrevious}\n${text}` : text;
            });
        } catch (error_) {
            setSendError(chatErrorMessage(error_, "Failed to transcribe audio"));
        } finally {
            setIsTranscribing(false);
        }
    };

    /** Responds to voice file selected events. */
    const handleVoiceFileSelected = async (files: FileList | undefined) => {
        const file = files?.[0];
        if (!file) {
            return;
        }

        try {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                );
            }

            await transcribeRecording(file);
        } catch (error_) {
            setSendError(chatErrorMessage(error_, "Failed to read audio file"));
        } finally {
            if (voiceFileInputReference.current) {
                voiceFileInputReference.current.value = "";
            }
        }
    };

    /** Responds to toggle recording events. */
    const handleToggleRecording = async () => {
        if (isRecording) {
            mediaRecorderReference.current?.stop();
            return;
        }

        const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
        const canUseDirectRecorder =
            Boolean(mediaDevices) &&
            typeof mediaDevices?.getUserMedia === "function" &&
            typeof MediaRecorder !== "undefined";

        if (!canUseDirectRecorder) {
            setSendError(
                isSecureContext
                    ? "Direct voice recording is not supported here. Choose or record an audio file instead."
                    : "Direct voice recording requires HTTPS or localhost. Choose or record an audio file instead."
            );
            voiceFileInputReference.current?.click();
            return;
        }

        let stream: MediaStream | undefined;

        try {
            setSendError(undefined);
            stream = await mediaDevices!.getUserMedia({ audio: true });
            const recordingStream = stream;
            const mimeType = supportedAudioRecordingMimeType();
            const recorder = mimeType
                ? new MediaRecorder(recordingStream, { mimeType })
                : new MediaRecorder(recordingStream);
            recordingChunksReference.current = [];
            mediaRecorderReference.current = recorder;

            recorder.addEventListener("dataavailable", (event) => {
                if (event.data.size > 0) {
                    recordingChunksReference.current.push(event.data);
                }
            });

            recorder.addEventListener("stop", () => {
                for (const track of recordingStream.getTracks()) {
                    track.stop();
                }
                setIsRecording(false);
                mediaRecorderReference.current = undefined;
                const audioBlob = new Blob(recordingChunksReference.current, {
                    type: recorder.mimeType || "audio/webm",
                });
                recordingChunksReference.current = [];
                void transcribeRecording(audioBlob);
            });

            recorder.start();
            setIsRecording(true);
        } catch (error_) {
            if (stream) {
                for (const track of stream.getTracks()) {
                    track.stop();
                }
            }
            setSendError(chatErrorMessage(error_, "Failed to start recording"));
        }
    };

    const handleSlashCommand = useChatSlashCommands({
        request,
        selectedSessionKey,
        attachments,
        updateActiveStreams,
        setMessages,
        setDraft,
        setSendError,
        confirmResetSession,
    });

    /** Marks a chat submit request as in-flight. */
    const beginSend = () => {
        sendInFlightCountReference.current += 1;
        setIsSending(true);
        return sendEpochReference.current;
    };

    /** Marks a chat submit request as completed. */
    const endSend = (sendEpoch: number) => {
        if (sendEpoch !== sendEpochReference.current) {
            return;
        }

        sendInFlightCountReference.current = Math.max(
            0,
            sendInFlightCountReference.current - 1
        );
        setIsSending(sendInFlightCountReference.current > 0);
    };

    /** Returns whether the current in-flight sends should block this draft. */
    const isBlockedByInFlightSend = (text: string) => {
        const isSlashCommand = text.startsWith("/") && attachments.length === 0;
        const hasActiveSelectedStream = Object.hasOwn(activeStreams, selectedSessionKey);
        return (
            sendInFlightCountReference.current > 0 &&
            !(isSlashCommand && hasActiveSelectedStream)
        );
    };

    /** Responds to send events. */
    const handleSend = async () => {
        if (!selectedSessionKey) {
            return;
        }

        const text = draft.trim();

        if (isBlockedByInFlightSend(text)) {
            return;
        }

        if (!text && attachments.length === 0) {
            return;
        }

        const sendEpoch = beginSend();

        if (text.startsWith("/")) {
            let isHandledCommand: boolean;
            try {
                isHandledCommand = await handleSlashCommand(text);
            } catch (error_) {
                setSendError(chatErrorMessage(error_, "Failed to run slash command"));
                endSend(sendEpoch);
                return;
            }

            if (isHandledCommand) {
                endSend(sendEpoch);
                return;
            }
        }

        const messageText = text;
        const sendAttachments = attachments;
        const isResetCommand = isResetSlashCommand(messageText);
        const shouldAppendOptimisticMessage = !isResetCommand;
        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: messageText,
            text: messageText,
            images: [],
            attachments: optimisticAttachmentDisplay(sendAttachments),
            timestamp: currentIsoString(),
        };

        if (shouldAppendOptimisticMessage) {
            setMessages((wasPrevious) => dedupeMessages([...wasPrevious, userMessage]));
        }
        setDraft("");
        setAttachments([]);
        setSendError(undefined);
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        scheduleBottomFollow();

        const idempotencyKey = isResetCommand
            ? undefined
            : `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (idempotencyKey) {
            updateActiveStreams((wasPrevious) => ({
                ...wasPrevious,
                [selectedSessionKey]: {
                    sessionKey: selectedSessionKey,
                    runId: idempotencyKey,
                    aliases: [idempotencyKey],
                    text: "",
                    statusText: "Thinking",
                    updatedAt: currentIsoString(),
                },
            }));
        }

        try {
            if (
                !messageText.startsWith("/") &&
                selectedSession?.verboseLevel !== "full"
            ) {
                try {
                    await request("sessions.patch", {
                        key: selectedSessionKey,
                        verboseLevel: "full",
                    });
                } catch {
                    // Best-effort diagnostics config; do not block message delivery.
                }
            }

            const result = (await request("chat.send", {
                sessionKey: selectedSessionKey,
                sessionId:
                    selectedSession?.id &&
                    selectedSession.id !== "unknown" &&
                    selectedSession.id !== selectedSessionKey
                        ? selectedSession.id
                        : undefined,
                message: messageText,
                attachments: gatewayAttachments(sendAttachments),
                idempotencyKey,
            })) as undefined | { runId?: string };

            if (isResetCommand) {
                setMessages([]);
                clearActiveStreamsForSession(selectedSessionKey);
            } else {
                const acknowledgedRunId = result?.runId;
                if (acknowledgedRunId) {
                    updateActiveStreams((wasPrevious) => {
                        const existing = wasPrevious[selectedSessionKey];
                        if (!existing) {
                            return wasPrevious;
                        }

                        return {
                            ...wasPrevious,
                            [selectedSessionKey]: {
                                ...existing,
                                runId: acknowledgedRunId,
                                aliases: uniqueStrings([
                                    ...existing.aliases,
                                    acknowledgedRunId,
                                ]),
                            },
                        };
                    });
                }
            }
        } catch (error_) {
            setSendError(chatErrorMessage(error_, "Failed to send message"));
            clearActiveStreamsForSession(selectedSessionKey);
        } finally {
            endSend(sendEpoch);
        }
    };

    const draftText = draft.trim();
    const blockedByInFlightSend = isBlockedByInFlightSend(draftText);
    const canSend = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isRecording &&
        !isTranscribing &&
        !blockedByInFlightSend &&
        (draftText || attachments.length > 0)
    );

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-3 sm:p-4 lg:p-6">
            <div className="min-h-0 flex-1">
                <Card className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent p-0">
                    <ChatHeader
                        selectedSession={selectedSession}
                        selectedAgentId={selectedAgentId}
                        selectedSessionKey={selectedSessionKey}
                        sessionOptions={sessionOptions}
                        agentOptions={agentOptions}
                        shouldShowThinking={showThinkingOutput}
                        shouldShowTools={showToolOutput}
                        onToggleThinking={() =>
                            setShowThinkingOutput((wasPrevious) => !wasPrevious)
                        }
                        onToggleTools={() =>
                            setShowToolOutput((wasPrevious) => !wasPrevious)
                        }
                        onSelectAgent={handleSelectAgent}
                        onSelectSession={setSelectedSessionKey}
                    />

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        isAtBottom={isAtBottom}
                        chatRows={chatRows}
                        messagesBottomReference={messagesBottomReference}
                        messagesContainerReference={messagesContainerReference}
                        messagesVirtualizer={messagesVirtualizer}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onFollow={scrollMessagesToBottom}
                        onPreview={setPreviewItem}
                        visibility={createChatVisibility(
                            showThinkingOutput,
                            showToolOutput
                        )}
                        onScroll={handleMessagesScroll}
                        onTtsError={setSendError}
                        onDeleteMessage={handleDeleteMessage}
                    />

                    {(sendError || error) && (
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 sm:mt-4 sm:text-sm">
                            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                            <span className="min-w-0 break-words">
                                {sendError || error}
                            </span>
                        </div>
                    )}

                    <input
                        ref={(element) => {
                            voiceFileInputReference.current = element ?? undefined;
                        }}
                        type="file"
                        accept="audio/*"
                        capture
                        className="hidden"
                        onChange={(event) =>
                            void handleVoiceFileSelected(event.target.files ?? undefined)
                        }
                    />

                    <ChatComposer
                        attachments={attachments}
                        canSend={canSend}
                        draft={draft}
                        fileInputReference={fileInputReference}
                        isConnected={isConnected}
                        isRecording={isRecording}
                        isSending={isSending}
                        isTranscribing={isTranscribing}
                        selectedSessionKey={selectedSessionKey}
                        slashCommandSuggestions={slashCommandSuggestions}
                        onApplySlashSuggestion={applySlashSuggestion}
                        onAttachFiles={(files) => void handleFilesSelected(files)}
                        onChangeDraft={setDraft}
                        onPreview={setPreviewItem}
                        onRemoveAttachment={removeAttachment}
                        onSend={() => void handleSend()}
                        onToggleRecording={() => void handleToggleRecording()}
                    />
                </Card>
            </div>

            <AttachmentPreviewModal
                previewItem={previewItem}
                onClose={() => setPreviewItem(undefined)}
            />

            <ConfirmModal
                isOpen={!!pendingDeleteMessageKey}
                title="Delete message"
                message="Delete this message from your chat view?"
                confirmLabel="Delete"
                danger
                onCancel={() => setPendingDeleteMessageKey(undefined)}
                onConfirm={confirmDeleteMessage}
            />

            <ConfirmModal
                isOpen={isResetConfirmOpen}
                title="Reset chat session"
                message="Reset this chat session? This clears the session history/transcript for the selected target."
                confirmLabel="Reset"
                danger
                onCancel={() => closeResetConfirm(false)}
                onConfirm={() => closeResetConfirm(true)}
            />
        </div>
    );
}
