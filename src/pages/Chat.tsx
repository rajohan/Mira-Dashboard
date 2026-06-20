import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { AttachmentPreviewModal } from "../components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "../components/features/chat/ChatComposer";
import { ChatHeader } from "../components/features/chat/ChatHeader";
import { ChatMessagesList } from "../components/features/chat/ChatMessagesList";
import {
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
const LIVE_HISTORY_POLL_MS = 2_000;
const ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS = 120_000;

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
        const raw = window.localStorage.getItem(deletedMessagesStorageKey(sessionKey));
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
        window.localStorage.setItem(
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
export function sessionTimestampMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        return timestampFromDateString(value);
    }

    return null;
}

/** Performs history has newer assistant message. */
export function hasNewerAssistantMessageInHistory(
    messages: ChatHistoryMessage[],
    updatedAt?: string
): boolean {
    const streamUpdatedAt = sessionTimestampMs(updatedAt);

    if (streamUpdatedAt === null) {
        return false;
    }

    return messages.some((message) => {
        if (message.role.toLowerCase() !== "assistant" || !message.text.trim()) {
            return false;
        }

        const messageTimestamp = sessionTimestampMs(message.timestamp);
        return messageTimestamp !== null && messageTimestamp >= streamUpdatedAt;
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
    wasPrevious: string | null,
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
        const raw = window.localStorage.getItem(CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY);
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
        window.localStorage.setItem(
            CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY,
            JSON.stringify(visibility)
        );
    } catch {
        // Keep the in-memory toggle state if browser storage is unavailable.
    }
}

/** Performs supported audio recording MIME type. */
export function supportedAudioRecordingMimeType(): string | undefined {
    if (window.MediaRecorder === undefined) {
        return undefined;
    }

    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/ogg;codecs=opus",
    ];

    return candidates.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType));
}

