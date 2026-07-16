import {
    type Dispatch,
    type MutableRefObject,
    type SetStateAction,
    useEffect,
    useRef,
    useState,
} from "react";

import type { Session } from "../../../types/session";
import { currentIsoString } from "../../../utils/date";
import { isResetSlashCommand, isSessionActive } from "./chatPageUtilities";
import {
    type ChatHistoryMessage,
    type ChatSendAttachment,
    chatTransportAttachments,
    optimisticAttachmentDisplay,
} from "./chatTypes";
import {
    chatErrorMessage,
    dedupeMessages,
    messageIdentity,
    rollbackFailedOptimisticMessage,
} from "./chatUtilities";
import { isSameChatSession } from "./domain/chatState";
import type { ChatSessionPreferences, ChatTransport } from "./transport/chatTransport";
import type { ChatRuntimeController } from "./useChatRuntime";
import { useChatSlashCommands } from "./useChatSlashCommands";

interface ChatActionsOptions {
    activeRunCount: number;
    attachments: ChatSendAttachment[];
    attachmentsReference: MutableRefObject<ChatSendAttachment[]>;
    clearAttachments(): void;
    confirmResetSession(): Promise<boolean>;
    draft: string;
    isCompacting: boolean;
    isConnected: boolean;
    isRecording: boolean;
    isTranscribing: boolean;
    runtime: ChatRuntimeController;
    scheduleBottomFollow(): void;
    selectedSession?: Session;
    selectedSessionKey: string;
    selectedSessionKeyReference: MutableRefObject<string>;
    setDraft: Dispatch<SetStateAction<string>>;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    shouldStickToBottomReference: MutableRefObject<boolean>;
    transport: ChatTransport;
}

