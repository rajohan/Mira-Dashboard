import { AlertCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AttachmentPreviewModal } from "../components/features/chat/AttachmentPreviewModal";
import { ChatComposer } from "../components/features/chat/ChatComposer";
import { ChatHeader } from "../components/features/chat/ChatHeader";
import { ChatMessagesList } from "../components/features/chat/ChatMessagesList";
import {
    chatFastModePatchValue,
    isSessionActive,
} from "../components/features/chat/chatPageUtilities";
import { type ChatPreviewItem } from "../components/features/chat/chatTypes";
import { createChatVisibility as createRuntimeVisibility } from "../components/features/chat/domain/chatPresentation";
import { buildSlashCommandSuggestions } from "../components/features/chat/slashCommands";
import { useOpenClawChatTransport } from "../components/features/chat/transport/useOpenClawChatTransport";
import { useCanonicalChatProjection } from "../components/features/chat/useCanonicalChatProjection";
import { useChatActions } from "../components/features/chat/useChatActions";
import {
    projectChatActivityRows,
    useChatCompactionIndicator,
} from "../components/features/chat/useChatCompactionIndicator";
import { useChatDiagnostics } from "../components/features/chat/useChatDiagnostics";
import { useChatHistory } from "../components/features/chat/useChatHistory";
import { useChatInputMedia } from "../components/features/chat/useChatInputMedia";
import { useChatMessageControls } from "../components/features/chat/useChatMessageControls";
import { useChatModels } from "../components/features/chat/useChatModels";
import { useChatRuntime } from "../components/features/chat/useChatRuntime";
import { useChatScroll } from "../components/features/chat/useChatScroll";
import { useChatSessionSelection } from "../components/features/chat/useChatSessionSelection";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";

/**
 * Renders the chat UI.
 * @returns Rendered the chat UI.
 */