/** Renders the chat UI. */
export function Chat() {
    const { connectionId, isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const messagesBottomReference = useRef<HTMLDivElement | null>(null);
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const shouldStickToBottomReference = useRef(true);
    const lastKnownMessagesScrollTopReference = useRef(0);
    const activeStreamsReference = useRef<ActiveChatStreams>({});
    const liveHistoryRefreshTimerReference = useRef<number | null>(null);
    const backgroundHistoryRefreshAbortReference = useRef<AbortController | null>(null);
    const mediaRecorderReference = useRef<MediaRecorder | null>(null);
    const recordingChunksReference = useRef<Blob[]>([]);
    const voiceFileInputReference = useRef<HTMLInputElement | null>(null);
    const loadedHistorySessionReference = useRef("");
    const selectedSessionKeyReference = useRef("");
    const previousChatRowsLengthReference = useRef(0);
    const previousSelectedSessionKeyReference = useRef("");
    const previousSelectedStreamTextReference = useRef("");
    const bottomFollowFrameReference = useRef<number | null>(null);
    const sendInFlightCountReference = useRef(0);
    const sendEpochReference = useRef(0);
    const resetConfirmResolverReference = useRef<
        ((wasConfirmed: boolean) => void) | null
    >(null);

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>({});
    const [sendError, setSendError] = useState<string | null>(null);
    const [deletedMessageKeys, setDeletedMessageKeys] = useState<Set<string>>(
        () => new Set()
    );
    const [pendingDeleteMessageKey, setPendingDeleteMessageKey] = useState<string | null>(
        null
    );
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | null>(null);
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

    const sortedSessions = sortSessionsByTypeAndActivity(sessions);
    const sessionMap = new Map(sortedSessions.map((session) => [session.key, session]));
    const selectedSessionUpdatedAt = selectedSessionKey
        ? sessionMap.get(selectedSessionKey)?.updatedAt
        : null;
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || null
        : null;
    selectedSessionKeyReference.current = selectedSessionKey;
    const selectedAgentId = selectedSession ? getChatAgentId(selectedSession) : "";
    const sessionsForSelectedAgent = selectedAgentId
        ? sortedSessions.filter((session) => getChatAgentId(session) === selectedAgentId)
        : sortedSessions;
    const selectedStream = selectedSessionKey
        ? activeStreams[selectedSessionKey]
        : undefined;
    const selectedStreamText = selectedStream?.text || "";
    const selectedStreamMessage = selectedStream?.message;
    const chatVisibility = createChatVisibility(showThinkingOutput, showToolOutput);
    const visibleMessagesForRows = dedupeMessages(messages).filter(
        (message) =>
            !deletedMessageKeys.has(messageDeleteKey(message)) &&
            isRenderableChatHistoryMessage(message, chatVisibility)
    );
    const selectedStreamUpdatedAt = sessionTimestampMs(selectedStream?.updatedAt);
    const isSelectedStreamIsQuiet =
        selectedStreamUpdatedAt === null ||
        Date.now() - selectedStreamUpdatedAt >= ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS;
    const isSelectedStreamIsRecoveredInMessages = Boolean(
        selectedStreamText.trim() &&
        visibleMessagesForRows.some((message) => {
            if (message.role.toLowerCase() !== "assistant") {
                return false;
            }

            if (message.text.trim() === selectedStreamText.trim()) {
                return true;
            }

            return (
                isSelectedStreamIsQuiet &&
                isRecoveredAssistantText(message.text, selectedStreamText)
            );
        })
    );
    const shouldShowSelectedStreamRow =
        !isSelectedStreamIsRecoveredInMessages &&
        shouldRenderStreamRow(selectedStreamText, selectedStreamMessage, chatVisibility);
    const shouldShowTypingIndicator = Boolean(
        selectedStream &&
        !isSelectedStreamIsRecoveredInMessages &&
        (selectedStream.statusText || !shouldShowSelectedStreamRow)
    );
    const chatRows: ChatRow[] = visibleMessagesForRows.map((message) => ({
        key: messageDeleteKey(message),
        kind: "message",
        message,
    }));

    if (shouldShowSelectedStreamRow) {
        chatRows.push({
            key: `stream-${selectedSessionKey}`,
            kind: "stream",
            message: selectedStreamMessage || {
                role: "assistant",
                content: selectedStreamText,
                text: selectedStreamText,
            },
        });
    }

    if (shouldShowTypingIndicator) {
        const typingStream = selectedStream!;
        chatRows.push({
            key: `typing-${selectedSessionKey}-${typingStream.statusText || "working"}`,
            kind: "typing",
            message: {
                role: "assistant",
                content: typingStream.statusText || "Thinking",
                text: typingStream.statusText || "Thinking",
            },
        });
    }

    useEffect(() => {
        if (sortedSessions.length === 0) {
            if (selectedSessionKey) {
                setSelectedSessionKey("");
            }
            setIsLoadingHistory(false);
            return;
        }

        if (!selectedSessionKey || !sessionMap.has(selectedSessionKey)) {
            const fallbackSession = sortedSessions.find(
                (session) => session.key && sessionMap.has(session.key)
            );
            setSelectedSessionKey(fallbackSession?.key || "");
        }
    }, [selectedSessionKey, sessionMap, sortedSessions]);

    useEffect(() => {
        setDeletedMessageKeys(
            selectedSessionKey ? readDeletedMessageKeys(selectedSessionKey) : new Set()
        );
        setPendingDeleteMessageKey(null);
    }, [selectedSessionKey]);

    useEffect(() => {
        if (!isConnected) {
            sendEpochReference.current += 1;
            sendInFlightCountReference.current = 0;
            setIsSending(false);

            updateActiveStreams(() => ({}));

            if (liveHistoryRefreshTimerReference.current !== null) {
                window.clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = null;
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
            setSendError(null);

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

        /** Performs refresh history. */
        const refreshHistory = async () => {
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
                    const activeStream =
                        activeStreamsReference.current[requestSessionKey];
                    const activeStreamUpdatedAt = sessionTimestampMs(
                        activeStream?.updatedAt
                    );
                    const isActiveStreamIsQuiet =
                        activeStreamUpdatedAt === null ||
                        Date.now() - activeStreamUpdatedAt >=
                            ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS;
                    const isRecoveredStreamInHistory = Boolean(
                        activeStream &&
                        isActiveStreamIsQuiet &&
                        ((activeStream.text &&
                            hasRecoveredStreamHistory(nextMessages, activeStream.text)) ||
                            hasNewerAssistantMessageInHistory(
                                nextMessages,
                                activeStream.updatedAt
                            ))
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

                        return mergeWithRecentOptimisticMessages(
                            wasPrevious,
                            nextMessages
                        );
                    });
                    setIsAtBottom(shouldStickToBottomReference.current);
                    if (isRecoveredStreamInHistory) {
                        updateActiveStreams((wasPrevious) => {
                            const next = { ...wasPrevious };
                            delete next[requestSessionKey];
                            return next;
                        });
                    }
                } catch {
                    // Ignore background refresh failures.
                }
            };

            await refreshVisibleHistory();
        };

        void refreshHistory();

        return () => {
            isCancelled = true;
            abortController.abort();
            backgroundHistoryRefreshAbortReference.current = null;
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

        const interval = window.setInterval(
            () => void refreshVisibleHistory(),
            LIVE_HISTORY_POLL_MS
        );

        return () => {
            isCancelled = true;
            window.clearInterval(interval);
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
        if (bottomFollowFrameReference.current !== null) {
            return;
        }

        bottomFollowFrameReference.current = requestAnimationFrame(() => {
            bottomFollowFrameReference.current = null;
            scrollMessagesToBottom();
        });
    };

    const messagesVirtualizer = useVirtualizer({
        count: chatRows.length,
        getItemKey: (index) => chatRows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current,
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
            previousSelectedStreamTextReference.current !== selectedStreamText;

        previousSelectedSessionKeyReference.current = selectedSessionKey;
        previousChatRowsLengthReference.current = chatRows.length;
        previousSelectedStreamTextReference.current = selectedStreamText;

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
    }, [chatRows.length, selectedStreamText, selectedSessionKey]);

    const sessionOptions = sessionsForSelectedAgent
        .filter(hasSessionKey)
        .map((session) => ({
            value: session.key,
            label: formatChatSessionLabel(session, selectedAgentId),
            description: `${formatSessionType(session)} · ${session.model || "Unknown"}`,
        }));

    const selectableSessions = sortedSessions.filter(hasSessionKey);
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
        setPendingDeleteMessageKey(null);
    };

    /** Resolves a pending reset confirmation and hides the modal. */
    const closeResetConfirm = (wasConfirmed: boolean) => {
        resetConfirmResolverReference.current?.(wasConfirmed);
        resetConfirmResolverReference.current = null;
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
            resetConfirmResolverReference.current = null;
        };
    }, []);

    /** Responds to files selected events. */
    const handleFilesSelected = async (files: FileList | null) => {
        if (!files || files.length === 0) {
            return;
        }

        setSendError(null);

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
        setSendError(null);

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
    const handleVoiceFileSelected = async (files: FileList | null) => {
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
            window.MediaRecorder !== undefined;

        if (!canUseDirectRecorder) {
            setSendError(
                window.isSecureContext
                    ? "Direct voice recording is not supported here. Choose or record an audio file instead."
                    : "Direct voice recording requires HTTPS or localhost. Choose or record an audio file instead."
            );
            voiceFileInputReference.current?.click();
            return;
        }

        let stream: MediaStream | null = null;

        try {
            setSendError(null);
            stream = await mediaDevices!.getUserMedia({ audio: true });
            const recordingStream = stream;
            const mimeType = supportedAudioRecordingMimeType();
            const recorder = mimeType
                ? new window.MediaRecorder(recordingStream, { mimeType })
                : new window.MediaRecorder(recordingStream);
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
                mediaRecorderReference.current = null;
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
        setSendError(null);
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
                updateActiveStreams((wasPrevious) => {
                    const next = { ...wasPrevious };
                    delete next[selectedSessionKey];
                    return next;
                });
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
            updateActiveStreams((wasPrevious) => {
                const next = { ...wasPrevious };
                delete next[selectedSessionKey];
                return next;
            });
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
                        ref={voiceFileInputReference}
                        type="file"
                        accept="audio/*"
                        capture
                        className="hidden"
                        onChange={(event) =>
                            void handleVoiceFileSelected(event.target.files)
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
                onClose={() => setPreviewItem(null)}
            />

            <ConfirmModal
                isOpen={!!pendingDeleteMessageKey}
                title="Delete message"
                message="Delete this message from your chat view?"
                confirmLabel="Delete"
                danger
                onCancel={() => setPendingDeleteMessageKey(null)}
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
