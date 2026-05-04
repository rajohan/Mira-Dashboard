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
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { useAgentsStatus } from "../hooks/useAgents";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { formatDuration, formatSize } from "../utils/format";
import { formatSessionType, sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const CHAT_HISTORY_LIMIT = 1000;
const OPTIMISTIC_MESSAGE_RETENTION_MS = 120_000;

interface SlashCommandDefinition {
    name: string;
    aliases?: string[];
    description: string;
    args?: string;
    choices?: string[];
}

interface ChatModelOption {
    id?: string;
    label?: string;
    name?: string;
}

const THINKING_CHOICES = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "adaptive",
];
const MODE_CHOICES = ["status", "on", "off"];
const VERBOSE_CHOICES = ["off", "on", "full"];
const REASONING_CHOICES = ["off", "on", "stream"];
const ELEVATED_CHOICES = ["off", "on", "ask", "full"];
const USAGE_CHOICES = ["off", "tokens", "on", "full"];

const SLASH_COMMANDS: SlashCommandDefinition[] = [
    { name: "/help", description: "Show available commands" },
    { name: "/commands", description: "List available slash commands" },
    { name: "/status", description: "Show selected session status" },
    {
        name: "/usage",
        description: "Show or set usage display",
        args: "[off|tokens|full|cost]",
        choices: USAGE_CHOICES,
    },
    { name: "/reset", description: "Reset the selected session" },
    { name: "/new", description: "Start a fresh selected session" },
    { name: "/compact", description: "Compact the selected session context" },
    { name: "/stop", aliases: ["/abort"], description: "Stop the current run" },
    { name: "/clear", description: "Clear only the local chat view" },
    { name: "/model", description: "Show or set the model", args: "[model]" },
    { name: "/models", description: "List configured models" },
    {
        name: "/think",
        aliases: ["/thinking", "/t"],
        description: "Show or set thinking level",
        args: "[level]",
        choices: THINKING_CHOICES,
    },
    {
        name: "/verbose",
        aliases: ["/v"],
        description: "Show or set verbose mode",
        args: "[off|on|full]",
        choices: VERBOSE_CHOICES,
    },
    {
        name: "/fast",
        description: "Show or set fast mode",
        args: "[status|on|off]",
        choices: MODE_CHOICES,
    },
    {
        name: "/reasoning",
        aliases: ["/reason"],
        description: "Show or set reasoning visibility",
        args: "[off|on|stream]",
        choices: REASONING_CHOICES,
    },
    {
        name: "/elevated",
        aliases: ["/elev"],
        description: "Show or set elevated mode",
        args: "[off|on|ask|full]",
        choices: ELEVATED_CHOICES,
    },
    {
        name: "/exec",
        description: "Set exec defaults",
        args: "[sandbox|gateway|node] [deny|allowlist|full] [off|on-miss|always]",
    },
    {
        name: "/steer",
        aliases: ["/tell"],
        description: "Send guidance to the active run",
        args: "<message>",
    },
    { name: "/kill", description: "Kill a running subagent", args: "[target|all]" },
    { name: "/agents", description: "List thread-bound agents" },
    {
        name: "/subagents",
        description: "Manage subagent runs",
        args: "[list|kill|log|info|send|steer|spawn]",
    },
    { name: "/tools", description: "List runtime tools", args: "[compact|verbose]" },
    {
        name: "/tts",
        description: "Control text-to-speech",
        args: "[on|off|status|provider|limit|summary|audio|help]",
    },
];

function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function base64ToText(base64: string): string {
    const binary = window.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

function messageIdentity(message: ChatHistoryMessage): string {
    return `${message.role.toLowerCase()}::${message.text.trim()}`;
}

function dedupeMessages(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const seen = new Set<string>();
    const deduped: ChatHistoryMessage[] = [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }

        const identity = messageIdentity(message);
        if (message.text.trim() && seen.has(identity)) {
            continue;
        }

        seen.add(identity);
        deduped.unshift(message);
    }

    return deduped;
}

function mergeWithRecentOptimisticMessages(
    previousMessages: ChatHistoryMessage[],
    nextMessages: ChatHistoryMessage[]
): ChatHistoryMessage[] {
    if (previousMessages.length === 0) {
        return dedupeMessages(nextMessages);
    }

    if (nextMessages.length === 0) {
        return previousMessages;
    }

    const nextIdentities = new Set(nextMessages.map(messageIdentity));
    const now = Date.now();
    const recentMissingMessages = previousMessages.filter((message) => {
        if (message.role.toLowerCase() !== "user") {
            return false;
        }

        if (nextIdentities.has(messageIdentity(message))) {
            return false;
        }

        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
        return (
            Number.isFinite(timestamp) &&
            now - timestamp < OPTIMISTIC_MESSAGE_RETENTION_MS
        );
    });

    return dedupeMessages([...nextMessages, ...recentMissingMessages]);
}

