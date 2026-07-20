import type { Dispatch, RefObject, SetStateAction } from "react";

import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { chatErrorMessage } from "./chatUtilities";
import { slashCommandCanonicalName } from "./slashCommands";
import type { ChatTransport } from "./transport/chatTransport";

/** Represents use chat slash commands params. */
interface UseChatSlashCommandsParameters {
    abort: ChatTransport["abort"];
    clearRuntime: (sessionKey: string) => void;
    selectedSessionKey: string;
    selectedSessionKeyReference: RefObject<string>;
    attachments: ChatSendAttachment[];
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setDraft: Dispatch<SetStateAction<string>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    confirmResetSession: () => Promise<boolean>;
}

/** Handles Dashboard control commands that need dedicated Gateway RPCs. */
export function useChatSlashCommands({
    abort,
    clearRuntime,
    selectedSessionKey,
    selectedSessionKeyReference,
    attachments,
    setMessages,
    setDraft,
    setSendError,
    confirmResetSession,
}: UseChatSlashCommandsParameters) {
    /** Performs add system message. */
    const addSystemMessage = (text: string) => {
        setMessages((previous) => [
            ...previous,
            {
                attachments: [],
                content: text,
                images: [],
                local: true,
                role: "system",
                text,
                timestamp: new Date().toISOString(),
            },
        ]);
    };

    return async (
        commandText: string,
        currentAttachments: ChatSendAttachment[] = attachments,
        options: { preserveDraft?: boolean } = {}
    ): Promise<boolean> => {
        const commandSessionKey = selectedSessionKey;
        const isCommandSessionSelected = () =>
            selectedSessionKeyReference.current === commandSessionKey;
        const [rawCommand = ""] = commandText.trim().split(/\s+/, 1);
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

            if (!isCommandSessionSelected()) {
                return true;
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

        if (!options.preserveDraft) setDraft("");
        setSendError(undefined);

        try {
            await abort(commandSessionKey);
            clearRuntime(commandSessionKey);
            if (isCommandSessionSelected()) {
                addSystemMessage("Stopped current run.");
            }
        } catch (error_) {
            if (isCommandSessionSelected()) {
                setSendError(chatErrorMessage(error_, `Failed to run ${rawCommand}`));
            }
        }

        return true;
    };
}
