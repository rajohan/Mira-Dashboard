import type { Dispatch, SetStateAction } from "react";

import { type ActiveChatStreams, createLocalSystemMessage } from "./chatRuntime";
import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { chatErrorMessage } from "./chatUtils";
import { slashCommandCanonicalName } from "./slashCommands";

/** Represents use chat slash commands params. */
interface UseChatSlashCommandsParams {
    request: <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ) => Promise<T>;
    selectedSessionKey: string;
    attachments: ChatSendAttachment[];
    updateActiveStreams: (
        updater: (previous: ActiveChatStreams) => ActiveChatStreams
    ) => void;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setDraft: Dispatch<SetStateAction<string>>;
    setSendError: Dispatch<SetStateAction<string | null>>;
    setIsSending: Dispatch<SetStateAction<boolean>>;
}

/** Handles Dashboard control commands that need dedicated Gateway RPCs. */
export function useChatSlashCommands({
    request,
    selectedSessionKey,
    attachments,
    updateActiveStreams,
    setMessages,
    setDraft,
    setSendError,
    setIsSending,
}: UseChatSlashCommandsParams) {
    /** Performs add system message. */
    const addSystemMessage = (text: string) => {
        setMessages((previous) => [...previous, createLocalSystemMessage(text)]);
    };

    return async (commandText: string): Promise<boolean> => {
        const [rawCommand = ""] = commandText.trim().split(/\s+/);
        const command = slashCommandCanonicalName(rawCommand);

        if (!command.startsWith("/")) {
            return false;
        }

        if (command !== "/stop") {
            return false;
        }

        if (attachments.length > 0) {
            setSendError(`${rawCommand} cannot include attachments.`);
            return true;
        }

        setDraft("");
        setSendError(null);
        setIsSending(true);

        try {
            await request("chat.abort", { sessionKey: selectedSessionKey });
            updateActiveStreams((previous) => {
                const next = { ...previous };
                delete next[selectedSessionKey];
                return next;
            });
            addSystemMessage("Stopped current run.");
        } catch (error_) {
            setSendError(chatErrorMessage(error_, `Failed to run ${rawCommand}`));
        } finally {
            setIsSending(false);
        }

        return true;
    };
}
