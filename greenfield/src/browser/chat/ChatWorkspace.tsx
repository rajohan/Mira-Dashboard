import {
    Bot,
    Brain,
    Cpu,
    Database,
    Gauge,
    ListChecks,
    MessagesSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { chatModelDisplayName } from "./chatModelPresentation.ts";
import {
    chatAgentIdFromSessionKey,
    chatAgentOptions,
    chatSessionLabelForAgent,
    chatSessionsForAgent,
} from "./chatSessionPicker.ts";
import { chatSessionTokenPresentation } from "./chatSessionTokenPresentation.ts";
import { ChatSettingsPanel } from "./ChatSettingsPanel.tsx";
import { ChatSidePanel } from "./ChatSidePanel.tsx";
import { ChatTranscript } from "./ChatTranscript.tsx";
import type {
    ChatDisplaySettings,
    ChatDraftAttachment,
    ChatReadAloudView,
    ChatSendSettings,
    ChatVoiceInputView,
    ChatWorkspaceView,
} from "./chatTypes.ts";

interface ChatWorkspaceProps {
    readonly activeRunIds?: readonly string[];
    readonly abortableRunId?: string;
    readonly actionBusy?: boolean;
    readonly attachmentError?: string;
    readonly attachments: readonly ChatDraftAttachment[];
    readonly canSend: boolean;
    readonly canAskCompanion?: boolean;
    readonly displaySettings: ChatDisplaySettings;
    readonly draft: string;
    readonly error?: string;
    readonly notice?: string;
    readonly providerWritesDisabled?: boolean;
    readonly onAbort: (runId: string) => void;
    readonly onAskCompanion: (question: string) => void;
    readonly onAttach: (files: FileList) => void;
    readonly onCancelTask: (taskId: string) => void;
    readonly onCancelVoiceInput?: () => void;
    readonly onChangeDraft: (draft: string) => void;
    readonly onCompact: () => void;
    readonly onDisplaySettingsChange: (settings: ChatDisplaySettings) => void;
    readonly onDismissReadAloudError?: () => void;
    readonly onDismissVoiceInputError?: () => void;
    readonly onHydrateMessage: (messageId: string) => void;
    readonly onLoadMoreTasks: () => void;
    readonly onLoadOlder: () => boolean | Promise<boolean>;
    readonly onOpenLocalFile?: (reference: string) => void;
    readonly onReadAloud?: (messageId: string, text: string) => void;
    readonly onRemoveAttachment: (id: string) => void;
    readonly onResetCompanion: () => void;
    readonly onResetTranscript: (sessionKey: string) => void;
    readonly onRetryCompanion?: () => void;
    readonly onRetryModels?: () => void;
    readonly onRetryTasks?: () => void;
    readonly onRetry?: () => void;
    readonly onSelectSession: (sessionKey: string) => void;
    readonly onSelectTask: (taskId?: string) => void;
    readonly onSend: () => void;
    readonly onSendSettingsChange: (settings: ChatSendSettings) => void;
    readonly onStartVoiceInput?: () => void;
    readonly onStopVoiceInput?: () => void;
    readonly onStopReadAloud?: () => void;
    readonly readAloud?: ChatReadAloudView;
    readonly sendSettings: ChatSendSettings;
    readonly selectedTaskId?: string;
    readonly taskCancelGatedIds?: readonly string[];
    readonly view: ChatWorkspaceView;
    readonly voiceInput?: ChatVoiceInputView;
}

function DismissibleChatStatus({
    errorPresent,
    message,
}: Readonly<{
    errorPresent: boolean;
    message: string;
}>) {
    const [dismissed, setDismissed] = useState(false);

    if (dismissed) return null;
    return (
        <div className="shrink-0 p-3 sm:p-4" data-testid="chat-composer-status">
            <Alert
                dismissLabel="Dismiss chat status"
                focusOnError={false}
                message={message}
                onDismiss={() => setDismissed(true)}
                variant={errorPresent ? "error" : "info"}
            />
        </div>
    );
}

function chatConnectionStatusMessage(
    connection: ChatWorkspaceView["connection"]
): string | undefined {
    if (connection === "stale") {
        return "Showing the latest saved history. Sending is paused until the connection catches up.";
    }
    if (connection === "disconnected") {
        return "Live chat is unavailable. Drafts and prepared attachments stay in this browser while the connection recovers.";
    }
    return undefined;
}

/**
 * Pure complete chat surface used by production composition and Storybook.
 * @returns Complete chat workspace for the supplied immutable view.
 */
export function ChatWorkspace({
    activeRunIds,
    abortableRunId,
    actionBusy = false,
    attachmentError,
    attachments,
    canSend,
    canAskCompanion,
    displaySettings,
    draft,
    error,
    notice,
    providerWritesDisabled = false,
    onAbort,
    onAskCompanion,
    onAttach,
    onCancelTask,
    onCancelVoiceInput,
    onChangeDraft,
    onCompact,
    onDisplaySettingsChange,
    onDismissReadAloudError,
    onDismissVoiceInputError,
    onHydrateMessage,
    onLoadMoreTasks,
    onLoadOlder,
    onOpenLocalFile,
    onReadAloud,
    onRemoveAttachment,
    onResetCompanion,
    onResetTranscript,
    onRetryCompanion,
    onRetryModels,
    onRetryTasks,
    onRetry,
    onSelectSession,
    onSelectTask,
    onSend,
    onSendSettingsChange,
    onStartVoiceInput,
    onStopVoiceInput,
    onStopReadAloud,
    readAloud,
    sendSettings,
    selectedTaskId,
    taskCancelGatedIds = [],
    view,
    voiceInput,
}: ChatWorkspaceProps) {
    const [resetTarget, setResetTarget] = useState<string>();
    const [activityOpen, setActivityOpen] = useState(false);
    const activityCloseButton = useRef<HTMLButtonElement>(null);
    const activityTrigger = useRef<HTMLButtonElement>(null);
    const activityWasToggled = useRef(false);
    const selectedSession = view.sessions.find(
        (session) => session.key === view.selectedSessionKey
    );
    const selectedAgentId = chatAgentIdFromSessionKey(view.selectedSessionKey);
    const agentOptions = chatAgentOptions(view.sessions);
    const sessionsForAgent = chatSessionsForAgent(view.sessions, selectedAgentId);
    const tokenPresentation =
        selectedSession === undefined
            ? undefined
            : chatSessionTokenPresentation(selectedSession);
    const providerControlsDisabled = actionBusy || providerWritesDisabled;
    const connectionStatusMessage = chatConnectionStatusMessage(view.connection);
    const statusMessage = error ?? connectionStatusMessage ?? "";
    const statusKey = `${view.connection}\u0000${error ?? ""}`;

    useEffect(() => {
        if (!activityWasToggled.current) return;
        const frame = requestAnimationFrame(() => {
            if (activityOpen) activityCloseButton.current?.focus();
            else activityTrigger.current?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [activityOpen]);
    if (selectedSession === undefined) {
        if (view.sessionsLoading) {
            return <PageState label="Loading OpenClaw chat sessions…" status="loading" />;
        }
        if (error !== undefined) {
            return (
                <PageState
                    message={error}
                    onRetry={onRetry}
                    retryBusy={actionBusy}
                    status="error"
                    title="Chat unavailable"
                />
            );
        }
        return (
            <Card className="flex h-full min-h-96 flex-col items-center justify-center text-center">
                <Icon icon={MessagesSquare} size="xl" />
                <Heading className="mt-3" level={1} size="panel">
                    No chat sessions
                </Heading>
                <Text className="mt-2" tone="muted">
                    OpenClaw has not created a chat session yet.
                </Text>
            </Card>
        );
    }
    return (
        <Card
            className="relative flex h-full min-h-0 flex-col overflow-hidden p-0"
            data-connection={view.connection}
            data-testid="chat-workspace"
        >
            <header className="border-primary-700 border-b p-2 sm:p-3">
                <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                    <div
                        aria-label="Selected response settings"
                        className="flex min-w-0 flex-wrap items-center gap-1"
                    >
                        <div className="flex min-w-0 flex-nowrap items-center gap-1">
                            <Badge
                                aria-label={`Model: ${selectedSession.model ?? "Unknown model"}`}
                                className="max-w-36 min-w-0 sm:max-w-56"
                                title={selectedSession.model ?? "Unknown model"}
                                variant="default"
                            >
                                <Icon icon={Cpu} size="sm" tone="inherit" />
                                <span className="min-w-0 truncate">
                                    {chatModelDisplayName(selectedSession.model)}
                                </span>
                            </Badge>
                            <Badge title="Thinking" variant="default">
                                <Icon icon={Brain} size="sm" tone="inherit" />
                                {selectedSession.thinking}
                            </Badge>
                            <Badge title="Speed" variant="default">
                                <Icon icon={Gauge} size="sm" tone="inherit" />
                                {selectedSession.speed}
                            </Badge>
                        </div>
                        <Badge
                            aria-label={tokenPresentation?.accessibleLabel}
                            title={tokenPresentation?.accessibleLabel}
                            variant="default"
                        >
                            <Icon icon={Database} size="sm" tone="inherit" />
                            {tokenPresentation?.compactLabel}
                        </Badge>
                    </div>
                    <div
                        className={`grid w-full min-w-0 gap-1.5 lg:ml-auto lg:w-[min(34rem,52vw)] ${
                            activityOpen
                                ? "grid-cols-2"
                                : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                        }`}
                    >
                        <div className="min-w-0">
                            <Select
                                ariaLabel="Agent"
                                className="gap-2"
                                onChange={(agentId) => {
                                    if (agentId === selectedAgentId) return;
                                    const nextSession = chatSessionsForAgent(
                                        view.sessions,
                                        agentId
                                    )[0];
                                    if (nextSession !== undefined) {
                                        onSelectSession(nextSession.key);
                                    }
                                }}
                                options={agentOptions.map((agent) => ({
                                    ...agent,
                                    label: (
                                        <span className="flex min-w-0 items-center gap-2">
                                            <Icon icon={Bot} size="sm" tone="inherit" />
                                            <span className="truncate">
                                                {agent.label}
                                            </span>
                                        </span>
                                    ),
                                }))}
                                value={selectedAgentId}
                            />
                        </div>
                        <div className="min-w-0">
                            <Select
                                ariaLabel="Session"
                                onChange={onSelectSession}
                                options={sessionsForAgent.map((session) => ({
                                    description: [
                                        chatModelDisplayName(session.model),
                                        session.activeRunCount === 0
                                            ? undefined
                                            : `${session.activeRunCount} active`,
                                    ]
                                        .filter(Boolean)
                                        .join(" · "),
                                    label: (
                                        <span className="flex min-w-0 items-center gap-2">
                                            <Icon
                                                icon={MessagesSquare}
                                                size="sm"
                                                tone="inherit"
                                            />
                                            <span className="truncate">
                                                {chatSessionLabelForAgent(
                                                    session,
                                                    selectedAgentId
                                                )}
                                            </span>
                                        </span>
                                    ),
                                    value: session.key,
                                }))}
                                value={view.selectedSessionKey}
                            />
                        </div>
                        {!activityOpen && (
                            <IconOnlyButton
                                aria-controls="chat-activity-panel"
                                aria-expanded={false}
                                className="focus-visible:ring-accent-400 h-10 min-h-10 min-w-10 flex-none justify-center px-0 focus-visible:ring-1 focus-visible:ring-offset-0"
                                icon={ListChecks}
                                label="Open activity panel"
                                onClick={() => {
                                    activityWasToggled.current = true;
                                    setActivityOpen(true);
                                }}
                                ref={activityTrigger}
                                size="sm"
                                title="Open activity & tasks"
                                variant="ghost"
                            />
                        )}
                    </div>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <div
                    className={`min-h-0 min-w-0 flex-1 flex-col p-2 sm:p-3 ${
                        activityOpen ? "hidden lg:flex" : "flex"
                    }`}
                    data-testid="chat-main-pane"
                >
                    <div
                        className="relative flex min-h-0 min-w-0 flex-1"
                        data-testid="chat-transcript-pane"
                    >
                        <ChatTranscript
                            activeRunIds={
                                activeRunIds ??
                                (abortableRunId === undefined ? [] : [abortableRunId])
                            }
                            display={displaySettings}
                            hasOlder={view.historyHasNextPage}
                            initialLoading={view.historyInitialLoading}
                            messages={view.messages}
                            onHydrateMessage={onHydrateMessage}
                            onLoadOlder={onLoadOlder}
                            onOpenLocalFile={onOpenLocalFile}
                            onDismissReadAloudError={onDismissReadAloudError}
                            onReadAloud={onReadAloud}
                            onStopReadAloud={onStopReadAloud}
                            readAloud={readAloud}
                            sessionKey={view.selectedSessionKey}
                        />
                    </div>
                    {statusMessage !== "" && (
                        <DismissibleChatStatus
                            errorPresent={error !== undefined}
                            key={statusKey}
                            message={statusMessage}
                        />
                    )}
                    <ChatComposer
                        abortableRunId={abortableRunId}
                        attachmentError={attachmentError}
                        attachments={attachments}
                        canSend={canSend}
                        disabled={view.connection !== "connected"}
                        draft={draft}
                        modelOptions={selectedSession.modelOptions}
                        notice={notice}
                        onAbort={onAbort}
                        onAttach={onAttach}
                        onCancelVoiceInput={onCancelVoiceInput}
                        onChangeDraft={onChangeDraft}
                        onDismissVoiceInputError={onDismissVoiceInputError}
                        onRemoveAttachment={onRemoveAttachment}
                        onSend={onSend}
                        onStartVoiceInput={onStartVoiceInput}
                        onStopVoiceInput={onStopVoiceInput}
                        settingsControl={
                            <ChatSettingsPanel
                                busy={providerControlsDisabled}
                                display={displaySettings}
                                modelInventoryError={view.modelInventoryError}
                                onCompact={onCompact}
                                onDisplayChange={onDisplaySettingsChange}
                                onRetryModels={onRetryModels}
                                onReset={() => setResetTarget(view.selectedSessionKey)}
                                onSendSettingsChange={onSendSettingsChange}
                                send={sendSettings}
                                session={selectedSession}
                            />
                        }
                        thinkingOptions={selectedSession.thinkingOptions}
                        voiceInput={voiceInput}
                    />
                </div>
                {activityOpen && (
                    <Button
                        aria-label="Close activity panel backdrop"
                        className="fixed inset-0 z-60 bg-black/65 backdrop-blur-sm lg:hidden"
                        onClick={() => {
                            activityWasToggled.current = true;
                            setActivityOpen(false);
                        }}
                        variant="unstyled"
                    >
                        <span className="sr-only">Close activity panel backdrop</span>
                    </Button>
                )}
                <ChatSidePanel
                    canAskCompanion={canAskCompanion ?? abortableRunId !== undefined}
                    className={`border-primary-700 fixed inset-2 z-70 rounded-xl border lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:rounded-none lg:border-y-0 lg:border-r-0 ${
                        activityOpen ? "flex" : "hidden"
                    }`}
                    closeButtonRef={activityCloseButton}
                    companion={view.companion}
                    drawerOpen={activityOpen}
                    onAskCompanion={onAskCompanion}
                    onCancelTask={onCancelTask}
                    onClose={() => {
                        activityWasToggled.current = true;
                        setActivityOpen(false);
                    }}
                    onLoadMoreTasks={onLoadMoreTasks}
                    onResetCompanion={onResetCompanion}
                    onRetryCompanion={onRetryCompanion}
                    onRetryTasks={onRetryTasks}
                    onSelectTask={onSelectTask}
                    plans={view.activePlans}
                    providerWritesDisabled={providerControlsDisabled}
                    selectedTaskId={selectedTaskId}
                    sessionKey={view.selectedSessionKey}
                    taskCancelGatedIds={taskCancelGatedIds}
                    tasks={view.backgroundTasks}
                    tasksHasNextPage={view.backgroundTasksHasNextPage}
                    tasksLoading={view.backgroundTasksLoading}
                    tasksLoadingMore={view.backgroundTasksLoadingMore}
                    companionError={view.companionError}
                    id="chat-activity-panel"
                    taskDetailError={view.taskDetailError}
                    tasksError={view.backgroundTasksError}
                />
            </div>
            <ConfirmModal
                busy={providerControlsDisabled}
                confirmLabel="Reset chat history"
                danger
                description="This permanently clears the entire selected OpenClaw chat history."
                onCancel={() => setResetTarget(undefined)}
                onConfirm={() => {
                    if (resetTarget !== undefined) onResetTranscript(resetTarget);
                    setResetTarget(undefined);
                }}
                open={resetTarget !== undefined}
                title="Reset this chat?"
            />
        </Card>
    );
}
