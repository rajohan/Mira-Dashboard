import type {
    ChatCompanionAskInput,
    ChatCompanionAskOutput,
    ChatCompanionResetInput,
    ChatCompanionResetOutput,
    ChatCompanionStateInput,
    ChatCompanionStateOutput,
    ChatMessage,
    ChatMessageGetOutput,
    ChatModelsListOutput,
    ChatSessionSettingsInput,
    ChatSessionSettingsOutput,
} from "../../../contracts/chat.ts";
import type {
    ChatAttachmentTicketPrepareInput,
    ChatAttachmentTicketPrepareOutput,
} from "../../../contracts/chatMedia.ts";
import type { ChatPlanStep } from "../../../contracts/chatModel.ts";

export interface ChatProviderHistoryRequest {
    readonly limit: number;
    readonly maxChars: number;
    readonly offset: number;
    readonly sessionKey: string;
}

export interface ChatProviderHistoryPage {
    readonly hasMore: boolean;
    readonly inFlightRun?: ChatProviderInFlightRun;
    readonly messages: readonly ChatMessage[];
    readonly nextOffset?: number;
    readonly sessionId?: string;
}

/** Audited chat.history snapshot for the newest selected visible active run. */
export interface ChatProviderInFlightRun {
    readonly plan?: Readonly<{ readonly steps: readonly ChatPlanStep[] }>;
    readonly runId: string;
    readonly text: string;
}

export interface ChatProviderMessageRequest {
    readonly maxChars: number;
    readonly messageId: string;
    readonly sessionKey: string;
}

export interface ChatProviderAttachment {
    readonly content: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes?: number;
    readonly type: "file";
}

export interface ChatProviderSendRequest {
    readonly attachments: readonly ChatProviderAttachment[];
    readonly fastMode?: boolean | "auto";
    readonly idempotencyKey: string;
    readonly message: string;
    readonly queueMode?: "collect" | "followup" | "interrupt" | "steer";
    readonly sessionKey: string;
    readonly thinking?: string;
}

export interface ChatProviderSendAcknowledgement {
    readonly runId: string;
    readonly status: "in_flight" | "ok" | "started";
}

export type ChatAttachmentTicketErrorReason =
    | "capacity"
    | "conflict"
    | "expired"
    | "forbidden"
    | "invalid"
    | "not-found"
    | "not-ready"
    | "unavailable";

/** Adapter-independent attachment-ticket failure exposed by the domain port. */
export class ChatAttachmentTicketError extends Error {
    public readonly reason: ChatAttachmentTicketErrorReason;

    public constructor(reason: ChatAttachmentTicketErrorReason) {
        super(`Chat attachment ticket operation failed: ${reason}`);
        this.name = "ChatAttachmentTicketError";
        this.reason = reason;
    }
}

export interface ChatProviderAbortRequest {
    readonly preserveSideRuns: false;
    readonly providerRunId?: string;
    readonly sessionKey: string;
}

export interface ChatProviderAbortAcknowledgement {
    readonly aborted: boolean;
    readonly ok: boolean;
    readonly runIds: readonly string[];
}

export type ChatProviderEvent =
    | Readonly<{
          kind: "delta";
          mode: "append" | "merge" | "replace";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
          stream: "assistant" | "thinking";
          text: string;
      }>
    | Readonly<{
          callId: string;
          callIdSource?: "synthetic";
          input?: string;
          isError: boolean;
          kind: "tool";
          name: string;
          nameSource?: "synthetic";
          output?: string;
          phase: "failed" | "running" | "started" | "succeeded";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
      }>
    | Readonly<{
          itemId: string;
          itemType: string;
          kind: "item";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
          text?: string;
      }>
    | Readonly<{
          kind: "status";
          phase:
              | "preparing-context"
              | "preparing-workspace"
              | "provisioning-environment"
              | "starting-model";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
      }>
    | Readonly<{
          kind: "plan";
          phase: "update";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
          steps: readonly ChatPlanStep[];
      }>
    | Readonly<{
          errorCode?: string;
          errorMessage?: string;
          kind: "terminal";
          outcome: "aborted" | "completed" | "error";
          providerRunId: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
          stopReason?: string;
      }>
    | Readonly<{
          idempotencyKey: string;
          kind: "user-echo";
          providerRunId?: string;
          providerSequence: number;
          receivedAtMs: number;
          sessionKey: string;
      }>
    | Readonly<{
          kind: "noop";
          providerRunId: string;
          providerSequence: number;
          reason: "ignored";
          receivedAtMs: number;
          sessionKey: string;
      }>;

export interface ChatEventSubscription {
    readonly close: () => Promise<void>;
}

