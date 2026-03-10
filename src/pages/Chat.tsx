import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { ChatMessagesList } from "../components/features/chat/ChatMessagesList";
import {
    extractImages,
    normalizeText,
    type ChatHistoryMessage,
    type ChatRow,
    type ChatStreamEventMessage,
} from "../components/features/chat/chatTypes";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatDuration } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

export function Chat() {
    const { isConnected, error, request, subscribe } = useOpenClawSocket();
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomReference = useRef(true);

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [sendError, setSendError] = useState<string | null>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);

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

    useEffect(() => {
        if (!selectedSessionKey && sortedSessions.length > 0) {
            setSelectedSessionKey(sortedSessions[0]?.key || "");
        }
    }, [sortedSessions, selectedSessionKey]);

    useEffect(() => {
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);

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
                    limit: 200,
                })) as {
                    messages?: Array<{
                        role?: string;
                        content?: unknown;
                        timestamp?: string;
                    }>;
                };

                if (cancelled) {
                    return;
                }

                const nextMessages = (result.messages || []).map((message) => ({
                    role: message.role || "unknown",
                    content: message.content,
                    text: normalizeText(message.content),
                    images: extractImages(message.content),
                    timestamp: message.timestamp,
                }));

                setMessages(nextMessages);
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
                    limit: 200,
                })) as {
                    messages?: Array<{
                        role?: string;
                        content?: unknown;
                        timestamp?: string;
                    }>;
                };

                const nextMessages = (result.messages || []).map((message) => ({
                    role: message.role || "unknown",
                    content: message.content,
                    text: normalizeText(message.content),
                    images: extractImages(message.content),
                    timestamp: message.timestamp,
                }));

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

                    return nextMessages;
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
        estimateSize: () => 120,
        measureElement: (element) => element.getBoundingClientRect().height,
        overscan: 8,
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
            if (!payload || payload.sessionKey !== selectedSessionKey) {
                return;
            }

            if (payload.state === "delta") {
                const nextText = normalizeText(payload.message);
                setStreamText((previous) =>
                    nextText.length >= previous.length ? nextText : previous
                );
                return;
            }

            if (payload.state === "final") {
                const text = normalizeText(payload.message);
                setMessages((previous) => [
                    ...previous,
                    {
                        role: "assistant",
                        content: payload.message,
                        text,
                        images: extractImages(payload.message),
                        timestamp: new Date().toISOString(),
                    },
                ]);
                setStreamText("");
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
                            timestamp: new Date().toISOString(),
                        },
                    ]);
                }
                setStreamText("");
                return;
            }

            if (payload.state === "error") {
                setSendError(payload.errorMessage || "Chat request failed");
                setStreamText("");
            }
        });
    }, [selectedSessionKey, streamText, subscribe]);

    const checkIsAtBottom = () => {
        const container = messagesContainerReference.current;
        if (!container) {
            return true;
        }

        return container.scrollHeight - container.scrollTop - container.clientHeight < 30;
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

        const lastIndex = chatRows.length - 1;
        container.scrollTop = container.scrollHeight;
        messagesVirtualizer.scrollToIndex(lastIndex, { align: "end" });
        setIsAtBottom(true);
        shouldStickToBottomReference.current = true;
    };

    useEffect(() => {
        messagesVirtualizer.measure();
    }, [chatRows.length, streamText, messagesVirtualizer]);

    useLayoutEffect(() => {
        if (chatRows.length === 0) {
            return;
        }

        if (!shouldStickToBottomReference.current && !isAtBottom) {
            return;
        }

        scrollMessagesToBottom();

        requestAnimationFrame(() => {
            scrollMessagesToBottom();
        });
    }, [
        chatRows.length,
        streamText,
        isAtBottom,
        messagesVirtualizer,
        selectedSessionKey,
    ]);

    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || null
        : null;

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

    const handleSend = async () => {
        if (!selectedSessionKey) {
            return;
        }

        const text = draft.trim();
        if (!text) {
            return;
        }

        const messageText = text;
        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: messageText,
            text: messageText,
            images: [],
            timestamp: new Date().toISOString(),
        };

        setMessages((previous) => [...previous, userMessage]);
        setDraft("");
        setSendError(null);
        setStreamText("");

        try {
            const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await request("chat.send", {
                sessionKey: selectedSessionKey,
                message: messageText,
                deliver: false,
                idempotencyKey,
            });
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to send message");
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-6">
            <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                <Card className="flex h-full min-h-0 flex-col space-y-4">
                    <div>
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                            Chat target
                        </h2>
                        <p className="mt-1 text-sm text-primary-400">
                            Choose which session this chat panel should talk to.
                        </p>
                    </div>

                    <div className="space-y-3">
                        <div className="space-y-1">
                            <div className="text-xs font-medium uppercase tracking-wide text-primary-500">
                                Session
                            </div>
                            <Select
                                value={selectedSessionKey}
                                onChange={setSelectedSessionKey}
                                options={sessionOptions}
                                placeholder="Select session"
                                width="w-full"
                                menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                            />
                        </div>
                        {agentOptions.length > 0 ? (
                            <div className="space-y-1">
                                <div className="text-xs font-medium uppercase tracking-wide text-primary-500">
                                    Active agent
                                </div>
                                <Select
                                    value=""
                                    onChange={setSelectedSessionKey}
                                    options={agentOptions}
                                    placeholder="Jump to agent session"
                                    width="w-full"
                                    menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                                />
                            </div>
                        ) : null}
                    </div>

                    {selectedSession ? (
                        <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3 text-sm text-primary-300">
                            <div className="font-medium text-primary-100">
                                {selectedSession.displayLabel ||
                                    selectedSession.label ||
                                    selectedSession.displayName ||
                                    selectedSession.key}
                            </div>
                            <div className="mt-1">
                                {formatSessionType(selectedSession)}
                            </div>
                            <div className="mt-1">
                                Model: {selectedSession.model || "Unknown"}
                            </div>
                            <div className="mt-1">
                                Last active: {formatDuration(selectedSession.updatedAt)}
                            </div>
                        </div>
                    ) : (
                        <EmptyState message="Pick a target session before chatting." />
                    )}
                </Card>

                <Card className="flex h-full min-h-0 flex-col overflow-hidden">
                    <div className="border-b border-primary-700 pb-3">
                        <h2 className="text-lg font-semibold text-primary-50">
                            Chat
                        </h2>
                        <p className="text-sm text-primary-400">
                            {selectedSession
                                ? selectedSession.displayLabel || selectedSession.key
                                : "Choose a session to begin"}
                        </p>
                    </div>

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        chatRows={chatRows}
                        messagesContainerReference={messagesContainerReference}
                        onScroll={handleMessagesScroll}
                        messagesVirtualizer={messagesVirtualizer}
                    />

                    <div className="mt-4 border-t border-primary-700 pt-4">
                        {sendError || error ? (
                            <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                                <span>{sendError || error}</span>
                            </div>
                        ) : null}

                        <div className="flex gap-3">
                            <div className="flex-1">
                                <Textarea
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (
                                            event.key === "Enter" &&
                                            !event.shiftKey &&
                                            !event.nativeEvent.isComposing
                                        ) {
                                            event.preventDefault();
                                            void handleSend();
                                        }
                                    }}
                                    disabled={!selectedSessionKey || !isConnected}
                                    placeholder={
                                        selectedSessionKey
                                            ? "Message (Enter to send, Shift+Enter for line breaks)"
                                            : "Choose a session first"
                                    }
                                    rows={5}
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Button
                                    variant="primary"
                                    size="md"
                                    onClick={() => void handleSend()}
                                    disabled={
                                        !isConnected ||
                                        !selectedSessionKey ||
                                        !draft.trim()
                                    }
                                >
                                    <Send className="mr-2 h-4 w-4" /> Send
                                </Button>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
