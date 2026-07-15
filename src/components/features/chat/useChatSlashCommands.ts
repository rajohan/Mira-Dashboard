import type { Dispatch, SetStateAction } from "react";

import { createLocalSystemMessage } from "./chatRuntime";
import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { chatErrorMessage } from "./chatUtilities";
import { slashCommandCanonicalName } from "./slashCommands";

/** Represents use chat slash commands params. */
interface UseChatSlashCommandsParameters {
    stopCurrentRun: () => Promise<void>;
    attachments: ChatSendAttachment[];
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setDraft: Dispatch<SetStateAction<string>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    confirmResetSession: () => Promise<boolean>;
}

/** Handles Dashboard control commands that need dedicated Gateway RPCs. */
export function useChatSlashCommands({
    stopCurrentRun,
    attachments,
    setMessages,
    setDraft,
    setSendError,
    confirmResetSession,
}: UseChatSlashCommandsParameters) {
    /** Performs add system message. */
    const addSystemMessage = (text: string) => {
        setMessages((wasPrevious) => [...wasPrevious, createLocalSystemMessage(text)]);
    };

    return async (
        commandText: string,
        currentAttachments: ChatSendAttachment[] = attachments
    ): Promise<boolean> => {
        const [rawCommand = ""] = commandText.trim().split(/\s+/);
        const command = slashCommandCanonicalName(rawCommand);

        if (!command.startsWith("/")) {
            return false;
        }

        if (currentAttachments.length > 0) {
            setSendError(`${rawCommand} cannot include attachments.`);
            return true;
        }

        if (command !== "/stop" && command !== "/reset" && command !== "/new") {
            return false;
        }

        if (command === "/reset" || command === "/new") {
            let isConfirmed: boolean;
            try {
                isConfirmed = await confirmResetSession();
            } catch {
                isConfirmed = false;
            }

            if (!isConfirmed) {
                setDraft("");
                setSendError(undefined);
                addSystemMessage("Reset canceled.");
                return true;
            }

            setDraft("");
            setSendError(undefined);
            return false;
        }

        setDraft("");
        setSendError(undefined);

        try {
            await stopCurrentRun();
        } catch (error_) {
            setSendError(chatErrorMessage(error_, `Failed to run ${rawCommand}`));
        }

        return true;
    };
}