export interface ChatEventSubscriptionRequest {
    readonly agentId?: string;
    readonly onEvent: (event: ChatProviderEvent) => void | Promise<void>;
    readonly onGap: (gap: ChatProviderEventGap) => void | Promise<void>;
    readonly onReconciliationRequired: (
        reason: ChatProviderReconciliationReason
    ) => void | Promise<void>;
    readonly runWatermarks: readonly ChatProviderRunWatermark[];
    readonly sessionKey: string;
}

export interface ChatProviderRunWatermark {
    readonly lastProviderSequence: number;
    readonly providerRunId: string;
}

export interface ChatProviderEventGap {
    readonly expectedSequence: number;
    readonly providerRunId: string;
    readonly receivedSequence: number;
    readonly sessionKey: string;
}

export type ChatProviderReconciliationReason =
    | "backpressure"
    | "subscription"
    | "transport";

/**
 * Private validated chat lane. Implementations must not forward these payloads to
 * the generic payload-free Gateway invalidation listener.
 */
export interface ChatEventProvider {
    readonly subscribeChat: (
        request: ChatEventSubscriptionRequest,
        signal?: AbortSignal
    ) => Promise<ChatEventSubscription>;
}

/** Narrow high-level Gateway authority consumed by the chat domain. */
export interface ChatProvider extends ChatEventProvider {
    readonly abort: (
        request: ChatProviderAbortRequest,
        signal?: AbortSignal
    ) => Promise<ChatProviderAbortAcknowledgement>;
    readonly companionAsk: (
        input: ChatCompanionAskInput,
        signal?: AbortSignal
    ) => Promise<ChatCompanionAskOutput>;
    readonly companionReset: (
        input: ChatCompanionResetInput,
        signal?: AbortSignal
    ) => Promise<ChatCompanionResetOutput>;
    readonly companionState: (
        input: ChatCompanionStateInput,
        signal?: AbortSignal
    ) => Promise<ChatCompanionStateOutput>;
    readonly getMessage: (
        request: ChatProviderMessageRequest,
        signal?: AbortSignal
    ) => Promise<ChatMessageGetOutput>;
    readonly history: (
        request: ChatProviderHistoryRequest,
        signal?: AbortSignal
    ) => Promise<ChatProviderHistoryPage>;
    readonly listModels: (
        request: Readonly<{
            includeProviderCapabilities: true;
            view: "configured";
        }>,
        signal?: AbortSignal
    ) => Promise<ChatModelsListOutput>;
    readonly send: (
        request: ChatProviderSendRequest,
        signal?: AbortSignal
    ) => Promise<ChatProviderSendAcknowledgement>;
    readonly updateSessionSettings: (
        input: ChatSessionSettingsInput,
        signal?: AbortSignal
    ) => Promise<ChatSessionSettingsOutput>;
}

/**
 * Replay-safe reservation acquired only after durable admission. Commit/release
 * must be idempotent; the provider payload remains immutable while reserved.
 * Once dispatch is attempted, unknown outcomes consume rather than reopen it.
 */
export interface ChatAttachmentTicketReservation {
    readonly attachments: readonly ChatProviderAttachment[];
    readonly commit: (signal?: AbortSignal) => Promise<void>;
    readonly release: (signal?: AbortSignal) => Promise<void>;
}

/** Exact actor/session/idempotency-bound attachment reservation authority. */
export interface ChatAttachmentTicketConsumer {
    readonly reserve: (
        request: Readonly<{
            actorId: string;
            idempotencyKey: string;
            sessionKey: string;
            ticketId: string;
        }>,
        signal?: AbortSignal
    ) => Promise<ChatAttachmentTicketReservation>;
}

/** Session-bound reservation port implemented by the raw attachment-ticket adapter. */
export interface ChatAttachmentTicketPreparer {
    readonly prepare: (
        input: ChatAttachmentTicketPrepareInput,
        actorId: string,
        signal?: AbortSignal
    ) => Promise<ChatAttachmentTicketPrepareOutput>;
}

/** The RPC was dispatched, but its acknowledgement cannot be established. */
export class ChatProviderUnknownOutcomeError extends Error {
    public constructor() {
        super("Chat provider operation outcome is unknown");
        this.name = "ChatProviderUnknownOutcomeError";
    }
}

/** Safe typed transport, deadline, or upstream validation failure. */
export class ChatProviderUnavailableError extends Error {
    public constructor() {
        super("Chat provider is unavailable");
        this.name = "ChatProviderUnavailableError";
    }
}

/** Sanitized retryable provider admission rejection such as SESSION_COMPANION_BUSY. */
export class ChatProviderCapacityError extends Error {
    public constructor() {
        super("Chat provider capacity is temporarily full");
        this.name = "ChatProviderCapacityError";
    }
}

export class ChatProviderNotFoundError extends Error {
    public constructor() {
        super("Chat provider resource was not found");
        this.name = "ChatProviderNotFoundError";
    }
}

export class ChatProviderConflictError extends Error {
    public constructor() {
        super("Chat provider state changed");
        this.name = "ChatProviderConflictError";
    }
}