export function Chat() {
    const transport = useOpenClawChatTransport();
    const { error, isConnected } = transport;
    const {
        agentOptions,
        requestedSessionKey,
        selectedAgentId,
        selectedSession,
        selectedSessionKey,
        selectedSessionUpdatedAt,
        selectAgent,
        selectSession,
        sessionOptions,
    } = useChatSessionSelection();
    const selectedSessionKeyRef = useRef("");
    const shouldStickToBottomRef = useRef(true);

    const [draft, setDraft] = useState("");
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [sendError, setSendError] = useState<string | undefined>();
    const [dismissedTransportError, setDismissedTransportError] = useState<
        string | undefined
    >();
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | undefined>();
    const [observedTransportError, setObservedTransportError] = useState(error);
    const diagnostics = useChatDiagnostics(selectedSessionKey, requestedSessionKey);
    const messageControls = useChatMessageControls(
        selectedSessionKey,
        requestedSessionKey
    );
    const {
        keepThinkingAfterFinal,
        setKeepThinkingAfterFinal,
        setShowThinkingOutput,
        setShowToolOutput,
        shouldExpandToolDetails,
        showThinkingOutput,
        showToolOutput,
        toggleAllToolDetails,
        toggleToolDetails,
        toolDetailExpansionOverrides,
    } = diagnostics;
    const {
        cancelMessageDeletion,
        closeResetConfirmation,
        confirmMessageDeletion,
        confirmResetSession,
        deletedMessageKeys,
        isDeleteConfirmationOpen,
        isResetConfirmOpen,
        requestMessageDeletion,
    } = messageControls;

    if (observedTransportError !== error) {
        setObservedTransportError(error);
        setDismissedTransportError(undefined);
    }

    const inputMedia = useChatInputMedia({
        onError: setSendError,
        sessionKey: selectedSessionKey,
        setDraft,
    });
    const {
        attachmentError,
        attachments,
        attachmentsRef,
        clearAttachmentError,
        clearAttachments,
        fileInputRef,
        handleFilesSelected,
        handleToggleRecording,
        handleVoiceFileSelected,
        isRecording,
        isTranscribing,
        removeAttachment,
        restoreAttachments,
        voiceFileInputRef,
    } = inputMedia;
    const composerAttachmentError =
        attachmentError?.source === "composer" ? attachmentError.message : undefined;
    const attachmentPickerError =
        attachmentError?.source === "picker" ? attachmentError.message : undefined;
    const visibleError =
        sendError ||
        composerAttachmentError ||
        (error === dismissedTransportError ? undefined : error);

    const dismissVisibleError = () => {
        if (sendError) {
            setSendError(undefined);
            return;
        }
        if (composerAttachmentError) {
            clearAttachmentError("composer");
            return;
        }
        if (error) {
            setDismissedTransportError(error);
        }
    };

    useEffect(() => {
        selectedSessionKeyRef.current = selectedSessionKey;
    }, [selectedSessionKey]);

    const history = useChatHistory({
        isConnected,
        onError: setSendError,
        selectedSessionKey,
        selectedSessionKeyRef: selectedSessionKeyRef,
        selectedSessionUpdatedAt,
        setIsAtBottom,
        shouldStickToBottomRef: shouldStickToBottomRef,
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
    const { projection } = useCanonicalChatProjection({
        deletedMessageKeys,
        history: messages,
        runtime: runtime.state,
        selectedSessionKey,
        shouldKeepThinkingAfterFinal: keepThinkingAfterFinal,
        shouldShowThinking: showThinkingOutput,
        shouldShowTools: showToolOutput,
    });
    const compactionIndicator = useChatCompactionIndicator(projection.compactionStatus);
    const chatRows = projectChatActivityRows({
        activeRuns: projection.activeRuns,
        compactionStatus: compactionIndicator,
        isActiveSession: isSessionActive(selectedSession),
        rows: projection.rows,
        sessionKey: selectedSessionKey,
    });
    const composerLayoutKey = `${attachments.length}:${visibleError ?? ""}`;
    const scroll = useChatScroll(
        chatRows,
        selectedSessionKey,
        setIsAtBottom,
        shouldStickToBottomRef,
        isLoadingHistory,
        composerLayoutKey
    );
    const {
        followToBottom: followMessagesToBottom,
        handleDynamicContentLoad: handleDynamicRowContentLoad,
        handleScroll: handleMessagesScroll,
        handleUserScrollIntent,
        messagesContainerRef,
        newMessageCount,
        scheduleBottomFollow,
        virtualizer: messagesVirtualizer,
    } = scroll;

    const slashCommandSuggestions = buildSlashCommandSuggestions(draft, chatModelOptions);

    /**
     * Performs apply slash suggestion.
     * @param value Value to process.
     */
    const applySlashSuggestion = (value: string) => {
        setDraft(value);
    };

    const actions = useChatActions({
        activeRunCount: projection.activeRuns.length,
        attachments,
        attachmentsRef,
        clearAttachments,
        confirmResetSession,
        draft,
        // Mirrors Control UI's five-minute stale-status failsafe. Locally
        // initiated compaction RPCs stay locked independently in useChatActions.
        isCompacting: compactionIndicator?.phase === "active",
        isConnected,
        isRecording,
        isTranscribing,
        restoreAttachments,
        runtime,
        scheduleBottomFollow,
        selectedSession,
        selectedSessionKey,
        selectedSessionKeyRef: selectedSessionKeyRef,
        setDraft,
        setIsAtBottom,
        setMessages,
        setSendError,
        shouldStickToBottomRef: shouldStickToBottomRef,
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
                        onSelectAgent={selectAgent}
                        onSelectSession={selectSession}
                    />

                    <ChatMessagesList
                        isLoadingHistory={isLoadingHistory}
                        isAtBottom={isAtBottom}
                        chatRows={chatRows}
                        messagesContainerRef={messagesContainerRef}
                        messagesVirtualizer={messagesVirtualizer}
                        newMessageCount={newMessageCount}
                        onDynamicContentLoad={handleDynamicRowContentLoad}
                        onFollow={followMessagesToBottom}
                        onPreview={setPreviewItem}
                        visibility={createRuntimeVisibility(
                            showThinkingOutput,
                            showToolOutput
                        )}
                        onScroll={handleMessagesScroll}
                        onUserScrollIntent={handleUserScrollIntent}
                        onTtsError={setSendError}
                        onDeleteMessage={requestMessageDeletion}
                        shouldExpandToolDetails={shouldExpandToolDetails}
                        toolDetailExpansionOverrides={toolDetailExpansionOverrides}
                        onToggleToolDetails={toggleToolDetails}
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
                            voiceFileInputRef.current = element ?? undefined;
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
                        attachmentPickerError={attachmentPickerError}
                        attachments={attachments}
                        modelOptions={chatModelOptions}
                        canSend={canSend}
                        canStop={canStop}
                        draft={draft}
                        fileInputRef={fileInputRef}
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
                        onAttachFiles={(files, source) =>
                            void handleFilesSelected(files, source)
                        }
                        onChangeDraft={setDraft}
                        onDismissAttachmentPickerError={() =>
                            clearAttachmentError("picker")
                        }
                        onPreview={setPreviewItem}
                        onRemoveAttachment={removeAttachment}
                        onSend={() => void handleSend()}
                        onStop={() => void handleStop()}
                        onToggleRecording={() => void handleToggleRecording()}
                        onToggleThinking={() => setShowThinkingOutput((value) => !value)}
                        onToggleTools={() => setShowToolOutput((value) => !value)}
                        onToggleToolDetailsExpansion={toggleAllToolDetails}
                        onToggleKeepThinkingAfterFinal={() => {
                            if (!showThinkingOutput) {
                                return;
                            }
                            setKeepThinkingAfterFinal((value) => !value);
                        }}
                        onSelectThinkingLevel={(thinkingLevel) =>
                            void patchSelectedSession({
                                // Gateway uses null to clear an inherited override.
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
                isOpen={isDeleteConfirmationOpen}
                title="Delete message"
                message="Delete this message from your chat view?"
                confirmLabel="Delete"
                danger
                onCancel={cancelMessageDeletion}
                onConfirm={confirmMessageDeletion}
            />

            <ConfirmModal
                isOpen={isResetConfirmOpen}
                title="Reset chat session"
                message="Reset this chat session? This clears the session history/transcript for the selected target."
                confirmLabel="Reset"
                danger
                onCancel={() => closeResetConfirmation(false)}
                onConfirm={() => closeResetConfirmation(true)}
            />
        </div>
    );
}
