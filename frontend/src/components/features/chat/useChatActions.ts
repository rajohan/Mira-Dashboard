import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { ChatSessionPreferences } from "../../../../../contracts/chat";
import type { Session } from "../../../../../contracts/sessions";
import { messageFromError } from "../../../lib/errorMessage";
import { SecurityVerificationCancelledError } from "../../../lib/securityVerification";
import { currentIsoString } from "../../../utils/date";
import { isResetSlashCommand, isSessionActive } from "./chatPageUtilities";
import { executeChatSlashCommand } from "./chatSlashCommandHandler";
import {
    type ChatHistoryMessage,
    type ChatSendAttachment,
    chatTransportAttachments,
    optimisticAttachmentDisplay,
} from "./chatTypes";
import {
    dedupeMessages,
    messageIdentity,
    rollbackFailedOptimisticMessage,
} from "./chatUtilities";
import { isSameChatSession } from "./domain/chatState";
import type { ChatTransport } from "./transport/chatTransport";
import type { ChatRuntimeController } from "./useChatRuntime";

interface ChatActionsOptions {
    activeRunCount: number;
    attachments: ChatSendAttachment[];
    attachmentsRef: RefObject<ChatSendAttachment[]>;
    clearAttachments: () => number;
    confirmResetSession: () => Promise<boolean>;
    draft: string;
    isCompacting: boolean;
    isConnected: boolean;
    isRecording: boolean;
    isTranscribing: boolean;
    restoreAttachments?: (
        attachments: ChatSendAttachment[],
        expectedAttachmentRestoreEpoch: number
    ) => boolean;
    runtime: ChatRuntimeController;
    scheduleBottomFollow: () => void;
    selectedSession?: Session;
    selectedSessionKey: string;
    selectedSessionKeyRef: RefObject<string>;
    setDraft: Dispatch<SetStateAction<string>>;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    setSendError: Dispatch<SetStateAction<string | undefined>>;
    shouldStickToBottomRef: RefObject<boolean>;
    transport: ChatTransport;
}

function dashboardChatRunId(): string {
    let uniqueId: string;
    if (typeof crypto.randomUUID === "function") {
        uniqueId = crypto.randomUUID();
    } else {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = ((bytes[6] ?? 0) % 16) + 64;
        bytes[8] = ((bytes[8] ?? 0) % 64) + 128;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
            ""
        );
        uniqueId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
            12,
            16
        )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `dashboard-chat-${uniqueId}`;
}

/**
 * Owns stateful chat commands while the page remains a view composition.
 * @returns Chat actions state and actions.
 */
