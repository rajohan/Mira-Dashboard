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
    attachmentKind,
    type ChatHistoryMessage,
    type ChatPreviewItem,
    type ChatRow,
    type ChatSendAttachment,
    type ChatStreamEventMessage,
    gatewayAttachments,
    normalizeChatHistoryMessage,
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
import {
    buildSlashCommandSuggestions,
    ELEVATED_CHOICES,
    REASONING_CHOICES,
    SLASH_COMMANDS,
    slashCommandCanonicalName,
    THINKING_CHOICES,
    VERBOSE_CHOICES,
} from "../components/features/chat/slashCommands";
import { Card } from "../components/ui/Card";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatSize } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

export function Chat() {
    const { isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const shouldStickToBottomReference = useRef(true);

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [sendError, setSendError] = useState<string | null>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isAssistantTyping, setIsAssistantTyping] = useState(false);
    const [activeChatRunId, setActiveChatRunId] = useState<string | null>(null);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | null>(null);
    const [chatModelOptions, setChatModelOptions] = useState<ChatModelOption[]>([]);
    const [historyLoadVersion, setHistoryLoadVersion] = useState(0);

    const { data: sessions = [] } = useLiveQuery((query) =>
        query.from({ session: sessionsCollection })
    );
    const { data: agentsStatus } = useAgentsStatus();
    const agents = agentsStatus?.agents || [];

    const sortedSessions = sortSessionsByTypeAndActivity(sessions || []);
    const sessionMap = new Map(sortedSessions.map((session) => [session.key, session]));
    const selectedSessionUpdatedAt = selectedSessionKey
        ? sessionMap.get(selectedSessionKey)?.updatedAt
        : null;
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || null
        : null;
    const selectedSessionIsRunning = Boolean(
        selectedSession &&
        (selectedSession.isRunning ||
            selectedSession.running ||
            selectedSession.activeRunId ||
            selectedSession.currentRunId ||
            selectedSession.runId ||
            selectedSession.status === "running") &&
        selectedSession.endedAt == null
    );
    const shouldShowTypingIndicator = isAssistantTyping || selectedSessionIsRunning;
    const chatRows: ChatRow[] = messages.map((message, index) => ({
        key: `${message.timestamp || index}-${index}`,
        kind: "message",
        message,
    }));

    if (streamText) {
        chatRows.push({
            key: `stream-${selectedSessionKey || "none"}`,
            kind: "stream",
            message: {
                role: "assistant",
                content: streamText,
                text: streamText,
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
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        setAttachments([]);
        setIsAssistantTyping(
            Boolean(selectedSessionKey && hasActiveRunMarker(selectedSessionKey))
        );

        if (!selectedSessionKey) {
            setMessages([]);
            return;
        }

        let cancelled = false;

        const loadHistory = async () => {
            setIsLoadingHistory(true);
            setSendError(null);
            setStreamText("");

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

                setMessages((result.messages || []).map(normalizeChatHistoryMessage));
                shouldStickToBottomReference.current = true;
                setIsAtBottom(true);
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
    }, [request, selectedSessionKey]);

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

                const nextMessages = (result.messages || []).map(
                    normalizeChatHistoryMessage
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
            } catch {
                // Ignore background refresh failures.
            }
        };

        void refreshHistory();
    }, [isLoadingHistory, request, selectedSessionKey, selectedSessionUpdatedAt]);

    const messagesVirtualizer = useVirtualizer({
        count: chatRows.length,
        getItemKey: (index) => chatRows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current,
        estimateSize: (index) => (chatRows[index]?.kind === "typing" ? 76 : 160),
        overscan: 12,
    });

    useEffect(() => {
        return subscribe((raw) => {
            const data = raw as {
                type?: string;
                event?: string;
                payload?: unknown;
            };

            if (data.type !== "event" || data.event !== "chat") {
                return;
            }

            const payload = data.payload as ChatStreamEventMessage | undefined;
            if (!payload) {
                return;
            }

            const isSelectedSessionEvent = payload.sessionKey === selectedSessionKey;
            const isActiveRunEvent = Boolean(
                activeChatRunId && payload.runId === activeChatRunId
            );

            if (!isSelectedSessionEvent && !isActiveRunEvent) {
                return;
            }

            if (payload.state === "delta") {
                const nextText = normalizeChatHistoryMessage({
                    role: "assistant",
                    content: payload.message,
                }).text;
                setIsAssistantTyping(true);
                markActiveRun(selectedSessionKey);
                setStreamText((previous) =>
                    nextText.length >= previous.length ? nextText : previous
                );
                return;
            }

            if (payload.state === "final") {
                setMessages((previous) => [
                    ...previous,
                    normalizeChatHistoryMessage({
                        role: "assistant",
                        content: payload.message,
                        timestamp: new Date().toISOString(),
                    }),
                ]);
                setStreamText("");
                setIsAssistantTyping(false);
                setActiveChatRunId(null);
                clearActiveRunMarker(selectedSessionKey);
                return;
            }

            if (payload.state === "aborted") {
                if (streamText.trim()) {
                    setMessages((previous) => [
                        ...previous,
                        {
                            role: "assistant",
                            content: streamText,
                            text: streamText,
                            images: [],
                            attachments: [],
                            timestamp: new Date().toISOString(),
                        },
                    ]);
                }
                setStreamText("");
                setIsAssistantTyping(false);
                setActiveChatRunId(null);
                clearActiveRunMarker(selectedSessionKey);
                return;
            }

            if (payload.state === "error") {
                setSendError(payload.errorMessage || "Chat request failed");
                setStreamText("");
                setIsAssistantTyping(false);
                setActiveChatRunId(null);
                clearActiveRunMarker(selectedSessionKey);
            }
        });
    }, [activeChatRunId, selectedSessionKey, streamText, subscribe]);

    const checkIsAtBottom = () => {
        const container = messagesContainerReference.current;

        if (!container) {
            return true;
        }

        return (
            container.scrollHeight - container.scrollTop - container.clientHeight < 120
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
    }, [chatRows.length, streamText, shouldShowTypingIndicator, messagesVirtualizer]);

    useLayoutEffect(() => {
        if (chatRows.length === 0) {
            return;
        }

        if (!shouldStickToBottomReference.current && !isAtBottom) {
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
        streamText,
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

    const addSystemMessage = (text: string) => {
        setMessages((previous) => [
            ...previous,
            {
                role: "system",
                content: text,
                text,
                images: [],
                attachments: [],
                timestamp: new Date().toISOString(),
            },
        ]);
    };

    const reloadChatHistory = async () => {
        if (!selectedSessionKey) {
            return;
        }

        const result = (await request("chat.history", {
            sessionKey: selectedSessionKey,
            limit: CHAT_HISTORY_LIMIT,
        })) as {
            messages?: RawChatHistoryMessage[];
        };

        setMessages((previous) =>
            mergeWithRecentOptimisticMessages(
                previous,
                (result.messages || []).map(normalizeChatHistoryMessage)
            )
        );
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        setHistoryLoadVersion((previous) => previous + 1);
    };

    const handleSlashCommand = async (commandText: string): Promise<boolean> => {
        const [rawCommand = "", ...argumentParts] = commandText.trim().split(/\s+/);
        const command = slashCommandCanonicalName(rawCommand);
        const argumentText = argumentParts.join(" ").trim();

        if (!command.startsWith("/")) {
            return false;
        }

        if (attachments.length > 0) {
            setSendError("Slash commands cannot include attachments yet.");
            return true;
        }

        const patchSession = async (patch: Record<string, unknown>) => {
            await request("sessions.patch", { key: selectedSessionKey, ...patch });
        };

        const runSimpleCommand = async (action: () => Promise<void>) => {
            setDraft("");
            setSendError(null);
            setIsSending(true);

            try {
                await action();
            } catch (error_) {
                setSendError((error_ as Error).message || `Failed to run ${rawCommand}`);
            } finally {
                setIsSending(false);
            }
        };

        if (command === "/reset" || command === "/new") {
            const confirmed = window.confirm(
                "Reset this chat session? This clears the session history/transcript for the selected target."
            );

            if (!confirmed) {
                setDraft("");
                addSystemMessage("Reset cancelled.");
                return true;
            }

            await runSimpleCommand(async () => {
                setStreamText("");
                setIsAssistantTyping(false);
                setActiveChatRunId(null);
                await request("sessions.reset", { key: selectedSessionKey });
                await reloadChatHistory();
                addSystemMessage("Session reset.");
            });

            return true;
        }

        if (command === "/stop" || command === "/abort") {
            await runSimpleCommand(async () => {
                await request("chat.abort", { sessionKey: selectedSessionKey });
                setStreamText("");
                setIsAssistantTyping(false);
                setActiveChatRunId(null);
                addSystemMessage("Stopped current run.");
            });

            return true;
        }

        setDraft("");
        setSendError(null);

        if (command === "/clear") {
            setMessages([]);
            setStreamText("");
            setIsAssistantTyping(false);
            setActiveChatRunId(null);
            addSystemMessage("Local chat view cleared. Session history was not reset.");
            return true;
        }

        if (command === "/help" || command === "/commands") {
            addSystemMessage(
                [
                    "Available slash commands:",
                    ...SLASH_COMMANDS.map(
                        (definition) =>
                            `${definition.name}${definition.args ? ` ${definition.args}` : ""} — ${definition.description}`
                    ),
                ].join("\n")
            );
            return true;
        }

        if (command === "/status") {
            if (!selectedSession) {
                addSystemMessage("No selected session.");
                return true;
            }

            const session = selectedSession as typeof selectedSession & {
                status?: string;
                model?: string;
                thinkingLevel?: string;
                fastMode?: boolean;
                verboseLevel?: string;
                reasoningLevel?: string;
                elevatedLevel?: string;
            };

            addSystemMessage(
                [
                    `Session: ${selectedSession.displayLabel || selectedSession.key}`,
                    `Status: ${session.status || "unknown"}`,
                    `Model: ${session.model || "default"}`,
                    `Thinking: ${session.thinkingLevel || "default"}`,
                    `Fast mode: ${session.fastMode ? "on" : "off"}`,
                    `Verbose: ${session.verboseLevel || "off"}`,
                    `Reasoning: ${session.reasoningLevel || "off"}`,
                    `Elevated: ${session.elevatedLevel || "off"}`,
                ].join("\n")
            );
            return true;
        }

        if (command === "/models") {
            const models = chatModelOptions
                .map((model) => model.id || model.label || model.name || "")
                .filter(Boolean);
            addSystemMessage(
                models.length > 0
                    ? `Configured models:\n${models.map((model) => `- ${model}`).join("\n")}`
                    : "No configured models returned by the gateway."
            );
            return true;
        }

        if (command === "/model") {
            if (!argumentText) {
                const models = chatModelOptions
                    .map((model) => model.id || model.label || model.name || "")
                    .filter(Boolean);
                addSystemMessage(
                    [
                        `Current model: ${selectedSession?.model || "default"}`,
                        models.length > 0
                            ? `Available: ${models.slice(0, 12).join(", ")}${models.length > 12 ? ` +${models.length - 12} more` : ""}`
                            : "No model list available.",
                    ].join("\n")
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ model: argumentText });
                addSystemMessage(`Model set to ${argumentText}.`);
            });
            return true;
        }

        if (command === "/think") {
            if (!argumentText) {
                addSystemMessage(
                    `Current thinking level: ${(selectedSession as { thinkingLevel?: string } | null)?.thinkingLevel || "default"}. Options: ${THINKING_CHOICES.join(", ")}.`
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ thinkingLevel: argumentText });
                addSystemMessage(`Thinking level set to ${argumentText}.`);
            });
            return true;
        }

        if (command === "/verbose") {
            const mode = argumentText.toLowerCase();
            if (!mode) {
                addSystemMessage(
                    `Current verbose mode: ${(selectedSession as { verboseLevel?: string } | null)?.verboseLevel || "off"}. Options: ${VERBOSE_CHOICES.join(", ")}.`
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ verboseLevel: mode });
                addSystemMessage(`Verbose mode set to ${mode}.`);
            });
            return true;
        }

        if (command === "/fast") {
            const mode = argumentText.toLowerCase();
            if (!mode || mode === "status") {
                addSystemMessage(
                    `Current fast mode: ${(selectedSession as { fastMode?: boolean } | null)?.fastMode ? "on" : "off"}. Options: status, on, off.`
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ fastMode: mode === "on" });
                addSystemMessage(`Fast mode ${mode === "on" ? "enabled" : "disabled"}.`);
            });
            return true;
        }

        if (command === "/reasoning") {
            const mode = argumentText.toLowerCase();
            if (!mode) {
                addSystemMessage(
                    `Current reasoning visibility: ${(selectedSession as { reasoningLevel?: string } | null)?.reasoningLevel || "off"}. Options: ${REASONING_CHOICES.join(", ")}.`
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ reasoningLevel: mode });
                addSystemMessage(`Reasoning visibility set to ${mode}.`);
            });
            return true;
        }

        if (command === "/elevated") {
            const mode = argumentText.toLowerCase();
            if (!mode) {
                addSystemMessage(
                    `Current elevated mode: ${(selectedSession as { elevatedLevel?: string } | null)?.elevatedLevel || "off"}. Options: ${ELEVATED_CHOICES.join(", ")}.`
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ elevatedLevel: mode });
                addSystemMessage(`Elevated mode set to ${mode}.`);
            });
            return true;
        }

        if (command === "/usage") {
            const mode = argumentText.toLowerCase();
            if (!mode) {
                const session = selectedSession as {
                    inputTokens?: number;
                    outputTokens?: number;
                    totalTokens?: number;
                } | null;
                addSystemMessage(
                    [
                        "Session usage:",
                        `Input: ${session?.inputTokens ?? "n/a"}`,
                        `Output: ${session?.outputTokens ?? "n/a"}`,
                        `Total: ${session?.totalTokens ?? "n/a"}`,
                    ].join("\n")
                );
                return true;
            }

            await runSimpleCommand(async () => {
                await patchSession({ responseUsage: mode });
                addSystemMessage(`Usage display set to ${mode}.`);
            });
            return true;
        }

        if (command === "/compact") {
            await runSimpleCommand(async () => {
                const result = (await request("sessions.compact", {
                    key: selectedSessionKey,
                })) as { compacted?: boolean; reason?: string };
                addSystemMessage(
                    result.compacted
                        ? "Context compacted successfully."
                        : `Compaction skipped${result.reason ? `: ${result.reason}` : "."}`
                );
            });
            return true;
        }

        if (command === "/exec") {
            const [execHost, execSecurity, execAsk, execNode] = argumentText.split(/\s+/);
            await runSimpleCommand(async () => {
                await patchSession({ execHost, execSecurity, execAsk, execNode });
                addSystemMessage("Exec defaults updated.");
            });
            return true;
        }

        setSendError(
            `${rawCommand} is visible in autocomplete, but is not wired in Mira Dashboard yet. Use the integrated OpenClaw chat for that command for now.`
        );
        return true;
    };

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
        setStreamText("");
        setIsSending(true);
        setIsAssistantTyping(true);
        markActiveRun(selectedSessionKey);

        try {
            const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const result = (await request("chat.send", {
                sessionKey: selectedSessionKey,
                message: messageText,
                attachments: gatewayAttachments(sendAttachments),
                deliver: false,
                idempotencyKey,
            })) as { runId?: string } | undefined;
            setActiveChatRunId(result?.runId || idempotencyKey);
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to send message");
            setIsAssistantTyping(false);
            setActiveChatRunId(null);
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
                        onSelectSession={setSelectedSessionKey}
                    />

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        chatRows={chatRows}
                        messagesContainerReference={messagesContainerReference}
                        messagesVirtualizer={messagesVirtualizer}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onPreview={setPreviewItem}
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