function activeRunStorageKey(sessionKey: string): string {
    return `mira-dashboard-chat-active-run:${sessionKey}`;
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
            Boolean(
                selectedSessionKey &&
                window.sessionStorage.getItem(activeRunStorageKey(selectedSessionKey))
            )
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
            if (!payload || payload.sessionKey !== selectedSessionKey) {
                return;
            }

            if (payload.state === "delta") {
                const nextText = normalizeChatHistoryMessage({
                    role: "assistant",
                    content: payload.message,
                }).text;
                setIsAssistantTyping(true);
                window.sessionStorage.setItem(
                    activeRunStorageKey(selectedSessionKey),
                    "1"
                );
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
                window.sessionStorage.removeItem(activeRunStorageKey(selectedSessionKey));
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
                window.sessionStorage.removeItem(activeRunStorageKey(selectedSessionKey));
                return;
            }

            if (payload.state === "error") {
                setSendError(payload.errorMessage || "Chat request failed");
                setStreamText("");
                setIsAssistantTyping(false);
                window.sessionStorage.removeItem(activeRunStorageKey(selectedSessionKey));
            }
        });
    }, [selectedSessionKey, streamText, subscribe]);

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

    const slashCommandSuggestions = (() => {
        const input = draft.trimStart();
        if (!input.startsWith("/")) {
            return [];
        }

        const [commandPart = "", ...argumentParts] = input.split(/\s+/);
        const argumentPart = argumentParts.join(" ").trim().toLowerCase();
        const matchedCommand = SLASH_COMMANDS.find(
            (command) =>
                command.name === commandPart.toLowerCase() ||
                command.aliases?.includes(commandPart.toLowerCase())
        );

        if (matchedCommand && input.includes(" ")) {
            const commandChoices =
                matchedCommand.name === "/model"
                    ? chatModelOptions
                          .map((model) => model.id || model.label || model.name || "")
                          .filter(Boolean)
                    : matchedCommand.choices || [];

            return commandChoices
                .filter((choice) => choice.toLowerCase().includes(argumentPart))
                .slice(0, 8)
                .map((choice) => ({
                    value: `${commandPart} ${choice}`,
                    title: choice,
                    description: matchedCommand.description,
                }));
        }

        const needle = commandPart.toLowerCase();
        return SLASH_COMMANDS.flatMap((command) =>
            [command.name, ...(command.aliases || [])]
                .filter((name) => name.startsWith(needle))
                .map((name) => ({
                    value: `${name}${command.args ? " " : ""}`,
                    title: `${name}${command.args ? ` ${command.args}` : ""}`,
                    description: command.description,
                }))
        ).slice(0, 10);
    })();

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
        const aliasTarget = SLASH_COMMANDS.find((definition) =>
            definition.aliases?.includes(rawCommand.toLowerCase())
        );
        const command = aliasTarget?.name || rawCommand.toLowerCase();
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
        window.sessionStorage.setItem(activeRunStorageKey(selectedSessionKey), "1");

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
            window.sessionStorage.removeItem(activeRunStorageKey(selectedSessionKey));
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
                    <div className="border-b border-primary-700 pb-3">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                            <div className="min-w-0">
                                <p className="truncate text-sm text-primary-400">
                                    {selectedSession
                                        ? `${formatSessionType(selectedSession)} · ${selectedSession.model || "Unknown"} · ${formatDuration(selectedSession.updatedAt)}`
                                        : "Choose a session to begin"}
                                </p>
                            </div>
                            <div
                                className={[
                                    "grid w-full gap-2 lg:ml-auto",
                                    agentOptions.length > 0
                                        ? "sm:grid-cols-2 lg:w-[min(48rem,72vw)] xl:w-[52rem]"
                                        : "lg:w-[min(24rem,36vw)] xl:w-[26rem]",
                                ].join(" ")}
                            >
                                <Select
                                    value={selectedSessionKey}
                                    onChange={setSelectedSessionKey}
                                    options={sessionOptions}
                                    placeholder="Select session"
                                    width="w-full"
                                    menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                                />
                                {agentOptions.length > 0 ? (
                                    <Select
                                        value=""
                                        onChange={setSelectedSessionKey}
                                        options={agentOptions}
                                        placeholder="Jump to agent"
                                        width="w-full"
                                        menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                                    />
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        chatRows={chatRows}
                        messagesContainerReference={messagesContainerReference}
                        messagesVirtualizer={messagesVirtualizer}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onPreview={setPreviewItem}
                        onScroll={handleMessagesScroll}
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
                            <div className="relative flex-1">
                                {slashCommandSuggestions.length > 0 ? (
                                    <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-primary-700 bg-primary-900 shadow-2xl">
                                        <div className="border-b border-primary-700 px-3 py-2 text-xs font-medium uppercase tracking-wide text-primary-400">
                                            Slash commands
                                        </div>
                                        <div className="max-h-72 overflow-y-auto py-1">
                                            {slashCommandSuggestions.map((suggestion) => (
                                                <button
                                                    key={suggestion.value}
                                                    type="button"
                                                    onClick={() =>
                                                        applySlashSuggestion(
                                                            suggestion.value
                                                        )
                                                    }
                                                    className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-primary-800 focus:bg-primary-800 focus:outline-none"
                                                >
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate font-mono text-sm text-primary-100">
                                                            {suggestion.title}
                                                        </span>
                                                        <span className="mt-0.5 block truncate text-xs text-primary-400">
                                                            {suggestion.description}
                                                        </span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                                <Textarea
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (
                                            event.key === "Tab" &&
                                            slashCommandSuggestions.length > 0
                                        ) {
                                            event.preventDefault();
                                            applySlashSuggestion(
                                                slashCommandSuggestions[0]?.value || draft
                                            );
                                            return;
                                        }

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
                                            ? "Message, attach files, or use / commands (try /help)"
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