export function useChatActions({
    activeRunCount,
    attachments,
    attachmentsRef,
    clearAttachments,
    confirmResetSession,
    draft,
    isCompacting,
    isConnected,
    isRecording,
    isTranscribing,
    restoreAttachments,
    runtime,
    scheduleBottomFollow,
    selectedSession,
    selectedSessionKey,
    selectedSessionKeyRef,
    setDraft,
    setIsAtBottom,
    setMessages,
    setSendError,
    shouldStickToBottomRef,
    transport,
}: ChatActionsOptions) {
    const sendCountRef = useRef(0);
    const sendEpochRef = useRef(0);
    const inFlightInputRevisionsRef = useRef(new Set<number>());
    const inputRevisionRef = useRef({ attachments, draft, revision: 0 });
    const pendingPatchesRef = useRef(new Map<string, Set<Promise<boolean>>>());
    const draftRef = useRef(draft);
    const isCompactingRef = useRef(isCompacting);
    const compactingSessionKeysRef = useRef(new Set<string>());
    const [compactingSessionKeys, setCompactingSessionKeys] = useState(
        () => new Set<string>()
    );
    const [sendingGeneration, setSendingGeneration] = useState<number | undefined>();
    const [stoppingSessionKey, setStoppingSessionKey] = useState("");
    const [pendingPatchCounts, setPendingPatchCounts] = useState<Record<string, number>>(
        {}
    );

    useLayoutEffect(() => {
        if (
            inputRevisionRef.current.attachments !== attachments ||
            inputRevisionRef.current.draft !== draft
        ) {
            inputRevisionRef.current = {
                attachments,
                draft,
                revision: inputRevisionRef.current.revision + 1,
            };
        }
        draftRef.current = draft;
        isCompactingRef.current = isCompacting;
    }, [attachments, draft, isCompacting]);

    useEffect(() => {
        if (isConnected) {
            return;
        }

        sendEpochRef.current += 1;
        sendCountRef.current = 0;
        inFlightInputRevisionsRef.current.clear();
        // A session-cookie rotation disconnects while a verified RPC is still pending.
        // Let each compaction promise release its own lock when it actually settles.
    }, [isConnected]);

    const handleSlashCommand = (
        commandText: string,
        currentAttachments: ChatSendAttachment[] = attachments,
        options: { preserveDraft?: boolean } = {}
    ) =>
        executeChatSlashCommand(
            {
                abort: transport.abort,
                attachments,
                clearRuntime: runtime.clearSession,
                confirmResetSession,
                selectedSessionKey,
                selectedSessionKeyRef,
                setDraft,
                setMessages,
                setSendError,
            },
            commandText,
            currentAttachments,
            options
        );

    const beginSend = (inputRevision: number) => {
        sendCountRef.current += 1;
        inFlightInputRevisionsRef.current.add(inputRevision);
        setSendingGeneration(transport.connectionGeneration);
        return sendEpochRef.current;
    };

    const endSend = (sendEpoch: number, inputRevision: number) => {
        inFlightInputRevisionsRef.current.delete(inputRevision);
        if (sendEpoch !== sendEpochRef.current) {
            return;
        }
        sendCountRef.current = Math.max(0, sendCountRef.current - 1);
        setSendingGeneration(
            sendCountRef.current > 0 ? transport.connectionGeneration : undefined
        );
    };

    const isBlockedByInFlightSend = () =>
        sendCountRef.current > 0 &&
        (activeRunCount === 0 ||
            inFlightInputRevisionsRef.current.has(inputRevisionRef.current.revision));

    const isSessionCompacting = (sessionKey: string) =>
        isCompactingRef.current ||
        compactingSessionKeysRef.current
            .values()
            .some((candidate) => isSameChatSession(candidate, sessionKey));
    const handleSend = async () => {
        if (!selectedSessionKey || !selectedSession) {
            return;
        }
        const pendingSessionKey = selectedSessionKey;
        let text = draft.trim();
        if (
            isSessionCompacting(pendingSessionKey) ||
            isBlockedByInFlightSend() ||
            (!text && attachments.length === 0)
        ) {
            return;
        }

        const pendingPatches = pendingPatchesRef.current.get(pendingSessionKey);
        const patchResults = pendingPatches ? await Promise.all(pendingPatches) : [];
        if (
            patchResults.includes(false) ||
            selectedSessionKeyRef.current !== pendingSessionKey
        ) {
            return;
        }

        text = draftRef.current.trim();
        const currentAttachments = attachmentsRef.current;
        if (
            isSessionCompacting(pendingSessionKey) ||
            isBlockedByInFlightSend() ||
            (!text && currentAttachments.length === 0)
        ) {
            return;
        }

        const inputRevision = inputRevisionRef.current.revision;
        const clearedInputRevision = inputRevision + 1;
        const sendEpoch = beginSend(inputRevision);
        if (text.startsWith("/")) {
            try {
                const wasHandled = await handleSlashCommand(text, currentAttachments);
                if (selectedSessionKeyRef.current !== pendingSessionKey) {
                    endSend(sendEpoch, inputRevision);
                    return;
                }
                if (wasHandled) {
                    endSend(sendEpoch, inputRevision);
                    return;
                }
            } catch (error) {
                if (selectedSessionKeyRef.current === pendingSessionKey) {
                    setSendError(messageFromError(error, "Failed to run slash command"));
                }
                endSend(sendEpoch, inputRevision);
                return;
            }
        }

        const isResetCommand = isResetSlashCommand(text);
        const idempotencyKey = isResetCommand ? undefined : dashboardChatRunId();
        const isLiveSteer = activeRunCount > 0 || isSessionActive(selectedSession);
        const userMessage: ChatHistoryMessage = {
            role: "user",
            content: text,
            text,
            images: [],
            attachments: optimisticAttachmentDisplay(currentAttachments),
            local: true,
            runId: idempotencyKey,
            timestamp: currentIsoString(),
        };
        const optimisticIdentity = messageIdentity(userMessage);
        let replacedMessages: Array<{
            index: number;
            message: ChatHistoryMessage;
        }> = [];
        if (!isResetCommand) {
            setMessages((previous) => {
                replacedMessages = previous.flatMap((message, index) =>
                    messageIdentity(message) === optimisticIdentity
                        ? [{ index, message }]
                        : []
                );
                return dedupeMessages([...previous, userMessage]);
            });
        }
        draftRef.current = "";
        setDraft("");
        const clearedAttachmentRestoreEpoch = clearAttachments();
        setSendError(undefined);
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        scheduleBottomFollow();

        if (idempotencyKey) {
            runtime.beginRun(pendingSessionKey, idempotencyKey, {
                replaceStatusOnlyRuns: !isLiveSteer,
            });
        }

        try {
            if (!text.startsWith("/") && selectedSession?.verboseLevel !== "full") {
                try {
                    await transport.patchSession(pendingSessionKey, {
                        verboseLevel: "full",
                    });
                } catch (error) {
                    if (error instanceof SecurityVerificationCancelledError) {
                        throw error;
                    }
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
            if (isResetCommand) {
                runtime.clearSession(pendingSessionKey);
                if (selectedSessionKeyRef.current === pendingSessionKey) {
                    setMessages([]);
                }
            } else if (idempotencyKey) {
                if (result.runId) {
                    runtime.acknowledgeRun(
                        pendingSessionKey,
                        idempotencyKey,
                        result.runId
                    );
                } else if (isLiveSteer) {
                    // OpenClaw resolves its configured queue mode inside chat.send.
                    // A runless acknowledgement therefore belongs to the active run.
                    runtime.clearRun(pendingSessionKey, idempotencyKey);
                } else {
                    // The provider may keep the idempotency key as the run identity.
                    runtime.acknowledgeRun(pendingSessionKey, idempotencyKey);
                }
            }
        } catch (error) {
            if (idempotencyKey) {
                runtime.failRun(pendingSessionKey, idempotencyKey);
            }
            if (selectedSessionKeyRef.current === pendingSessionKey) {
                setSendError(
                    error instanceof SecurityVerificationCancelledError
                        ? undefined
                        : messageFromError(error, "Failed to send message")
                );
            }
            if (!isResetCommand && selectedSessionKeyRef.current === pendingSessionKey) {
                const currentInputRevision = inputRevisionRef.current.revision;
                if (
                    !draftRef.current.trim() &&
                    (currentInputRevision === inputRevision ||
                        currentInputRevision === clearedInputRevision)
                ) {
                    const canRestoreAttachments = restoreAttachments
                        ? restoreAttachments(
                              currentAttachments,
                              clearedAttachmentRestoreEpoch
                          )
                        : currentAttachments.length === 0;
                    if (canRestoreAttachments) {
                        draftRef.current = text;
                        setDraft(text);
                    }
                }
                setMessages((previous) =>
                    rollbackFailedOptimisticMessage(
                        previous,
                        userMessage,
                        replacedMessages
                    )
                );
            }
        } finally {
            endSend(sendEpoch, inputRevision);
        }
    };

    const isSending = isConnected && sendingGeneration === transport.connectionGeneration;
    const draftText = draft.trim();
    const isStopping = isSameChatSession(stoppingSessionKey, selectedSessionKey);
    const isPatchingSession = (pendingPatchCounts[selectedSessionKey] || 0) > 0;
    const isCompactingSession =
        isCompacting ||
        compactingSessionKeys
            .values()
            .some((candidate) => isSameChatSession(candidate, selectedSessionKey));
    const canSend = Boolean(
        isConnected &&
        selectedSessionKey &&
        selectedSession &&
        !isRecording &&
        !isTranscribing &&
        !isCompactingSession &&
        !isPatchingSession &&
        !isStopping &&
        !(isSending && activeRunCount === 0) &&
        (draftText || attachments.length > 0)
    );
    const canStop = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isStopping &&
        (activeRunCount > 0 || isSessionActive(selectedSession))
    );
    const arePreferenceControlsDisabled =
        !isConnected || !selectedSession || isPatchingSession;
    const isCompactDisabled =
        !isConnected ||
        !selectedSession ||
        isSending ||
        isCompactingSession ||
        isPatchingSession ||
        activeRunCount > 0 ||
        isSessionActive(selectedSession);

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
        if (!selectedSessionKey || arePreferenceControlsDisabled) {
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
                if (selectedSessionKeyRef.current === patchSessionKey) {
                    setSendError(
                        messageFromError(error, "Failed to update chat settings")
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
        const pending = pendingPatchesRef.current.get(patchSessionKey) || new Set();
        pending.add(pendingPatch);
        pendingPatchesRef.current.set(patchSessionKey, pending);
        await pendingPatch;
        pending.delete(pendingPatch);
        if (pending.size === 0) {
            pendingPatchesRef.current.delete(patchSessionKey);
        }
    };

    const compactSelectedSession = async () => {
        if (
            !selectedSessionKey ||
            isCompactDisabled ||
            isSessionCompacting(selectedSessionKey)
        ) {
            return;
        }
        const compactSessionKey = selectedSessionKey;
        const pendingCompactions = new Set(compactingSessionKeysRef.current).add(
            compactSessionKey
        );
        compactingSessionKeysRef.current = pendingCompactions;
        setCompactingSessionKeys(pendingCompactions);
        setSendError(undefined);
        try {
            await transport.compact(compactSessionKey);
        } catch (error) {
            if (selectedSessionKeyRef.current === compactSessionKey) {
                setSendError(messageFromError(error, "Failed to compact context"));
            }
        } finally {
            const remainingCompactions = new Set(
                compactingSessionKeysRef.current
                    .values()
                    .filter(
                        (candidate) => !isSameChatSession(candidate, compactSessionKey)
                    )
            );
            compactingSessionKeysRef.current = remainingCompactions;
            setCompactingSessionKeys(remainingCompactions);
        }
    };

    return {
        canSend,
        canStop,
        compactDisabled: isCompactDisabled,
        compactSelectedSession,
        handleSend,
        handleStop,
        isCompactingSession,
        isSending,
        isStopping,
        patchSelectedSession,
        preferenceControlsDisabled: arePreferenceControlsDisabled,
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
