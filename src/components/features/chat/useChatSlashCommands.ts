import type { Dispatch, SetStateAction } from "react";

import type { Session } from "../../../types/session";
import {
    type ActiveChatStreams,
    createChatVisibility,
    createLocalSystemMessage,
    visibleHistoryMessages,
} from "./chatRuntime";
import type {
    ChatHistoryMessage,
    ChatSendAttachment,
    RawChatHistoryMessage,
} from "./chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    type ChatModelOption,
    mergeWithRecentOptimisticMessages,
} from "./chatUtils";
import {
    ELEVATED_CHOICES,
    REASONING_CHOICES,
    SLASH_COMMANDS,
    slashCommandCanonicalName,
    THINKING_CHOICES,
    VERBOSE_CHOICES,
} from "./slashCommands";

/** Describes use chat slash commands params. */
interface UseChatSlashCommandsParams {
    request: <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ) => Promise<T>;
    selectedSession: Session | null;
    selectedSessionKey: string;
    attachments: ChatSendAttachment[];
    chatModelOptions: ChatModelOption[];
    showThinkingOutput: boolean;
    showToolOutput: boolean;
    updateActiveStreams: (
        updater: (previous: ActiveChatStreams) => ActiveChatStreams
    ) => void;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setDraft: Dispatch<SetStateAction<string>>;
    setSendError: Dispatch<SetStateAction<string | null>>;
    setIsSending: Dispatch<SetStateAction<boolean>>;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    setHistoryLoadVersion: Dispatch<SetStateAction<number>>;
    shouldStickToBottomReference: { current: boolean };
}

/** Handles use chat slash commands. */
export function useChatSlashCommands({
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
}: UseChatSlashCommandsParams) {
    /** Handles add system message. */
    const addSystemMessage = (text: string) => {
        setMessages((previous) => [...previous, createLocalSystemMessage(text)]);
    };

    /** Handles reload chat history. */
    const reloadChatHistory = async () => {
        if (!selectedSessionKey) {
            return;
        }

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
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        setHistoryLoadVersion((previous) => previous + 1);
    };

    return async (commandText: string): Promise<boolean> => {
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

        /** Handles patch session. */
        const patchSession = async (patch: Record<string, unknown>) => {
            await request("sessions.patch", { key: selectedSessionKey, ...patch });
        };

        /** Handles run simple command. */
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
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
                await request("sessions.reset", { key: selectedSessionKey });
                await reloadChatHistory();
                addSystemMessage("Session reset.");
            });

            return true;
        }

        if (command === "/stop" || command === "/abort") {
            await runSimpleCommand(async () => {
                await request("chat.abort", { sessionKey: selectedSessionKey });
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
                addSystemMessage("Stopped current run.");
            });

            return true;
        }

        setDraft("");
        setSendError(null);

        if (command === "/clear") {
            setMessages([]);
            updateActiveStreams((previous) => {
                const next = { ...previous };
                delete next[selectedSessionKey];
                return next;
            });
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

            addSystemMessage(
                [
                    `Session: ${selectedSession.displayLabel || selectedSession.key}`,
                    `Status: ${selectedSession.status || "unknown"}`,
                    `Model: ${selectedSession.model || "default"}`,
                    `Thinking: ${selectedSession.thinkingLevel || "default"}`,
                    `Fast mode: ${selectedSession.fastMode ? "on" : "off"}`,
                    `Verbose: ${selectedSession.verboseLevel || "off"}`,
                    `Reasoning: ${selectedSession.reasoningLevel || "off"}`,
                    `Elevated: ${selectedSession.elevatedLevel || "off"}`,
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
                    `Current thinking level: ${selectedSession?.thinkingLevel || "default"}. Options: ${THINKING_CHOICES.join(", ")}.`
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
                    `Current verbose mode: ${selectedSession?.verboseLevel || "off"}. Options: ${VERBOSE_CHOICES.join(", ")}.`
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
                    `Current fast mode: ${selectedSession?.fastMode ? "on" : "off"}. Options: status, on, off.`
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
                    `Current reasoning visibility: ${selectedSession?.reasoningLevel || "off"}. Options: ${REASONING_CHOICES.join(", ")}.`
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
                    `Current elevated mode: ${selectedSession?.elevatedLevel || "off"}. Options: ${ELEVATED_CHOICES.join(", ")}.`
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
            setDraft("");
            setSendError(null);
            setIsSending(true);
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);

            const runId = `compact-${Date.now()}`;
            updateActiveStreams((previous) => ({
                ...previous,
                [selectedSessionKey]: {
                    sessionKey: selectedSessionKey,
                    runId,
                    aliases: [runId],
                    text: "",
                    statusText: "Compacting context",
                    updatedAt: new Date().toISOString(),
                },
            }));

            try {
                const result = await request<{ compacted?: boolean; reason?: string }>(
                    "sessions.compact",
                    {
                        key: selectedSessionKey,
                    }
                );

                addSystemMessage(
                    result.compacted
                        ? "Context compacted successfully."
                        : `Compaction skipped${result.reason ? `: ${result.reason}` : "."}`
                );
            } catch (error_) {
                setSendError((error_ as Error).message || "Failed to run /compact");
            } finally {
                updateActiveStreams((previous) => {
                    const next = { ...previous };
                    delete next[selectedSessionKey];
                    return next;
                });
                setIsSending(false);
            }
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
}
