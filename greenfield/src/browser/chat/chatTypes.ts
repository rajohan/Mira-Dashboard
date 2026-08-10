/** Browser-owned connection presentation for the selected OpenClaw chat session. */
export type ChatConnectionState = "connected" | "disconnected" | "reconnecting" | "stale";

/** One option in the URL-addressable session picker. */
export interface ChatSessionOption {
    readonly activeRunCount: number;
    readonly contextTokens?: number;
    readonly displayName: string;
    readonly fastMode?: boolean | "auto";
    readonly isDefault: boolean;
    readonly key: string;
    readonly model?: string;
    readonly modelOptions: readonly string[];
    readonly speed: "fast" | "standard";
    readonly thinking: string;
    readonly thinkingOptions: readonly string[];
    readonly totalTokens?: number;
    readonly totalTokensFresh: boolean;
    readonly updatedAtMs?: number;
}

/** Prepared attachment retained by the composer until a send is acknowledged. */
export interface ChatDraftAttachment {
    readonly error?: string;
    readonly file: File;
    readonly id: string;
    readonly mediaType: string;
    readonly name: string;
    readonly progress: number;
    readonly reference?: string;
    readonly sizeBytes: number;
    readonly status: "error" | "preparing" | "ready" | "uploading";
}

/** File-free attachment metadata safe for retention in the runtime store. */
export interface ChatOptimisticAttachment {
    readonly id: string;
    readonly mediaType: string;
    readonly name: string;
    readonly progress: number;
    readonly sizeBytes: number;
    readonly status: ChatDraftAttachment["status"];
}

/** Attachment rendered from canonical history or an optimistic send. */
export interface ChatMessageAttachment {
    readonly downloadUrl?: string;
    readonly id: string;
    readonly mediaType: string;
    readonly name: string;
    readonly previewUrl?: string;
    readonly progress?: number;
    readonly renderPolicy?: "bounded-text" | "download-only" | "inline-image";
    readonly sizeBytes: number;
    readonly status?: ChatDraftAttachment["status"];
}

/** Ordered assistant prose inside one canonical message or active run. */
export interface ChatTextPart {
    readonly kind: "text";
    readonly text: string;
}

/** Ordered, optionally streaming reasoning inside one active assistant run. */
export interface ChatThinkingPart {
    readonly kind: "thinking";
    readonly status: "complete" | "running";
    readonly text: string;
}

/** Ordered tool activity with explicit accessible lifecycle state. */
export interface ChatToolPart {
    readonly callId: string;
    readonly callIdSource?: "synthetic";
    readonly error?: string;
    readonly input?: unknown;
    readonly kind: "tool";
    readonly name: string;
    readonly nameSource?: "synthetic";
    readonly output?: unknown;
    readonly status: "completed" | "failed" | "running";
}

/** Ordered provider status/control information retained beside run content. */
export interface ChatControlPart {
    readonly kind: "control";
    readonly text: string;
    readonly tone: "danger" | "muted" | "warning";
}

export type ChatMessagePart =
    | ChatControlPart
    | ChatTextPart
    | ChatThinkingPart
    | ChatToolPart;

/** Fully hydrated display message independent of provider transcript variants. */
export interface ChatDisplayMessage {
    readonly attachments: readonly ChatMessageAttachment[];
    readonly clientRunId?: string;
    readonly delivery?:
        | "accepted"
        | "failed"
        | "queued"
        | "reconciling"
        | "sending"
        | "sent";
    readonly id: string;
    readonly idempotencyKey?: string;
    readonly hydration?: "error" | "loading" | "required";
    readonly parts: readonly ChatMessagePart[];
    readonly providerRunId?: string;
    readonly role: "assistant" | "control" | "user";
    readonly runId?: string;
    readonly sequence: number;
    readonly sessionKey: string;
    readonly timestampMs?: number;
}

/** One immutable older-history page, returned newest-first by the server. */
export interface ChatHistoryPageView {
    readonly messages: readonly ChatDisplayMessage[];
    readonly nextCursor?: string;
    readonly observedAtMs: number;
}

/** Per-session display controls that do not mutate the provider transcript. */
export interface ChatDisplaySettings {
    readonly keepThinkingAfterFinal: boolean;
    readonly showThinking: boolean;
    readonly showTools: boolean;
    readonly toolsExpanded: boolean;
}

/** Mutable provider preferences used by subsequent sends. */
export interface ChatSendSettings {
    readonly fastMode?: boolean | "auto";
    readonly model?: string;
    readonly speed: "fast" | "standard";
    readonly thinking?: string;
}

/** Browser-side microphone/STT lifecycle projected into the pure chat surface. */
export interface ChatVoiceInputView {
    readonly available: boolean;
    readonly elapsedMs: number;
    readonly error?: string;
    readonly phase: "idle" | "recording" | "transcribing";
}

/** Shared, single-playback TTS lifecycle projected into message bubbles. */
export interface ChatReadAloudView {
    readonly activeMessageId?: string;
    readonly error?: string;
    readonly errorMessageId?: string;
    readonly phase: "idle" | "loading" | "playing";
}

/** One ephemeral plan row; plans intentionally disappear when the run settles. */
export interface ChatPlanItemView {
    readonly id: string;
    readonly label: string;
    readonly status: "completed" | "in-progress" | "pending";
}

export interface ChatActivePlanView {
    readonly items: readonly ChatPlanItemView[];
    readonly runId: string;
    readonly title: string;
}

/** Read-only background task summary associated with a chat session. */
export interface ChatBackgroundTaskView {
    readonly detail?: string;
    readonly id: string;
    readonly label: string;
    readonly status:
        | "cancelled"
        | "completed"
        | "failed"
        | "queued"
        | "running"
        | "timed_out";
    readonly summary?: string;
    readonly updatedAtMs?: number;
}

/** Companion question state is intentionally separate from the transcript. */
export interface ChatCompanionView {
    readonly answer?: string;
    readonly error?: string;
    readonly question?: string;
    readonly status: "answering" | "error" | "idle" | "ready" | "resetting";
}

/** Snapshot accepted by the pure chat surface and its Storybook fixtures. */
export interface ChatWorkspaceView {
    readonly activePlans: readonly ChatActivePlanView[];
    readonly backgroundTasks: readonly ChatBackgroundTaskView[];
    readonly backgroundTasksError?: string;
    readonly backgroundTasksHasNextPage: boolean;
    readonly backgroundTasksLoading: boolean;
    readonly backgroundTasksLoadingMore: boolean;
    readonly backgroundTasksWindowLimited?: boolean;
    readonly companion: ChatCompanionView;
    readonly companionError?: string;
    readonly connection: ChatConnectionState;
    readonly historyHasNextPage: boolean;
    readonly historyInitialLoading: boolean;
    readonly historyLoading: boolean;
    readonly historyWindowLimited?: boolean;
    readonly messages: readonly ChatDisplayMessage[];
    readonly modelInventoryError?: string;
    readonly selectedSessionKey: string;
    readonly sessionsLoading: boolean;
    readonly sessions: readonly ChatSessionOption[];
    readonly taskDetailError?: string;
}
