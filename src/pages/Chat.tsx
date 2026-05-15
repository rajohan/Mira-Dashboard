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
    historyContainsRecoveredStream,
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
    optimisticAttachmentDisplay,
    type RawChatHistoryMessage,
} from "../components/features/chat/chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    type ChatModelOption,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    readFileAsDataUrl,
} from "../components/features/chat/chatUtils";
import { buildSlashCommandSuggestions } from "../components/features/chat/slashCommands";
import { useChatRuntimeEvents } from "../components/features/chat/useChatRuntimeEvents";
import { useChatSlashCommands } from "../components/features/chat/useChatSlashCommands";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatSize } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

const CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY =
    "mira-dashboard-chat-diagnostic-visibility";
const CHAT_BOTTOM_THRESHOLD_PX = 32;
const LIVE_HISTORY_POLL_MS = 2_000;
const ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS = 120_000;

/** Performs deleted messages storage key. */
function deletedMessagesStorageKey(sessionKey: string): string {
    return `openclaw:deleted:${sessionKey}`;
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
        const timestamp = new Date(value).getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    return null;
}

/** Performs history has newer assistant message. */
export function historyHasNewerAssistantMessage(
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

/** Performs supported audio recording mime type. */
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
    const { isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const messagesBottomReference = useRef<HTMLDivElement | null>(null);
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const shouldStickToBottomReference = useRef(true);
    const lastKnownMessagesScrollTopReference = useRef(0);
    const activeStreamsReference = useRef<ActiveChatStreams>({});
    const liveHistoryRefreshTimerReference = useRef<number | null>(null);
    const mediaRecorderReference = useRef<MediaRecorder | null>(null);
    const recordingChunksReference = useRef<Blob[]>([]);
    const voiceFileInputReference = useRef<HTMLInputElement | null>(null);
    const loadedHistorySessionReference = useRef("");
    const previousChatRowsLengthReference = useRef(0);
    const previousSelectedSessionKeyReference = useRef("");
    const previousSelectedStreamTextReference = useRef("");
    const bottomFollowFrameReference = useRef<number | null>(null);
    const sendInFlightReference = useRef(false);

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
        updater: (previous: ActiveChatStreams) => ActiveChatStreams
    ) => {
        setActiveStreams((previous) => {
            const next = updater(previous);
            activeStreamsReference.current = next;
            return next;
        });
    };

    const sortedSessions = sortSessionsByTypeAndActivity(sessions || []);
    const sessionMap = new Map(sortedSessions.map((session) => [session.key, session]));
    const selectedSessionUpdatedAt = selectedSessionKey
        ? sessionMap.get(selectedSessionKey)?.updatedAt
        : null;
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || null
        : null;
    const selectedStream = selectedSessionKey
        ? activeStreams[selectedSessionKey]
        : undefined;
    const selectedStreamText = selectedStream?.text || "";
    const selectedStreamMessage = selectedStream?.message;
    const shouldShowSelectedStreamRow = shouldRenderStreamRow(
        selectedStreamText,
        selectedStreamMessage,
        createChatVisibility(showThinkingOutput, showToolOutput)
    );
    const shouldShowTypingIndicator = Boolean(
        selectedStream && (selectedStream.statusText || !shouldShowSelectedStreamRow)
    );
    const visibleMessagesForRows = dedupeMessages(messages).filter(
        (message) => !deletedMessageKeys.has(messageDeleteKey(message))
    );
    const chatRows: ChatRow[] = visibleMessagesForRows.map((message) => ({
        key: messageDeleteKey(message),
        kind: "message",
        message,
    }));

    if (shouldShowSelectedStreamRow) {
        chatRows.push({
            key: `stream-${selectedSessionKey || "none"}`,
            kind: "stream",
            message: selectedStreamMessage || {
                role: "assistant",
                content: selectedStreamText,
                text: selectedStreamText,
            },
        });
    }

    if (shouldShowTypingIndicator) {
        chatRows.push({
            key: `typing-${selectedSessionKey || "none"}-${selectedStream?.statusText || "working"}`,
            kind: "typing",
            message: {
                role: "assistant",
                content: selectedStream?.statusText || "Thinking",
                text: selectedStream?.statusText || "Thinking",
            },
        });
    }

    useEffect(() => {
        if (!selectedSessionKey && sortedSessions.length > 0) {
            setSelectedSessionKey(sortedSessions[0]?.key || "");
        }
    }, [sortedSessions, selectedSessionKey]);

    useEffect(() => {
        setDeletedMessageKeys(
            selectedSessionKey ? readDeletedMessageKeys(selectedSessionKey) : new Set()
        );
        setPendingDeleteMessageKey(null);
    }, [selectedSessionKey]);

    useEffect(() => {
        if (!isConnected) {
            sendInFlightReference.current = false;
            setIsSending(false);

            if (selectedSessionKey) {
                updateActiveStreams((previous) => {
                    if (!previous[selectedSessionKey]) {
                        return previous;
                    }

                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
            }

            if (liveHistoryRefreshTimerReference.current !== null) {
                window.clearTimeout(liveHistoryRefreshTimerReference.current);
                liveHistoryRefreshTimerReference.current = null;
            }

            return;
        }

        let cancelled = false;

        /** Performs load models. */
        const loadModels = async () => {
            try {
                const result = (await request("models.list", {
                    view: "configured",
                })) as { models?: ChatModelOption[] };

                if (!cancelled) {
                    setChatModelOptions(result.models || []);
                }
            } catch {
                if (!cancelled) {
                    setChatModelOptions([]);
                }
            }
        };

        void loadModels();

        return () => {
            cancelled = true;
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

        let cancelled = false;

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

                if (cancelled) {
                    return;
                }

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );
                setMessages((previous) => {
                    if (loadedHistorySessionReference.current !== selectedSessionKey) {
                        loadedHistorySessionReference.current = selectedSessionKey;
                        return nextMessages;
                    }

                    return mergeWithRecentOptimisticMessages(previous, nextMessages);
                });
                if (isNewSession) {
                    shouldStickToBottomReference.current = true;
                    setIsAtBottom(true);
                } else if (shouldStickToBottomReference.current) {
                    setIsAtBottom(true);
                }
                setHistoryLoadVersion((previous) => previous + 1);
            } catch (error_) {
                if (!cancelled) {
                    setSendError(
                        (error_ as Error).message || "Failed to load chat history"
                    );
                }
            } finally {
                if (!cancelled) {
                    setIsLoadingHistory(false);
                }
            }
        };

        void loadHistory();

        return () => {
            cancelled = true;
        };
    }, [isConnected, request, selectedSessionKey, showThinkingOutput, showToolOutput]);
    useEffect(() => {
        if (!selectedSessionKey || !selectedSessionUpdatedAt || isLoadingHistory) {
            return;
        }

        /** Performs refresh history. */
        const refreshHistory = async () => {
            if (!shouldStickToBottomReference.current) {
                return;
            }

            try {
                const result = (await request("chat.history", {
                    sessionKey: selectedSessionKey,
                    limit: CHAT_HISTORY_LIMIT,
                })) as {
                    messages?: RawChatHistoryMessage[];
                };

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );
                const activeStream = activeStreamsReference.current[selectedSessionKey];
                const activeStreamUpdatedAt = sessionTimestampMs(activeStream?.updatedAt);
                const activeStreamIsQuiet =
                    activeStreamUpdatedAt === null ||
                    Date.now() - activeStreamUpdatedAt >=
                        ACTIVE_STREAM_HISTORY_RECOVERY_GRACE_MS;
                const recoveredStreamInHistory = Boolean(
                    activeStream &&
                    activeStreamIsQuiet &&
                    ((activeStream.text &&
                        historyContainsRecoveredStream(
                            nextMessages,
                            activeStream.text
                        )) ||
                        historyHasNewerAssistantMessage(
                            nextMessages,
                            activeStream.updatedAt
                        ))
                );

                setMessages((previous) => {
                    const previousLast = previous.at(-1)?.timestamp || "";
                    const nextLast = nextMessages.at(-1)?.timestamp || "";

                    if (
                        previous.length === nextMessages.length &&
                        previousLast === nextLast
                    ) {
                        return previous;
                    }

                    if (shouldStickToBottomReference.current) {
                        setIsAtBottom(true);
                    }

                    return mergeWithRecentOptimisticMessages(previous, nextMessages);
                });

                if (recoveredStreamInHistory) {
                    updateActiveStreams((previous) => {
                        const next = { ...previous };
                        delete next[selectedSessionKey];
                        return next;
                    });
                }
            } catch {
                // Ignore background refresh failures.
            }
        };

        void refreshHistory();
    }, [
        isLoadingHistory,
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

        let cancelled = false;
        let refreshInFlight = false;

        /** Performs refresh visible history. */
        const refreshVisibleHistory = async () => {
            if (
                refreshInFlight ||
                document.visibilityState === "hidden" ||
                !shouldStickToBottomReference.current
            ) {
                return;
            }

            refreshInFlight = true;

            try {
                const result = (await request("chat.history", {
                    sessionKey: selectedSessionKey,
                    limit: CHAT_HISTORY_LIMIT,
                })) as {
                    messages?: RawChatHistoryMessage[];
                };

                if (cancelled) {
                    return;
                }

                const nextMessages = visibleHistoryMessages(
                    result.messages,
                    createChatVisibility(showThinkingOutput, showToolOutput)
                );

                setMessages((previous) => {
                    const previousLast = previous.at(-1)?.timestamp || "";
                    const nextLast = nextMessages.at(-1)?.timestamp || "";

                    if (
                        previous.length === nextMessages.length &&
                        previousLast === nextLast
                    ) {
                        return previous;
                    }

                    return mergeWithRecentOptimisticMessages(previous, nextMessages);
                });

                if (shouldStickToBottomReference.current) {
                    setIsAtBottom(true);
                }
                setHistoryLoadVersion((previous) => previous + 1);
            } catch {
                // Opportunistic live refresh; WebSocket events remain the primary path.
            } finally {
                refreshInFlight = false;
            }
        };

        const interval = window.setInterval(
            () => void refreshVisibleHistory(),
            LIVE_HISTORY_POLL_MS
        );

        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [isConnected, request, selectedSessionKey, showThinkingOutput, showToolOutput]);

    useChatRuntimeEvents({
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
        setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
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
        if (shouldStickToBottomReference.current) {
            scheduleBottomFollow();
        }
    };

    useLayoutEffect(() => {
        const sessionChanged =
            previousSelectedSessionKeyReference.current !== selectedSessionKey;
        const rowsWereAdded = chatRows.length > previousChatRowsLengthReference.current;
        const streamTextChanged =
            previousSelectedStreamTextReference.current !== selectedStreamText;

        previousSelectedSessionKeyReference.current = selectedSessionKey;
        previousChatRowsLengthReference.current = chatRows.length;
        previousSelectedStreamTextReference.current = selectedStreamText;

        if (chatRows.length === 0) {
            return;
        }

        if (sessionChanged) {
            shouldStickToBottomReference.current = true;
            scrollMessagesToBottom();
            return;
        }

        if (
            !shouldStickToBottomReference.current ||
            (!rowsWereAdded && !streamTextChanged)
        ) {
            return;
        }

        scrollMessagesToBottom();

        const scrollFrame = requestAnimationFrame(scrollMessagesToBottom);

        return () => cancelAnimationFrame(scrollFrame);
    }, [chatRows.length, selectedStreamText, selectedSessionKey]);

    const sessionOptions = sortedSessions.map((session) => ({
        value: session.key,
        label:
            session.displayLabel || session.label || session.displayName || session.key,
        description: `${formatSessionType(session)} · ${session.model || "Unknown"}`,
    }));

    const agentOptions = agents
        .filter((agent) => agent.sessionKey)
        .map((agent) => ({
            value: agent.sessionKey as string,
            label: agent.id,
            description: agent.currentTask || agent.model || agent.status || "agent",
        }));

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

        setDeletedMessageKeys((previous) => {
            const next = new Set(previous);
            next.add(pendingDeleteMessageKey);
            writeDeletedMessageKeys(selectedSessionKey, next);
            return next;
        });
        setPendingDeleteMessageKey(null);
    };

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

            setAttachments((previous) => [...previous, ...nextAttachments]);
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to read attachment");
        } finally {
            if (fileInputReference.current) {
                fileInputReference.current.value = "";
            }
        }
    };

    /** Performs remove attachment. */
    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) =>
            previous.filter((attachment) => attachment.id !== attachmentId)
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
                const error = (await response
                    .json()
                    .catch(() => ({ error: "Failed to transcribe audio" }))) as {
                    error?: string;
                };
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const result = (await response.json()) as { text?: string };
            const text = result.text?.trim();
            if (!text) {
                setSendError("Whisper did not detect any speech.");
                return;
            }

            setDraft((previous) => {
                const trimmedPrevious = previous.trimEnd();
                return trimmedPrevious ? `${trimmedPrevious}\n${text}` : text;
            });
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to transcribe audio");
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
            setSendError((error_ as Error).message || "Failed to read audio file");
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
            setSendError((error_ as Error).message || "Failed to start recording");
        }
    };

    const handleSlashCommand = useChatSlashCommands({
        request,
        selectedSession,
        selectedSessionKey,
        attachments,
        chatModelOptions,
        showThinkingOutput,
        showToolOutput,
        updateActiveStreams,
        setMessages,
        setDraft,
        setSendError,
        setIsSending,
        setIsAtBottom,
        setHistoryLoadVersion,
        shouldStickToBottomReference,
    });

    /** Responds to send events. */
    const handleSend = async () => {
        if (!selectedSessionKey || isSending || sendInFlightReference.current) {
            return;
        }

        sendInFlightReference.current = true;

        const text = draft.trim();
        if (!text && attachments.length === 0) {
            sendInFlightReference.current = false;
            return;
        }

        if (text.startsWith("/")) {
            const handledCommand = await handleSlashCommand(text);
            if (handledCommand) {
                sendInFlightReference.current = false;
                return;
            }
        }

        const messageText = text;
        const sendAttachments = attachments;
        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: messageText,
            text: messageText,
            images: [],
            attachments: optimisticAttachmentDisplay(sendAttachments),
            timestamp: new Date().toISOString(),
        };

        setMessages((previous) => dedupeMessages([...previous, userMessage]));
        setDraft("");
        setAttachments([]);
        setSendError(null);
        setIsSending(true);
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        scheduleBottomFollow();

        const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        updateActiveStreams((previous) => ({
            ...previous,
            [selectedSessionKey]: {
                sessionKey: selectedSessionKey,
                runId: idempotencyKey,
                aliases: [idempotencyKey],
                text: "",
                statusText: "Thinking",
                updatedAt: new Date().toISOString(),
            },
        }));

        try {
            if (selectedSession?.verboseLevel !== "full") {
                await request("sessions.patch", {
                    key: selectedSessionKey,
                    verboseLevel: "full",
                });
            }

            const result = (await request("chat.send", {
                sessionKey: selectedSessionKey,
                message: messageText,
                attachments: gatewayAttachments(sendAttachments),
                deliver: false,
                idempotencyKey,
            })) as { runId?: string } | undefined;
            const acknowledgedRunId = result?.runId;
            if (acknowledgedRunId) {
                updateActiveStreams((previous) => {
                    const existing = previous[selectedSessionKey];
                    if (!existing) {
                        return previous;
                    }

                    return {
                        ...previous,
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
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to send message");
            updateActiveStreams((previous) => {
                const next = { ...previous };
                delete next[selectedSessionKey];
                return next;
            });
        } finally {
            sendInFlightReference.current = false;
            setIsSending(false);
        }
    };

    const canSend = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isSending &&
        !isRecording &&
        !isTranscribing &&
        (draft.trim() || attachments.length > 0)
    );

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-3 sm:p-4 lg:p-6">
            <div className="min-h-0 flex-1">
                <Card className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent p-0">
                    <ChatHeader
                        selectedSession={selectedSession}
                        selectedSessionKey={selectedSessionKey}
                        sessionOptions={sessionOptions}
                        agentOptions={agentOptions}
                        showThinking={showThinkingOutput}
                        showTools={showToolOutput}
                        onToggleThinking={() =>
                            setShowThinkingOutput((previous) => !previous)
                        }
                        onToggleTools={() => setShowToolOutput((previous) => !previous)}
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
        </div>
    );
}
