import type {
    ListOpenClawCronInput,
    ListOpenClawCronRunsInput,
    OpenClawCronDelivery,
    OpenClawCronDeliveryPatch,
} from "../../../contracts/openClawCron.ts";

export type OpenClawCronProviderSchedule =
    | Readonly<{ at: string; kind: "at" }>
    | Readonly<{ anchorMs?: number; everyMs: number; kind: "every" }>
    | Readonly<{ expr: string; kind: "cron"; staggerMs?: number; tz?: string }>
    | Readonly<{ command: string; cwd?: string; kind: "on-exit" }>
    | Readonly<{
          batchMs?: number;
          command: readonly string[];
          cwd?: string;
          kind: "stream";
          match?: string;
          maxBatchBytes?: number;
          mode?: "line" | "match";
      }>;

export type OpenClawCronProviderPayload =
    | Readonly<{ kind: "systemEvent"; text: string }>
    | Readonly<{
          kind: "agentTurn";
          lightContext?: boolean;
          message: string;
          model?: string;
          thinking?: string;
          timeoutSeconds?: number;
      }>
    | Readonly<{ argv: readonly string[]; kind: "command" }>
    | Readonly<{ kind: "script"; script: string }>
    | Readonly<{ kind: "heartbeat" }>;

export interface OpenClawCronProviderJob {
    readonly agentId?: string;
    readonly configRevision?: string;
    readonly createdAtMs: number;
    readonly delivery?: OpenClawCronDelivery;
    readonly description?: string;
    readonly enabled: boolean;
    readonly id: string;
    readonly name: string;
    readonly payload: OpenClawCronProviderPayload;
    readonly schedule: OpenClawCronProviderSchedule;
    readonly scratch?: Readonly<{
        readonly content: string;
        readonly revision: number;
        readonly updatedAtMs?: number;
    }>;
    readonly sessionTarget: string;
    readonly state: Readonly<{
        consecutiveErrors?: number;
        lastDeliveryStatus?: "delivered" | "not-delivered" | "not-requested" | "unknown";
        lastDurationMs?: number;
        lastErrorReason?:
            | "auth"
            | "auth_permanent"
            | "billing"
            | "context_overflow"
            | "empty_response"
            | "format"
            | "model_not_found"
            | "no_error_details"
            | "overloaded"
            | "rate_limit"
            | "server_error"
            | "session_expired"
            | "timeout"
            | "unclassified"
            | "unknown";
        lastRunAtMs?: number;
        lastRunStatus?: "error" | "ok" | "skipped";
        nextRunAtMs?: number;
        runningAtMs?: number;
        streamStatus?:
            | "disabled"
            | "error"
            | "restarting"
            | "running"
            | "starting"
            | "stopped";
    }>;
    readonly updatedAtMs: number;
    readonly wakeMode: "next-heartbeat" | "now";
}

export interface OpenClawCronProviderListPage {
    readonly hasMore: boolean;
    readonly jobs: readonly OpenClawCronProviderJob[];
    readonly limit: number;
    readonly nextOffset: number | null;
    readonly offset: number;
    /** Encoded bytes of the authenticated raw response frame before projection strips fields. */
    readonly responseBytes: number;
    readonly snapshotRevision: string;
    readonly total: number;
}

export interface OpenClawCronProviderRunEntry {
    readonly deliveryStatus?: "delivered" | "not-delivered" | "not-requested" | "unknown";
    readonly durationMs?: number;
    readonly errorReason?: OpenClawCronProviderJob["state"]["lastErrorReason"];
    readonly jobId: string;
    readonly model?: string;
    readonly provider?: string;
    readonly runAtMs?: number;
    readonly runId?: string;
    readonly status?: "error" | "ok" | "skipped";
    readonly summary?: string;
    readonly ts: number;
    readonly usage?: Readonly<{
        cache_read_tokens?: number;
        cache_write_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    }>;
}

export interface OpenClawCronProviderRunPage {
    readonly entries: readonly OpenClawCronProviderRunEntry[];
    readonly hasMore: boolean;
    readonly limit: number;
    readonly nextOffset: number | null;
    readonly offset: number;
    readonly total: number;
}

export type OpenClawCronProviderUpdatePatch = Readonly<{
    delivery?: OpenClawCronDeliveryPatch;
    description?: string | null;
    enabled?: boolean;
    name?: string;
    payload?:
        | Readonly<{ kind: "systemEvent"; text: string }>
        | Readonly<{
              kind: "agentTurn";
              lightContext?: boolean;
              message: string;
              model?: string | null;
              thinking?: string | null;
              timeoutSeconds?: number;
          }>;
    schedule?: Extract<OpenClawCronProviderSchedule, { kind: "at" | "cron" | "every" }>;
    wakeMode?: "next-heartbeat" | "now";
}>;

export type OpenClawCronProviderErrorKind =
    | "conflict"
    | "invalid-data"
    | "not-found"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized provider-boundary failure; raw Gateway error text never crosses the domain. */
export class OpenClawCronProviderError extends Error {
    readonly kind: OpenClawCronProviderErrorKind;

    constructor(kind: OpenClawCronProviderErrorKind, options?: ErrorOptions) {
        super(`OpenClaw cron provider ${kind}`, options);
        this.name = "OpenClawCronProviderError";
        this.kind = kind;
    }
}

export function isOpenClawCronProviderError(
    error: unknown
): error is OpenClawCronProviderError {
    return error instanceof OpenClawCronProviderError;
}

/** Typed high-level seam implemented later by the process-owned Gateway client. */
export interface OpenClawCronProvider {
    currentProcessInstanceId(): string | undefined;
    get(
        input: Readonly<{ id: string; signal?: AbortSignal }>
    ): Promise<OpenClawCronProviderJob | undefined>;
    list(
        input: ListOpenClawCronInput &
            Readonly<{
                /** Full rows are required; Gateway compact rows omit schedule/payload/state. */
                compact: false;
                includeDeliveryPreviews: false;
                signal?: AbortSignal;
            }>
    ): Promise<OpenClawCronProviderListPage>;
    listRuns(
        input: ListOpenClawCronRunsInput & Readonly<{ signal?: AbortSignal }>
    ): Promise<OpenClawCronProviderRunPage>;
    remove(
        input: Readonly<{ id: string; signal?: AbortSignal }>
    ): Promise<Readonly<{ removed: boolean }>>;
    run(
        input: Readonly<{
            expectedProcessInstanceId: string;
            id: string;
            mode: "force";
            signal?: AbortSignal;
        }>
    ): Promise<
        Readonly<{
            processInstanceId: string;
            ran: boolean;
            reason?: "already-running" | "invalid-spec" | "not-due";
        }>
    >;
    setScratch(
        input: Readonly<{
            content: string;
            expectedRevision: number;
            id: string;
            signal?: AbortSignal;
        }>
    ): Promise<Readonly<{ revision: number }>>;
    update(
        input: Readonly<{
            expectedConfigRevision: string;
            id: string;
            patch: OpenClawCronProviderUpdatePatch;
            signal?: AbortSignal;
        }>
    ): Promise<OpenClawCronProviderJob>;
}
