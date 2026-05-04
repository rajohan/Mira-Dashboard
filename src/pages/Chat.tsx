import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Paperclip, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
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
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatDuration, formatSize } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function base64ToText(base64: string): string {
    const binary = window.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
                return;
            }

            reject(new Error(`Could not read ${file.name}`));
        });
        reader.addEventListener("error", () =>
            reject(reader.error || new Error(`Could not read ${file.name}`))
        );
        reader.readAsDataURL(file);
    });
}

function displayMimeType(file: File): string {
    return file.type || "application/octet-stream";
}

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
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | null>(null);

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
    } else if (isAssistantTyping) {
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
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        setAttachments([]);
        setIsAssistantTyping(false);

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
                    messages?: RawChatHistoryMessage[];
                };

                if (cancelled) {
                    return;
                }

                setMessages((result.messages || []).map(normalizeChatHistoryMessage));
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
                const nextText = normalizeChatHistoryMessage({
                    role: "assistant",
                    content: payload.message,
                }).text;
                setIsAssistantTyping(true);
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
                return;
            }

            if (payload.state === "error") {
                setSendError(payload.errorMessage || "Chat request failed");
                setStreamText("");
                setIsAssistantTyping(false);
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
    }, [chatRows.length, streamText, isAssistantTyping, messagesVirtualizer]);

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
        isAssistantTyping,
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

    const handleSend = async () => {
        if (!selectedSessionKey || isSending) {
            return;
        }

        const text = draft.trim();
        if (!text && attachments.length === 0) {
            return;
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

        try {
            const idempotencyKey = `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await request("chat.send", {
                sessionKey: selectedSessionKey,
                message: messageText,
                attachments: gatewayAttachments(sendAttachments),
                deliver: false,
                idempotencyKey,
            });
        } catch (error_) {
            setSendError((error_ as Error).message || "Failed to send message");
            setIsAssistantTyping(false);
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
                        <h2 className="text-lg font-semibold text-primary-50">Chat</h2>
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
                        onPreview={setPreviewItem}
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

                        {attachments.length > 0 ? (
                            <div className="mb-3 flex flex-wrap gap-2">
                                {attachments.map((attachment) => (
                                    <button
                                        key={attachment.id}
                                        type="button"
                                        onClick={() =>
                                            setPreviewItem({
                                                title: attachment.fileName,
                                                mimeType: attachment.mimeType,
                                                kind: attachment.kind,
                                                url:
                                                    attachment.dataUrl ||
                                                    `data:${attachment.mimeType};base64,${attachment.contentBase64}`,
                                                text:
                                                    attachment.kind === "text"
                                                        ? base64ToText(
                                                              attachment.contentBase64
                                                          )
                                                        : undefined,
                                                sizeBytes: attachment.sizeBytes,
                                            })
                                        }
                                        className="group flex max-w-full items-center gap-2 rounded-lg border border-primary-700 bg-primary-800 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-700"
                                    >
                                        {attachment.kind === "image" &&
                                        attachment.dataUrl ? (
                                            <img
                                                src={attachment.dataUrl}
                                                alt=""
                                                className="h-8 w-8 rounded object-cover"
                                            />
                                        ) : (
                                            <Paperclip className="h-4 w-4 text-primary-400" />
                                        )}
                                        <div className="min-w-0">
                                            <div className="truncate">
                                                {attachment.fileName}
                                            </div>
                                            <div className="text-primary-400">
                                                {formatSize(attachment.sizeBytes)}
                                            </div>
                                        </div>
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                removeAttachment(attachment.id);
                                            }}
                                            onKeyDown={(event) => {
                                                if (
                                                    event.key === "Enter" ||
                                                    event.key === " "
                                                ) {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    removeAttachment(attachment.id);
                                                }
                                            }}
                                            className="rounded p-1 text-primary-400 hover:bg-primary-700 hover:text-primary-100"
                                            aria-label={`Remove ${attachment.fileName}`}
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        <div className="flex gap-3">
                            <input
                                ref={fileInputReference}
                                type="file"
                                multiple
                                className="hidden"
                                onChange={(event) =>
                                    void handleFilesSelected(event.target.files)
                                }
                            />
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
                                    disabled={
                                        !selectedSessionKey || !isConnected || isSending
                                    }
                                    placeholder={
                                        selectedSessionKey
                                            ? "Message or attach files (Enter to send, Shift+Enter for line breaks)"
                                            : "Choose a session first"
                                    }
                                    rows={5}
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Button
                                    variant="secondary"
                                    size="md"
                                    onClick={() => fileInputReference.current?.click()}
                                    disabled={
                                        !isConnected ||
                                        !selectedSessionKey ||
                                        isSending ||
                                        attachments.length >= MAX_ATTACHMENTS
                                    }
                                    title="Attach files"
                                >
                                    <Paperclip className="mr-2 h-4 w-4" /> Attach
                                </Button>
                                <Button
                                    variant="primary"
                                    size="md"
                                    onClick={() => void handleSend()}
                                    disabled={!canSend}
                                >
                                    <Send className="mr-2 h-4 w-4" /> Send
                                </Button>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>

            <Modal
                isOpen={Boolean(previewItem)}
                onClose={() => setPreviewItem(null)}
                title={previewItem?.title || "Attachment preview"}
                size="3xl"
            >
                {previewItem ? (
                    <div className="space-y-3">
                        <div className="text-xs text-primary-400">
                            {previewItem.mimeType || "application/octet-stream"}
                            {previewItem.sizeBytes
                                ? ` · ${formatSize(previewItem.sizeBytes)}`
                                : ""}
                        </div>
                        {previewItem.kind === "image" && previewItem.url ? (
                            <img
                                src={previewItem.url}
                                alt={previewItem.title}
                                className="max-h-[70vh] w-full rounded-lg object-contain"
                            />
                        ) : previewItem.kind === "text" && previewItem.text ? (
                            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg border border-primary-700 bg-primary-950 p-4 text-sm text-primary-100">
                                {previewItem.text}
                            </pre>
                        ) : previewItem.url ? (
                            <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-200">
                                Preview is not available for this file type yet.
                                <a
                                    href={previewItem.url}
                                    download={previewItem.title}
                                    className="ml-2 text-accent-300 underline hover:text-accent-200"
                                >
                                    Download file
                                </a>
                            </div>
                        ) : (
                            <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                                This historical attachment has no preview data available.
                            </div>
                        )}
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
