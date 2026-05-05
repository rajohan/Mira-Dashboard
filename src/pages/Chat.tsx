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
    clearActiveRunMarker,
    dataUrlToBase64,
    displayMimeType,
    hasActiveRunMarker,
    markActiveRun,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    mergeWithRecentOptimisticMessages,
    readFileAsDataUrl,
} from "../components/features/chat/chatUtils";
import { buildSlashCommandSuggestions } from "../components/features/chat/slashCommands";
import { useChatRuntimeEvents } from "../components/features/chat/useChatRuntimeEvents";
import { useChatSlashCommands } from "../components/features/chat/useChatSlashCommands";
import { Card } from "../components/ui/Card";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatSize } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

const CHAT_DIAGNOSTIC_VISIBILITY_STORAGE_KEY =
    "mira-dashboard-chat-diagnostic-visibility";
const CHAT_BOTTOM_THRESHOLD_PX = 32;

interface StoredChatDiagnosticVisibility {
    thinking: boolean;
    tools: boolean;
}

function readStoredChatDiagnosticVisibility(): StoredChatDiagnosticVisibility {
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

function writeStoredChatDiagnosticVisibility(
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

export function Chat() {
    const { isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const shouldStickToBottomReference = useRef(true);
    const activeStreamsReference = useRef<ActiveChatStreams>({});
    const liveHistoryRefreshTimerReference = useRef<number | null>(null);
    const loadedHistorySessionReference = useRef("");

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>({});
    const [sendError, setSendError] = useState<string | null>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isAssistantTyping, setIsAssistantTyping] = useState(false);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | null>(null);
    const [showThinkingOutput, setShowThinkingOutput] = useState(
        () => readStoredChatDiagnosticVisibility().thinking
    );
    const [showToolOutput, setShowToolOutput] = useState(
        () => readStoredChatDiagnosticVisibility().tools
    );
    const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
    const [historyLoadVersion, setHistoryLoadVersion] = useState(0);

    const { data: sessions = [] } = useLiveQuery((query) =>
        query.from({ session: sessionsCollection })
    );
    const { data: agentsStatus } = useAgentsStatus();
    const agents = agentsStatus?.agents || [];

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
    const selectedSessionStatus = selectedSession?.status?.toLowerCase() || "";
    const selectedSessionIsRunning = Boolean(
        selectedSession &&
        (selectedSession.isRunning ||
            selectedSession.running ||
            selectedSession.activeRunId ||
            selectedSession.currentRunId ||
            ["active", "running", "thinking", "working"].includes(
                selectedSessionStatus
            )) &&
        selectedSession.endedAt == null
    );
    const selectedSessionHasActiveMarker = Boolean(
        selectedSessionKey && hasActiveRunMarker(selectedSessionKey)
    );
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
    const shouldShowTypingIndicator =
        isSending ||
        isAssistantTyping ||
        selectedSessionIsRunning ||
        selectedSessionHasActiveMarker ||
        Boolean(selectedStreamText);
    const chatRows: ChatRow[] = messages.map((message, index) => ({
        key: `${message.timestamp || index}-${index}`,
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
            key: `typing-${selectedSessionKey || "none"}`,
            kind: "typing",
            message: {
                role: "assistant",
                content: "",
                text: "",
            },
        });
    }

    useEffect(() => {
        if (!selectedSessionKey && sortedSessions.length > 0) {
            setSelectedSessionKey(sortedSessions[0]?.key || "");
        }
    }, [sortedSessions, selectedSessionKey]);

    useEffect(() => {
        if (!selectedSessionKey) {
            return;
        }

        if (selectedSessionIsRunning) {
            markActiveRun(selectedSessionKey);
            setIsAssistantTyping(true);
            return;
        }

        const interval = window.setInterval(() => {
            if (hasActiveRunMarker(selectedSessionKey)) {
                setIsAssistantTyping(true);
            }
        }, 5_000);

        return () => window.clearInterval(interval);
    }, [selectedSessionIsRunning, selectedSessionKey]);

    useEffect(() => {
        if (!isConnected) {
            return;
        }

        let cancelled = false;

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
    }, [isConnected, request]);

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
        setIsAssistantTyping(
            Boolean(selectedSessionKey && hasActiveRunMarker(selectedSessionKey))
        );

        if (!selectedSessionKey) {
            loadedHistorySessionReference.current = "";
            setMessages([]);
            return;
        }

        let cancelled = false;

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
    }, [request, selectedSessionKey, showThinkingOutput, showToolOutput]);

    useEffect(() => {
        if (!selectedSessionKey || !selectedSessionUpdatedAt || isLoadingHistory) {
            return;
        }

        const refreshHistory = async () => {
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
                const recoveredStreamInHistory = Boolean(
                    !selectedSessionIsRunning &&
                    activeStream?.text &&
                    historyContainsRecoveredStream(nextMessages, activeStream.text)
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
                    clearActiveRunMarker(selectedSessionKey);
                    setIsAssistantTyping(false);
                }
            } catch {
                // Ignore background refresh failures.
            }
        };

        void refreshHistory();
    }, [
        isLoadingHistory,
        request,
        selectedSessionIsRunning,
        selectedSessionKey,
        selectedSessionUpdatedAt,
        showThinkingOutput,
        showToolOutput,
    ]);

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
        setIsAssistantTyping,
        setIsAtBottom,
        setHistoryLoadVersion,
    });

    const messagesVirtualizer = useVirtualizer({
        count: chatRows.length,
        getItemKey: (index) => chatRows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current,
        estimateSize: (index) => (chatRows[index]?.kind === "typing" ? 76 : 160),
        overscan: 12,
    });

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

    const handleMessagesScroll = () => {
        const atBottom = checkIsAtBottom();
        shouldStickToBottomReference.current = atBottom;
        setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
    };

    const scrollMessagesToBottom = () => {
        const container = messagesContainerReference.current;
        if (!container || chatRows.length === 0) {
            return;
        }

        messagesVirtualizer.scrollToIndex(chatRows.length - 1, { align: "end" });
        container.scrollTo({ top: container.scrollHeight });
        setIsAtBottom(true);
        shouldStickToBottomReference.current = true;
    };

    const handleDynamicRowContentLoad = () => {
        messagesVirtualizer.measure();

        if (shouldStickToBottomReference.current) {
            requestAnimationFrame(() => {
                scrollMessagesToBottom();
            });
        }
    };

    useLayoutEffect(() => {
        messagesVirtualizer.measure();
    }, [
        chatRows.length,
        selectedStreamText,
        shouldShowTypingIndicator,
        messagesVirtualizer,
    ]);

    useLayoutEffect(() => {
        if (chatRows.length === 0) {
            return;
        }

        if (!shouldStickToBottomReference.current) {
            return;
        }

        scrollMessagesToBottom();

        const firstFrame = requestAnimationFrame(() => {
            messagesVirtualizer.measure();
            scrollMessagesToBottom();
        });
        const secondFrame = requestAnimationFrame(() => {
            messagesVirtualizer.measure();
            scrollMessagesToBottom();
        });
        const delayedScroll = window.setTimeout(() => {
            messagesVirtualizer.measure();
            scrollMessagesToBottom();
        }, 150);

        return () => {
            cancelAnimationFrame(firstFrame);
            cancelAnimationFrame(secondFrame);
            window.clearTimeout(delayedScroll);
        };
    }, [
        chatRows.length,
        selectedStreamText,
        shouldShowTypingIndicator,
        isAtBottom,
        messagesVirtualizer,
        selectedSessionKey,
        historyLoadVersion,
    ]);

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

    const applySlashSuggestion = (value: string) => {
        setDraft(value);
    };

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

    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) =>
            previous.filter((attachment) => attachment.id !== attachmentId)
        );
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
        setIsAssistantTyping,
        setIsAtBottom,
        setHistoryLoadVersion,
        shouldStickToBottomReference,
    });

    const handleSend = async () => {
        if (!selectedSessionKey || isSending) {
            return;
        }

        const text = draft.trim();
        if (!text && attachments.length === 0) {
            return;
        }

        if (text.startsWith("/")) {
            const handledCommand = await handleSlashCommand(text);
            if (handledCommand) {
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

        setMessages((previous) => [...previous, userMessage]);
        setDraft("");
        setAttachments([]);
        setSendError(null);
        setIsSending(true);
        setIsAssistantTyping(true);

        const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        updateActiveStreams((previous) => ({
            ...previous,
            [selectedSessionKey]: {
                sessionKey: selectedSessionKey,
                runId: idempotencyKey,
                aliases: [idempotencyKey],
                text: "",
                updatedAt: new Date().toISOString(),
            },
        }));
        markActiveRun(selectedSessionKey);

        try {
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
            setIsAssistantTyping(false);
            updateActiveStreams((previous) => {
                const next = { ...previous };
                delete next[selectedSessionKey];
                return next;
            });
            clearActiveRunMarker(selectedSessionKey);
        } finally {
            setIsSending(false);
        }
    };

    const canSend = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isSending &&
        (draft.trim() || attachments.length > 0)
    );

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-6">
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
                        chatRows={chatRows}
                        messagesContainerReference={messagesContainerReference}
                        messagesVirtualizer={messagesVirtualizer}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onPreview={setPreviewItem}
                        visibility={createChatVisibility(
                            showThinkingOutput,
                            showToolOutput
                        )}
                        onScroll={handleMessagesScroll}
                    />

                    {(sendError || error) && (
                        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                            <span>{sendError || error}</span>
                        </div>
                    )}

                    <ChatComposer
                        attachments={attachments}
                        canSend={canSend}
                        draft={draft}
                        fileInputReference={fileInputReference}
                        isConnected={isConnected}
                        isSending={isSending}
                        selectedSessionKey={selectedSessionKey}
                        slashCommandSuggestions={slashCommandSuggestions}
                        onApplySlashSuggestion={applySlashSuggestion}
                        onAttachFiles={(files) => void handleFilesSelected(files)}
                        onChangeDraft={setDraft}
                        onPreview={setPreviewItem}
                        onRemoveAttachment={removeAttachment}
                        onSend={() => void handleSend()}
                    />
                </Card>
            </div>

            <AttachmentPreviewModal
                previewItem={previewItem}
                onClose={() => setPreviewItem(null)}
            />
        </div>
    );
}