/** Owns stateful chat commands while the page remains a view composition. */
export function useChatActions({
    activeRunCount,
    attachments,
    attachmentsReference,
    clearAttachments,
    confirmResetSession,
    draft,
    isCompacting,
    isConnected,
    isRecording,
    isTranscribing,
    runtime,
    scheduleBottomFollow,
    selectedSession,
    selectedSessionKey,
    selectedSessionKeyReference,
    setDraft,
    setIsAtBottom,
    setMessages,
    setSendError,
    shouldStickToBottomReference,
    transport,
}: ChatActionsOptions) {
    const sendCountReference = useRef(0);
    const sendEpochReference = useRef(0);
    const pendingPatchesReference = useRef(new Map<string, Set<Promise<boolean>>>());
    const draftReference = useRef(draft);
    const [isSending, setIsSending] = useState(false);
    const [stoppingSessionKey, setStoppingSessionKey] = useState("");
    const [pendingPatchCounts, setPendingPatchCounts] = useState<Record<string, number>>(
        {}
    );

    draftReference.current = draft;

    useEffect(() => {
        if (isConnected) {
            return;
        }

        sendEpochReference.current += 1;
        sendCountReference.current = 0;
        setIsSending(false);
    }, [isConnected]);

    const handleSlashCommand = useChatSlashCommands({
        abort: transport.abort,
        clearRuntime: runtime.clearSession,
        selectedSessionKey,
        selectedSessionKeyReference,
        attachments,
        setMessages,
        setDraft,
        setSendError,
        confirmResetSession,
    });

    const beginSend = () => {
        sendCountReference.current += 1;
        setIsSending(true);
        return sendEpochReference.current;
    };

    const endSend = (sendEpoch: number) => {
        if (sendEpoch !== sendEpochReference.current) {
            return;
        }
        sendCountReference.current = Math.max(0, sendCountReference.current - 1);
        setIsSending(sendCountReference.current > 0);
    };

    const isBlockedByInFlightSend = (
        text: string,
        attachmentCount = attachments.length
    ) => {
        const slashCommand = text.startsWith("/") && attachmentCount === 0;
        return sendCountReference.current > 0 && !(slashCommand && activeRunCount > 0);
    };

    const handleSend = async () => {
        if (!selectedSessionKey) {
            return;
        }
        const pendingSessionKey = selectedSessionKey;
        let text = draft.trim();
        if (
            isBlockedByInFlightSend(text, attachments.length) ||
            (!text && attachments.length === 0)
        ) {
            return;
        }

        const patchResults = await Promise.all(
            pendingPatchesReference.current.get(pendingSessionKey) || []
        );
        if (
            patchResults.includes(false) ||
            selectedSessionKeyReference.current !== pendingSessionKey
        ) {
            return;
        }

        text = draftReference.current.trim();
        const currentAttachments = attachmentsReference.current;
        if (
            isBlockedByInFlightSend(text, currentAttachments.length) ||
            (!text && currentAttachments.length === 0)
        ) {
            return;
        }

        const sendEpoch = beginSend();
        if (text.startsWith("/")) {
            try {
                const wasHandled = await handleSlashCommand(text, currentAttachments);
                if (selectedSessionKeyReference.current !== pendingSessionKey) {
                    endSend(sendEpoch);
                    return;
                }
                if (wasHandled) {
                    endSend(sendEpoch);
                    return;
                }
            } catch (error) {
                if (selectedSessionKeyReference.current === pendingSessionKey) {
                    setSendError(chatErrorMessage(error, "Failed to run slash command"));
                }
                endSend(sendEpoch);
                return;
            }
        }

        const resetCommand = isResetSlashCommand(text);
        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: text,
            text,
            images: [],
            attachments: optimisticAttachmentDisplay(currentAttachments),
            local: true,
            timestamp: currentIsoString(),
        };
        const optimisticIdentity = messageIdentity(userMessage);
        let replacedMessages: Array<{
            index: number;
            message: ChatHistoryMessage;
        }> = [];
        if (!resetCommand) {
            setMessages((previous) => {
                replacedMessages = previous.flatMap((message, index) =>
                    messageIdentity(message) === optimisticIdentity
                        ? [{ index, message }]
                        : []
                );
                return dedupeMessages([...previous, userMessage]);
            });
        }
        setDraft("");
        clearAttachments();
        setSendError(undefined);
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        scheduleBottomFollow();

        const idempotencyKey = resetCommand
            ? undefined
            : `dashboard-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (idempotencyKey) {
            runtime.beginRun(pendingSessionKey, idempotencyKey);
        }

        try {
            if (!text.startsWith("/") && selectedSession?.verboseLevel !== "full") {
                try {
                    await transport.patchSession(pendingSessionKey, {
                        verboseLevel: "full",
                    });
                } catch {
                    // Diagnostics are best effort and must not block delivery.
                }
            }
            const result = await transport.send({
                sessionKey: pendingSessionKey,
                sessionId: providerSessionId(selectedSession, pendingSessionKey),
                message: text,
                attachments: chatTransportAttachments(currentAttachments),
                idempotencyKey,
            });
            if (resetCommand) {
                runtime.clearSession(pendingSessionKey);
                if (selectedSessionKeyReference.current === pendingSessionKey) {
                    setMessages([]);
                }
            } else if (idempotencyKey) {
                runtime.acknowledgeRun(pendingSessionKey, idempotencyKey, result.runId);
            }
        } catch (error) {
            if (idempotencyKey) {
                runtime.clearRun(pendingSessionKey, idempotencyKey);
            }
            if (selectedSessionKeyReference.current === pendingSessionKey) {
                setSendError(chatErrorMessage(error, "Failed to send message"));
            }
            if (
                !resetCommand &&
                selectedSessionKeyReference.current === pendingSessionKey
            ) {
                setMessages((previous) =>
                    rollbackFailedOptimisticMessage(
                        previous,
                        userMessage,
                        replacedMessages
                    )
                );
            }
        } finally {
            endSend(sendEpoch);
        }
    };

    const draftText = draft.trim();
    const isStopping = isSameChatSession(stoppingSessionKey, selectedSessionKey);
    const isPatchingSession = (pendingPatchCounts[selectedSessionKey] || 0) > 0;
    const canSend = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isRecording &&
        !isTranscribing &&
        !isPatchingSession &&
        !isCompacting &&
        !isStopping &&
        !isBlockedByInFlightSend(draftText) &&
        (draftText || attachments.length > 0)
    );
    const canStop = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isStopping &&
        (activeRunCount > 0 || isSessionActive(selectedSession))
    );
    const isSessionControlsDisabled = Boolean(
        !isConnected ||
        isSending ||
        isPatchingSession ||
        activeRunCount > 0 ||
        isSessionActive(selectedSession)
    );

    const handleStop = async () => {
        const sessionKey = selectedSessionKey;
        if (!canStop || !sessionKey) {
            return;
        }
        setStoppingSessionKey(sessionKey);
        try {
            await handleSlashCommand("/stop", [], { preserveDraft: true });
        } finally {
            setStoppingSessionKey((current) =>
                isSameChatSession(current, sessionKey) ? "" : current
            );
        }
    };

    const patchSelectedSession = async (patch: ChatSessionPreferences) => {
        if (!selectedSessionKey || isSessionControlsDisabled) {
            return;
        }
        const patchSessionKey = selectedSessionKey;
        setSendError(undefined);
        setPendingPatchCounts((previous) => ({
            ...previous,
            [patchSessionKey]: (previous[patchSessionKey] || 0) + 1,
        }));
        const pendingPatch = (async () => {
            try {
                await transport.patchSession(patchSessionKey, patch);
                return true;
            } catch (error) {
                if (selectedSessionKeyReference.current === patchSessionKey) {
                    setSendError(
                        chatErrorMessage(error, "Failed to update chat settings")
                    );
                }
                return false;
            } finally {
                setPendingPatchCounts((previous) => ({
                    ...previous,
                    [patchSessionKey]: Math.max(0, (previous[patchSessionKey] || 0) - 1),
                }));
            }
        })();
        const pending = pendingPatchesReference.current.get(patchSessionKey) || new Set();
        pending.add(pendingPatch);
        pendingPatchesReference.current.set(patchSessionKey, pending);
        await pendingPatch;
        pending.delete(pendingPatch);
        if (pending.size === 0) {
            pendingPatchesReference.current.delete(patchSessionKey);
        }
    };

    const compactSelectedSession = async () => {
        if (!selectedSessionKey || isSessionControlsDisabled) {
            return;
        }
        const compactSessionKey = selectedSessionKey;
        const idempotencyKey = `dashboard-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        runtime.beginRun(compactSessionKey, idempotencyKey, "compact");
        setSendError(undefined);
        try {
            const result = await transport.send({
                sessionKey: compactSessionKey,
                sessionId: providerSessionId(selectedSession, compactSessionKey),
                message: "/compact",
                idempotencyKey,
            });
            runtime.acknowledgeRun(compactSessionKey, idempotencyKey, result.runId);
        } catch (error) {
            runtime.clearRun(compactSessionKey, idempotencyKey);
            if (selectedSessionKeyReference.current === compactSessionKey) {
                setSendError(chatErrorMessage(error, "Failed to compact context"));
            }
        }
    };

    return {
        canSend,
        canStop,
        compactSelectedSession,
        handleSend,
        handleStop,
        isCompactingSession: isCompacting,
        isSending,
        isStopping,
        patchSelectedSession,
        sessionControlsDisabled: isSessionControlsDisabled,
    };
}

function providerSessionId(
    session: Session | undefined,
    sessionKey: string
): string | undefined {
    if (session?.sessionId) {
        return session.sessionId;
    }
    return session?.id && session.id !== "unknown" && session.id !== sessionKey
        ? session.id
        : undefined;
}
