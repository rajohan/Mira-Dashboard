import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { AttachmentPreviewModal } from "../components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "../components/features/chat/ChatComposer";
import { ChatHeader } from "../components/features/chat/ChatHeader";
import { ChatMessagesList } from "../components/features/chat/ChatMessagesList";
import {
    addDeletedMessageKeys,
    chatFastModePatchValue,
    isSessionActive,
    readDeletedMessageKeys,
    readStoredChatDiagnosticVisibility,
    writeDeletedMessageKeys,
    writeStoredChatDiagnosticVisibility,
} from "../components/features/chat/chatPageUtilities";
import type { ChatPreviewItem } from "../components/features/chat/chatTypes";
import { createChatVisibility as createRuntimeVisibility } from "../components/features/chat/domain/chatPresentation";
import { projectChat } from "../components/features/chat/domain/chatProjection";
import { isSameChatSession } from "../components/features/chat/domain/chatState";
import { buildSlashCommandSuggestions } from "../components/features/chat/slashCommands";
import { useOpenClawChatTransport } from "../components/features/chat/transport/useOpenClawChatTransport";
import { useChatActions } from "../components/features/chat/useChatActions";
import {
    projectChatActivityRows,
    useChatCompactionIndicator,
} from "../components/features/chat/useChatCompactionIndicator";
import { useChatHistory } from "../components/features/chat/useChatHistory";
import { useChatInputMedia } from "../components/features/chat/useChatInputMedia";
import { useChatModels } from "../components/features/chat/useChatModels";
import { useChatRuntime } from "../components/features/chat/useChatRuntime";
import { useChatScroll } from "../components/features/chat/useChatScroll";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { useAgentsStatus } from "../hooks/useAgents";
import type { Session } from "../types/session";
import {
    formatSessionType,
    sortSessionsByTypeAndActivity,
} from "../utils/sessionUtilities";

/** Normalizes chat agent IDs for case-insensitive session bucketing. */
function normalizeChatAgentId(agentId: string): string {
    return agentId.toLowerCase();
}

/** Returns the top-level chat agent bucket for a session. */
function getChatAgentId(session: Session): string {
    const sessionKey = typeof session.key === "string" ? session.key : "";
    const [scope = "", agentId] = sessionKey.split(":");

    if (scope.toLowerCase() === "agent" && agentId) {
        return normalizeChatAgentId(agentId);
    }

    return normalizeChatAgentId(session.agentType || session.type || "unknown");
}

/** Returns whether a live session has a usable key. */
function hasSessionKey(session: Session): boolean {
    return typeof session.key === "string" && session.key.length > 0;
}

/** Formats the session label inside a selected chat agent bucket. */
function formatChatSessionLabel(session: Session, agentId: string): string {
    const sessionKey = session.key;
    const [scope = "", keyAgentId, ...sessionParts] = sessionKey.split(":");
    if (
        scope.toLowerCase() === "agent" &&
        keyAgentId &&
        normalizeChatAgentId(keyAgentId) === agentId
    ) {
        return sessionParts.join(":") || sessionKey;
    }

    return session.displayLabel || session.label || session.displayName || sessionKey;
}

