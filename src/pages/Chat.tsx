import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    AlertCircle,
    Image as ImageIcon,
    Loader2,
    Paperclip,
    Send,
    Square,
    X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { formatDate, formatDuration } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

interface ChatImageBlock {
    type: "image";
    mimeType?: string;
    data?: string;
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
    };
}

interface ChatHistoryMessage {
    role: string;
    content: unknown;
    text: string;
    images?: ChatImageBlock[];
    timestamp?: string;
}

interface ChatStreamEventMessage {
    sessionKey?: string;
    runId?: string;
    state?: string;
    errorMessage?: string;
    message?: unknown;
}

interface AttachmentDraft {
    id: string;
    name: string;
    mimeType: string;
    base64: string;
    dataUrl?: string;
    size: number;
}

interface ChatRow {
    key: string;
    kind: "message" | "stream";
    message: ChatHistoryMessage;
}

function extractImages(content: unknown): ChatImageBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((item): item is ChatImageBlock => {
        if (!item || typeof item !== "object") {
            return false;
        }

        const block = item as Record<string, unknown>;
        return block.type === "image";
    });
}

function normalizeText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }

                if (!item || typeof item !== "object") {
                    return "";
                }

                const block = item as Record<string, unknown>;
                if (typeof block.text === "string") {
                    return block.text;
                }

                if (block.type === "image") {
                    return "[image]";
                }

                return "";
            })
            .filter(Boolean)
            .join("\n\n");
    }

    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        if (typeof maybe.text === "string") {
            return maybe.text;
        }
    }

    return "";
}

function toAttachment(file: File): Promise<AttachmentDraft> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            const result = reader.result;
            if (typeof result !== "string") {
                reject(new Error("Failed to read file"));
                return;
            }

            const commaIndex = result.indexOf(",");
            const base64 = commaIndex === -1 ? result : result.slice(commaIndex + 1);
            resolve({
                id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                name: file.name,
                mimeType: file.type || "application/octet-stream",
                base64,
                dataUrl: result,
                size: file.size,
            });
        });
        reader.addEventListener("error", () => reject(new Error("Failed to read file")));
        reader.readAsDataURL(file);
    });
}

