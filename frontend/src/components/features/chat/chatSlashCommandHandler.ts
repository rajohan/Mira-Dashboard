import type { Dispatch, RefObject, SetStateAction } from "react";

import { messageFromError } from "../../../lib/errorMessage";
import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { slashCommandCanonicalName } from "./slashCommands";
import type { ChatTransport } from "./transport/chatTransport";

/** Represents chat slash command execution parameters. */
interface ChatSlashCommandParameters {
    abort: ChatTransport["abort"];
    clearRuntime: (sessionKey: string) => void;
    selectedSessionKey: string;
    selectedSessionKeyRef: RefObject<string>;
    attachments: ChatSendAttachment[];
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setDraft: Dispatch<SetStateAction<string>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    confirmResetSession: () => Promise<boolean>;
}

/**
 * Handles Dashboard control commands that need dedicated Gateway RPCs.
 * @returns Promise that resolves after handling Dashboard control commands that need dedicated Gateway RPCs.
 */
export async function executeChatSlashCommand(
    {
        abort,
        clearRuntime,
        selectedSessionKey,
        selectedSessionKeyRef,
        attachments,
        setMessages,
        setDraft,
        setSendError,
        confirmResetSession,
    }: ChatSlashCommandParameters,
    commandText: string,
    currentAttachments: ChatSendAttachment[] = attachments,
    options: { preserveDraft?: boolean } = {}
): Promise<boolean> {
    /**
     * Performs add system message.
     * @param text Text value.
     */
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

    const commandSessionKey = selectedSessionKey;
    const isCommandSessionSelected = () =>
        selectedSessionKeyRef.current === commandSessionKey;
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
            setSendError(messageFromError(error_, `Failed to run ${rawCommand}`));
        }
    }

    return true;
}