/** Renders the chat UI. */
export function Chat() {
    const navigate = useNavigate();
    const search = useSearch({ strict: false }) as { session?: string };
    const requestedSessionKey = search.session?.trim() || "";
    const transport = useOpenClawChatTransport();
    const { error, isConnected } = transport;
    const selectedSessionKeyReference = useRef("");
    const previousRequestedSessionKeyReference = useRef(requestedSessionKey);
    const shouldStickToBottomReference = useRef(true);
    const resetConfirmResolverReference = useRef<
        ((wasConfirmed: boolean) => void) | undefined
    >(undefined);

    const [selectedSessionKey, setSelectedSessionKey] = useState(requestedSessionKey);
    const [draft, setDraft] = useState("");
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [sendError, setSendError] = useState<string | undefined>(undefined);
    const [dismissedTransportError, setDismissedTransportError] = useState<
        string | undefined
    >(undefined);
    const [deletedMessageKeys, setDeletedMessageKeys] = useState<Set<string>>(
        () => new Set()
    );
    const [pendingDeleteMessageKeys, setPendingDeleteMessageKeys] = useState<string[]>(
        []
    );
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | undefined>(
        undefined
    );
    const [showThinkingOutput, setShowThinkingOutput] = useState(
        () => readStoredChatDiagnosticVisibility().thinking
    );
    const [showToolOutput, setShowToolOutput] = useState(
        () => readStoredChatDiagnosticVisibility().tools
    );
    const [shouldExpandToolDetails, setShouldExpandToolDetails] = useState(
        () => readStoredChatDiagnosticVisibility().toolDetailsExpanded
    );
    const [toolDetailExpansionOverrides, setToolDetailExpansionOverrides] = useState<
        Map<string, boolean>
    >(() => new Map());
    const [keepThinkingAfterFinal, setKeepThinkingAfterFinal] = useState(
        () => readStoredChatDiagnosticVisibility().keepThinkingAfterFinal
    );
    const visibleError =
        sendError || (error === dismissedTransportError ? undefined : error);

    useEffect(() => {
        if (!error) {
            setDismissedTransportError(undefined);
        }
    }, [error]);

    const dismissVisibleError = () => {
        if (sendError) {
            setSendError(undefined);
            return;
        }
        if (error) {
            setDismissedTransportError(error);
        }
    };

    const inputMedia = useChatInputMedia({
        onError: setSendError,
        sessionKey: selectedSessionKey,
        setDraft,
    });
    const {
        attachments,
        attachmentsReference,
        clearAttachments,
        fileInputReference,
        handleFilesSelected,
        handleToggleRecording,
        handleVoiceFileSelected,
        isRecording,
        isTranscribing,
        removeAttachment,
        voiceFileInputReference,
    } = inputMedia;

    const { data: sessions = [] } = useLiveQuery((query) =>
        query.from({ session: sessionsCollection })
    );
    const { data: agentsStatus } = useAgentsStatus();
    const agents = agentsStatus?.agents || [];
    selectedSessionKeyReference.current = selectedSessionKey;

    const sortedSessions = sortSessionsByTypeAndActivity(sessions);
    const sessionMap = new Map(sortedSessions.map((session) => [session.key, session]));
    const selectedSessionUpdatedAt = selectedSessionKey
        ? sessionMap.get(selectedSessionKey)?.updatedAt
        : undefined;
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || undefined
        : undefined;
    const selectedAgentId = selectedSession ? getChatAgentId(selectedSession) : "";
    const sessionsForSelectedAgent = selectedAgentId
        ? sortedSessions.filter((session) => getChatAgentId(session) === selectedAgentId)
        : sortedSessions;
    const history = useChatHistory({
        isConnected,
        onError: setSendError,
        selectedSessionKey,
        selectedSessionKeyReference,
        selectedSessionUpdatedAt,
        setIsAtBottom,
        shouldStickToBottomReference,
        transport,
    });
    const { isLoadingHistory, messages, refreshSoon, setMessages } = history;
    const runtime = useChatRuntime({
        onError: setSendError,
        onSettled: refreshSoon,
        selectedSessionKey,
        transport,
    });
    const chatModelOptions = useChatModels(transport);
    const chatVisibility = createRuntimeVisibility(showThinkingOutput, showToolOutput);
    const projection = projectChat(
        messages,
        runtime.state,
        selectedSessionKey,
        chatVisibility,
        keepThinkingAfterFinal,
        deletedMessageKeys
    );
    const compactionIndicator = useChatCompactionIndicator(projection.compactionStatus);
    const chatRows = projectChatActivityRows({
        activeRuns: projection.activeRuns,
        compactionStatus: compactionIndicator,
        isActiveSession: isSessionActive(selectedSession),
        rows: projection.rows,
        sessionKey: selectedSessionKey,
    });
    const scroll = useChatScroll(
        chatRows,
        selectedSessionKey,
        setIsAtBottom,
        shouldStickToBottomReference,
        isLoadingHistory
    );
    const {
        handleDynamicContentLoad: handleDynamicRowContentLoad,
        handleScroll: handleMessagesScroll,
        handleUserScrollIntent,
        messagesContainerReference,
        scheduleBottomFollow,
        scrollToBottom: scrollMessagesToBottom,
        virtualizer: messagesVirtualizer,
    } = scroll;

    const selectSession = useCallback(
        (sessionKey: string) => {
            setSelectedSessionKey(sessionKey);
            void navigate({
                to: "/chat",
                search: sessionKey ? { session: sessionKey } : {},
                replace: true,
            });
        },
        [navigate]
    );

    useEffect(() => {
        const previousRequestedSessionKey = previousRequestedSessionKeyReference.current;
        previousRequestedSessionKeyReference.current = requestedSessionKey;
        if (requestedSessionKey) {
            if (requestedSessionKey !== selectedSessionKey) {
                setSelectedSessionKey(requestedSessionKey);
            }
            return;
        }
        if (
            previousRequestedSessionKey &&
            selectedSessionKey === previousRequestedSessionKey
        ) {
            setSelectedSessionKey("");
        }
    }, [requestedSessionKey, selectedSessionKey]);

    useEffect(() => {
        if (sortedSessions.length === 0) {
            if (selectedSessionKey && !requestedSessionKey) {
                setSelectedSessionKey("");
            }
            return;
        }

        if (!selectedSessionKey || !sessionMap.has(selectedSessionKey)) {
            const fallbackSession = sortedSessions.find(
                (session) => session.key && sessionMap.has(session.key)
            );
            setSelectedSessionKey(fallbackSession?.key || "");
            if (requestedSessionKey) {
                void navigate({ to: "/chat", search: {}, replace: true });
            }
        }
    }, [navigate, requestedSessionKey, selectedSessionKey, sessionMap, sortedSessions]);

    useEffect(() => {
        setDeletedMessageKeys(
            selectedSessionKey ? readDeletedMessageKeys(selectedSessionKey) : new Set()
        );
        setPendingDeleteMessageKeys([]);
        setToolDetailExpansionOverrides(new Map());
    }, [selectedSessionKey]);

    useEffect(() => {
        writeStoredChatDiagnosticVisibility({
            keepThinkingAfterFinal,
            thinking: showThinkingOutput,
            toolDetailsExpanded: shouldExpandToolDetails,
            tools: showToolOutput,
        });
    }, [
        keepThinkingAfterFinal,
        shouldExpandToolDetails,
        showThinkingOutput,
        showToolOutput,
    ]);

    const handleToggleToolDetails = (toolKey: string) => {
        setToolDetailExpansionOverrides((current) => {
            const next = new Map(current);
            const isExpanded = current.get(toolKey) ?? shouldExpandToolDetails;
            next.set(toolKey, !isExpanded);
            return next;
        });
    };

    const handleToggleAllToolDetails = () => {
        setShouldExpandToolDetails((current) => !current);
        setToolDetailExpansionOverrides(new Map());
    };

    const sessionOptions = sessionsForSelectedAgent
        .filter((session) => hasSessionKey(session))
        .map((session) => ({
            value: session.key,
            label: formatChatSessionLabel(session, selectedAgentId),
            description: `${formatSessionType(session)} · ${session.model || "Unknown"}`,
        }));

    const selectableSessions = sortedSessions.filter((session) => hasSessionKey(session));
    const agentSessionCounts = new Map<string, number>();
    for (const session of selectableSessions) {
        const agentId = getChatAgentId(session);
        agentSessionCounts.set(agentId, (agentSessionCounts.get(agentId) || 0) + 1);
    }

    const agentOptions = [...agentSessionCounts].map(([agentId, count]) => {
        const agent = agents.find((entry) => normalizeChatAgentId(entry.id) === agentId);
        return {
            value: agentId,
            label: agentId,
            description: `${count} session${count === 1 ? "" : "s"}${agent?.status ? ` · ${agent.status}` : ""}`,
        };
    });

    /** Selects newest/default session for selected agent. */
    const handleSelectAgent = (agentId: string) => {
        if (agentId === selectedAgentId) {
            return;
        }

        const agentSession = agents.find(
            (agent) => normalizeChatAgentId(agent.id) === agentId
        )?.sessionKey as string | undefined;
        const nextSession =
            sortedSessions.find(
                (session) =>
                    hasSessionKey(session) &&
                    isSameChatSession(session.key, agentSession) &&
                    getChatAgentId(session) === agentId
            ) ||
            sortedSessions.find(
                (session) => hasSessionKey(session) && getChatAgentId(session) === agentId
            );
        if (nextSession) {
            selectSession(nextSession.key);
        }
    };

    const slashCommandSuggestions = buildSlashCommandSuggestions(draft, chatModelOptions);

    /** Performs apply slash suggestion. */
    const applySlashSuggestion = (value: string) => {
        setDraft(value);
    };

    /** Responds to delete message events. */
    const handleDeleteMessage = (messageKey: string, deleteKeys?: readonly string[]) => {
        setPendingDeleteMessageKeys(deleteKeys?.length ? [...deleteKeys] : [messageKey]);
    };

    /** Performs confirm delete message. */
    const confirmDeleteMessage = () => {
        if (!selectedSessionKey || pendingDeleteMessageKeys.length === 0) {
            return;
        }

        setDeletedMessageKeys((wasPrevious) => {
            const next = addDeletedMessageKeys(wasPrevious, pendingDeleteMessageKeys);
            writeDeletedMessageKeys(selectedSessionKey, next);
            return next;
        });
        setPendingDeleteMessageKeys([]);
    };

    /** Resolves a pending reset confirmation and hides the modal. */
    const closeResetConfirm = (wasConfirmed: boolean) => {
        resetConfirmResolverReference.current?.(wasConfirmed);
        resetConfirmResolverReference.current = undefined;
        setIsResetConfirmOpen(false);
    };

    /** Opens the reset confirmation modal and resolves with the user's choice. */
    const confirmResetSession = () =>
        new Promise<boolean>((resolve) => {
            resetConfirmResolverReference.current?.(false);
            resetConfirmResolverReference.current = resolve;
            setIsResetConfirmOpen(true);
        });

    useEffect(() => {
        return () => {
            resetConfirmResolverReference.current?.(false);
            resetConfirmResolverReference.current = undefined;
        };
    }, []);

    const actions = useChatActions({
        activeRunCount: projection.activeRuns.length,
        attachments,
        attachmentsReference,
        clearAttachments,
        confirmResetSession,
        draft,
        // Mirrors Control UI's five-minute stale-status failsafe. Locally
        // initiated compaction RPCs stay locked independently in useChatActions.
        isCompacting: compactionIndicator?.phase === "active",
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
    });
    const {
        canSend,
        canStop,
        compactDisabled,
        compactSelectedSession,
        handleSend,
        handleStop,
        isCompactingSession,
        isSending,
        isStopping,
        patchSelectedSession,
        preferenceControlsDisabled,
    } = actions;

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-3 sm:p-4 lg:p-6">
            <div className="min-h-0 flex-1">
                <Card className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent p-0">
                    <ChatHeader
                        selectedSession={selectedSession}
                        selectedAgentId={selectedAgentId}
                        selectedSessionKey={selectedSessionKey}
                        sessionOptions={sessionOptions}
                        agentOptions={agentOptions}
                        onSelectAgent={handleSelectAgent}
                        onSelectSession={selectSession}
                    />

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        isAtBottom={isAtBottom}
                        chatRows={chatRows}
                        messagesContainerReference={messagesContainerReference}
                        messagesVirtualizer={messagesVirtualizer}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onFollow={scrollMessagesToBottom}
                        onPreview={setPreviewItem}
                        visibility={createRuntimeVisibility(
                            showThinkingOutput,
                            showToolOutput
                        )}
                        onScroll={handleMessagesScroll}
                        onUserScrollIntent={handleUserScrollIntent}
                        onTtsError={setSendError}
                        onDeleteMessage={handleDeleteMessage}
                        shouldExpandToolDetails={shouldExpandToolDetails}
                        toolDetailExpansionOverrides={toolDetailExpansionOverrides}
                        onToggleToolDetails={handleToggleToolDetails}
                    />

                    {visibleError && (
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 sm:mt-4 sm:text-sm">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            <span className="min-w-0 flex-1 wrap-break-word">
                                {visibleError}
                            </span>
                            <button
                                type="button"
                                onClick={dismissVisibleError}
                                className="-m-1 shrink-0 rounded p-1 text-red-200/70 transition hover:bg-red-500/15 hover:text-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
                                aria-label="Dismiss error"
                                title="Dismiss error"
                            >
                                <X className="size-4" />
                            </button>
                        </div>
                    )}

                    <input
                        ref={(element) => {
                            voiceFileInputReference.current = element ?? undefined;
                        }}
                        type="file"
                        accept="audio/*"
                        capture
                        className="hidden"
                        onChange={(event) =>
                            void handleVoiceFileSelected(event.target.files ?? undefined)
                        }
                    />

                    <ChatComposer
                        attachments={attachments}
                        modelOptions={chatModelOptions}
                        canSend={canSend}
                        canStop={canStop}
                        draft={draft}
                        fileInputReference={fileInputReference}
                        isConnected={isConnected}
                        isRecording={isRecording}
                        isSending={isSending}
                        isStopping={isStopping}
                        isTranscribing={isTranscribing}
                        selectedSessionKey={selectedSessionKey}
                        selectedSession={selectedSession}
                        shouldShowThinking={showThinkingOutput}
                        shouldShowTools={showToolOutput}
                        shouldExpandToolDetails={shouldExpandToolDetails}
                        shouldKeepThinkingAfterFinal={keepThinkingAfterFinal}
                        compactDisabled={compactDisabled}
                        preferenceControlsDisabled={preferenceControlsDisabled}
                        isCompacting={isCompactingSession}
                        slashCommandSuggestions={slashCommandSuggestions}
                        onApplySlashSuggestion={applySlashSuggestion}
                        onAttachFiles={(files) => void handleFilesSelected(files)}
                        onChangeDraft={setDraft}
                        onPreview={setPreviewItem}
                        onRemoveAttachment={removeAttachment}
                        onSend={() => void handleSend()}
                        onStop={() => void handleStop()}
                        onToggleRecording={() => void handleToggleRecording()}
                        onToggleThinking={() => setShowThinkingOutput((value) => !value)}
                        onToggleTools={() => setShowToolOutput((value) => !value)}
                        onToggleToolDetailsExpansion={handleToggleAllToolDetails}
                        onToggleKeepThinkingAfterFinal={() => {
                            if (!showThinkingOutput) {
                                return;
                            }
                            setKeepThinkingAfterFinal((value) => !value);
                        }}
                        onSelectThinkingLevel={(thinkingLevel) =>
                            void patchSelectedSession({
                                // Gateway uses null to clear an inherited override.
                                // eslint-disable-next-line unicorn/no-null
                                thinkingLevel: thinkingLevel || null,
                            })
                        }
                        onSelectSpeed={(speed) =>
                            void patchSelectedSession({
                                fastMode: chatFastModePatchValue(speed),
                            })
                        }
                        onSelectModel={(model) => void patchSelectedSession({ model })}
                        onCompact={() => void compactSelectedSession()}
                    />
                </Card>
            </div>

            <AttachmentPreviewModal
                previewItem={previewItem}
                onClose={() => setPreviewItem(undefined)}
            />

            <ConfirmModal
                isOpen={pendingDeleteMessageKeys.length > 0}
                title="Delete message"
                message="Delete this message from your chat view?"
                confirmLabel="Delete"
                danger
                onCancel={() => setPendingDeleteMessageKeys([])}
                onConfirm={confirmDeleteMessage}
            />

            <ConfirmModal
                isOpen={isResetConfirmOpen}
                title="Reset chat session"
                message="Reset this chat session? This clears the session history/transcript for the selected target."
                confirmLabel="Reset"
                danger
                onCancel={() => closeResetConfirm(false)}
                onConfirm={() => closeResetConfirm(true)}
            />
        </div>
    );
}