export function Chat() {
    const { isConnected, error, request, subscribe } = useOpenClawSocket();
    const sessionActions = useSessionActions();
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const messagesContainerReference = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomReference = useRef(true);

    const [selectedSessionKey, setSelectedSessionKey] = useState("");
    const [draft, setDraft] = useState("");
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [activeRunId, setActiveRunId] = useState<string | null>(null);
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
            setActiveRunId(null);

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
                setIsSending(false);
                setActiveRunId(null);
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
                setIsSending(false);
                setActiveRunId(null);
                return;
            }

            if (payload.state === "error") {
                setSendError(payload.errorMessage || "Chat request failed");
                setStreamText("");
                setIsSending(false);
                setActiveRunId(null);
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

    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) => previous.filter((item) => item.id !== attachmentId));
    };

    const handleFiles = async (fileList: FileList | File[] | null) => {
        if (!fileList || fileList.length === 0) {
            return;
        }

        try {
            const next = await Promise.all(
                [...fileList].map((file) => toAttachment(file))
            );
            setAttachments((previous) => [...previous, ...next]);
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to load attachment");
        }
    };

    const handleStop = async () => {
        if (!selectedSessionKey) {
            return;
        }

        try {
            await request("chat.abort", {
                sessionKey: selectedSessionKey,
                runId: activeRunId || undefined,
            });
            setIsSending(false);
            setActiveRunId(null);
            setStreamText("");
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to stop chat run");
        }
    };

    const handleSlashCommand = async (commandText: string): Promise<boolean> => {
        const normalized = commandText.trim().toLowerCase();
        if (!normalized.startsWith("/")) {
            return false;
        }

        if (normalized === "/reset" || normalized === "/new") {
            if (!selectedSessionKey) {
                return true;
            }
            sessionActions.reset(selectedSessionKey);
            setMessages([]);
            setStreamText("");
            setAttachments([]);
            setDraft("");
            return true;
        }

        if (normalized === "/stop") {
            await handleStop();
            setDraft("");
            return true;
        }

        return false;
    };

    const handleSend = async () => {
        if (!selectedSessionKey) {
            return;
        }

        const text = draft.trim();
        if (!text && attachments.length === 0) {
            return;
        }

        if (await handleSlashCommand(text)) {
            return;
        }

        const messageText = text;
        const optimisticContent = [
            ...(messageText ? [{ type: "text", text: messageText }] : []),
            ...attachments
                .filter((attachment) => attachment.mimeType.startsWith("image/"))
                .map((attachment) => ({
                    type: "image" as const,
                    mimeType: attachment.mimeType,
                    source: {
                        type: "base64",
                        media_type: attachment.mimeType,
                        data: attachment.base64,
                    },
                })),
        ];

        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: optimisticContent.length > 0 ? optimisticContent : messageText,
            text: messageText || (attachments.length > 0 ? "[image]" : ""),
            images: attachments
                .filter((attachment) => attachment.mimeType.startsWith("image/"))
                .map((attachment) => ({
                    type: "image" as const,
                    mimeType: attachment.mimeType,
                    source: {
                        type: "base64",
                        media_type: attachment.mimeType,
                        data: attachment.base64,
                    },
                })),
            timestamp: new Date().toISOString(),
        };

        setMessages((previous) => [...previous, userMessage]);
        setDraft("");
        setSendError(null);
        setIsSending(true);
        setStreamText("");

        try {
            const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const result = (await request("chat.send", {
                sessionKey: selectedSessionKey,
                message: messageText,
                deliver: false,
                idempotencyKey,
                attachments: attachments.map((attachment) => ({
                    type: attachment.mimeType.startsWith("image/") ? "image" : "file",
                    mimeType: attachment.mimeType,
                    content: attachment.base64,
                    fileName: attachment.name,
                })),
            })) as { runId?: string; status?: string };

            setActiveRunId(result.runId || null);
            setAttachments([]);
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to send message");
            setIsSending(false);
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
                    <div className="flex items-center justify-between border-b border-primary-700 pb-3">
                        <div>
                            <h2 className="text-lg font-semibold text-primary-50">
                                Chat
                            </h2>
                            <p className="text-sm text-primary-400">
                                {selectedSession
                                    ? selectedSession.displayLabel || selectedSession.key
                                    : "Choose a session to begin"}
                            </p>
                        </div>
                        {isSending ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void handleStop()}
                            >
                                <Square className="mr-2 h-4 w-4" /> Stop
                            </Button>
                        ) : null}
                    </div>

                    <div
                        ref={messagesContainerReference}
                        onScroll={handleMessagesScroll}
                        className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
                    >
                        {isLoadingHistory ? (
                            <div className="flex items-center justify-center py-10 text-primary-400">
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading
                                chat…
                            </div>
                        ) : chatRows.length === 0 ? (
                            <EmptyState message="No chat history yet. Send the first message to this session." />
                        ) : (
                            <div
                                className="relative w-full"
                                style={{
                                    height: `${messagesVirtualizer.getTotalSize()}px`,
                                }}
                            >
                                {messagesVirtualizer
                                    .getVirtualItems()
                                    .map((virtualItem) => {
                                        const row = chatRows[virtualItem.index];

                                        if (!row) {
                                            return null;
                                        }

                                        const isUser =
                                            row.message.role.toLowerCase() === "user";

                                        return (
                                            <div
                                                key={row.key}
                                                className="absolute left-0 top-0 w-full"
                                                style={{
                                                    transform: `translateY(${virtualItem.start}px)`,
                                                }}
                                            >
                                                <div
                                                    ref={
                                                        messagesVirtualizer.measureElement
                                                    }
                                                    data-index={virtualItem.index}
                                                    className="pb-3"
                                                >
                                                    <div
                                                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                                                    >
                                                        <div
                                                            className={[
                                                                "max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm",
                                                                isUser
                                                                    ? "bg-accent-500 text-white"
                                                                    : "border border-primary-700 bg-primary-800 text-primary-100",
                                                            ].join(" ")}
                                                        >
                                                            <div className="mb-1 text-[11px] uppercase tracking-wide opacity-70">
                                                                {row.message.role}
                                                            </div>
                                                            {row.message.images &&
                                                            row.message.images.length >
                                                                0 ? (
                                                                <div className="mb-2 flex flex-wrap gap-2">
                                                                    {row.message.images.map(
                                                                        (
                                                                            image,
                                                                            imageIndex
                                                                        ) => {
                                                                            const imageData =
                                                                                image
                                                                                    .source
                                                                                    ?.data ||
                                                                                image.data;
                                                                            const imageMime =
                                                                                image
                                                                                    .source
                                                                                    ?.media_type ||
                                                                                image.mimeType ||
                                                                                "image/png";

                                                                            if (
                                                                                !imageData
                                                                            ) {
                                                                                return null;
                                                                            }

                                                                            return (
                                                                                <img
                                                                                    key={`${row.key}-image-${imageIndex}`}
                                                                                    src={`data:${imageMime};base64,${imageData}`}
                                                                                    alt="Chat attachment"
                                                                                    className="max-h-56 max-w-full rounded-lg border border-primary-700 object-contain"
                                                                                />
                                                                            );
                                                                        }
                                                                    )}
                                                                </div>
                                                            ) : null}
                                                            <div className="whitespace-pre-wrap break-words">
                                                                {row.message.text ||
                                                                    (row.message.images &&
                                                                    row.message.images
                                                                        .length > 0
                                                                        ? null
                                                                        : "[no text content]")}
                                                            </div>
                                                            {row.message.timestamp ? (
                                                                <div className="mt-2 text-[11px] opacity-60">
                                                                    {formatDate(
                                                                        row.message
                                                                            .timestamp
                                                                    )}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                    </div>

                    <div className="mt-4 border-t border-primary-700 pt-4">
                        {sendError || error ? (
                            <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                                <span>{sendError || error}</span>
                            </div>
                        ) : null}

                        {attachments.length > 0 ? (
                            <div className="mb-3 flex flex-wrap gap-2">
                                {attachments.map((attachment) => {
                                    const isImage =
                                        attachment.mimeType.startsWith("image/");
                                    return (
                                        <div
                                            key={attachment.id}
                                            className="flex items-center gap-2 rounded-lg border border-primary-700 bg-primary-900/50 px-2 py-2"
                                        >
                                            {isImage && attachment.dataUrl ? (
                                                <img
                                                    src={attachment.dataUrl}
                                                    alt={attachment.name}
                                                    className="h-12 w-12 rounded object-cover"
                                                />
                                            ) : (
                                                <div className="flex h-12 w-12 items-center justify-center rounded bg-primary-800 text-primary-300">
                                                    <ImageIcon className="h-5 w-5" />
                                                </div>
                                            )}
                                            <div className="min-w-0">
                                                <div className="max-w-48 truncate text-sm text-primary-100">
                                                    {attachment.name}
                                                </div>
                                                <div className="text-xs text-primary-400">
                                                    {(attachment.size / 1024).toFixed(1)}{" "}
                                                    KB
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    removeAttachment(attachment.id)
                                                }
                                                className="rounded p-1 text-primary-400 hover:bg-primary-800 hover:text-primary-100"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                    );
                                })}
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
                                    onPaste={(event) => {
                                        const items = event.clipboardData?.items;
                                        if (!items) {
                                            return;
                                        }
                                        const imageFiles = [...items]
                                            .filter((item) =>
                                                item.type.startsWith("image/")
                                            )
                                            .map((item) => item.getAsFile())
                                            .filter(
                                                (file): file is File => file !== null
                                            );
                                        if (imageFiles.length > 0) {
                                            event.preventDefault();
                                            void handleFiles(imageFiles);
                                        }
                                    }}
                                    disabled={
                                        !selectedSessionKey || !isConnected || isSending
                                    }
                                    placeholder={
                                        selectedSessionKey
                                            ? "Message (Enter to send, Shift+Enter for line breaks)"
                                            : "Choose a session first"
                                    }
                                    rows={5}
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <input
                                    ref={fileInputReference}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        void handleFiles(event.target.files);
                                        event.target.value = "";
                                    }}
                                />
                                <Button
                                    variant="secondary"
                                    size="md"
                                    onClick={() => fileInputReference.current?.click()}
                                    disabled={
                                        !selectedSessionKey || !isConnected || isSending
                                    }
                                >
                                    <Paperclip className="mr-2 h-4 w-4" /> Files
                                </Button>
                                <Button
                                    variant="primary"
                                    size="md"
                                    onClick={() => void handleSend()}
                                    disabled={
                                        !isConnected ||
                                        !selectedSessionKey ||
                                        (!draft.trim() && attachments.length === 0)
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
