import * as v from "valibot";

import {
    type DeleteOpenClawCronInput,
    type DeleteOpenClawCronResult,
    type GetOpenClawCronInput,
    type GetOpenClawCronResult,
    type ListOpenClawCronInput,
    type ListOpenClawCronResult,
    type ListOpenClawCronRunsInput,
    type ListOpenClawCronRunsResult,
    type OpenClawCronLinkedTask,
    type RunOpenClawCronInput,
    type RunOpenClawCronResult,
    type SetOpenClawCronEnabledInput,
    type UpdateOpenClawCronInput,
    deleteOpenClawCronInputSchema,
    deleteOpenClawCronResultSchema,
    getOpenClawCronInputSchema,
    listOpenClawCronInputSchema,
    listOpenClawCronRunsInputSchema,
    openClawCronPageMaximum,
    openClawCronTimestampSchema,
    runOpenClawCronInputSchema,
    runOpenClawCronResultSchema,
    setOpenClawCronEnabledInputSchema,
    updateOpenClawCronInputSchema,
} from "../../../contracts/openClawCron.ts";
import type {
    OpenClawCronActiveDisableIntent,
    OpenClawCronIntentCreator,
    OpenClawCronIntentStore,
} from "./intentStore.ts";
import type {
    OpenClawCronAuditContext,
    OpenClawCronAuditOperation,
    OpenClawCronAuditSettlement,
    OpenClawCronOperationAuditWriter,
} from "./operationAudit.ts";
import { openClawCronAuditTargetFingerprint } from "./operationAudit.ts";
import {
    freshOpenClawCronSource,
    lastKnownGoodOpenClawCronSource,
    projectOpenClawCronGetResult,
    projectOpenClawCronHeartbeatJobSummary,
    projectOpenClawCronJob,
    projectOpenClawCronListResult,
    projectOpenClawCronRunsResult,
    type OpenClawCronHeartbeatJobSummary,
} from "./projection.ts";
import {
    type OpenClawCronProvider,
    type OpenClawCronProviderJob,
    type OpenClawCronProviderListPage,
    type OpenClawCronProviderRunPage,
    type OpenClawCronProviderUpdatePatch,
    isOpenClawCronProviderError,
} from "./provider.ts";

export type OpenClawCronServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "invalid-input"
    | "not-found"
    | "precondition-failed"
    | "provider-data-invalid"
    | "provider-unavailable"
    | "unknown-outcome";

type OpenClawCronTerminalAuditSettlement = Exclude<
    OpenClawCronAuditSettlement,
    "attempted"
>;

/** Stable domain failure ready for tRPC mapping without raw provider strings. */
export class OpenClawCronServiceError extends Error {
    readonly id?: string;
    readonly reason: OpenClawCronServiceErrorReason;

    constructor(
        reason: OpenClawCronServiceErrorReason,
        options?: ErrorOptions & { readonly id?: string }
    ) {
        super(`OpenClaw cron operation failed: ${reason}`, options);
        this.name = "OpenClawCronServiceError";
        this.reason = reason;
        this.id = options?.id;
    }
}

interface Observed<T> {
    readonly observedAtMs: number;
    readonly value: T;
}

export interface OpenClawCronServiceOptions {
    /** Test-only opt-out; production controls fail closed before dispatch without audit. */
    readonly auditRequired?: boolean;
    readonly auditWriter?: OpenClawCronOperationAuditWriter;
    readonly clock?: () => number;
    readonly expirySystemActorId?: string;
    readonly intentStore: OpenClawCronIntentStore;
    readonly linkedTaskReader?: OpenClawCronLinkedTaskReader;
    /** Monotonic process clock used only for refresh TTLs and retry admission. */
    readonly monotonicClock?: () => number;
    readonly onAuditSettlementFailure?: (failure: {
        readonly operation: OpenClawCronAuditOperation;
        readonly settlement: OpenClawCronTerminalAuditSettlement;
        readonly targetFingerprint: string;
    }) => void;
    readonly provider: OpenClawCronProvider;
}

export interface OpenClawCronLinkedTaskReference {
    readonly cronJobId: string;
    readonly task: OpenClawCronLinkedTask;
}

/** Bounded Dashboard-owned task projection used to enrich one provider page. */
export interface OpenClawCronLinkedTaskReader {
    readonly listOpenLinkedTasks: (
        cronJobIds: readonly string[]
    ) => readonly OpenClawCronLinkedTaskReference[];
}

export interface OpenClawCronService {
    readonly delete: (
        input: DeleteOpenClawCronInput,
        actor: OpenClawCronIntentCreator,
        signal?: AbortSignal,
        auditContext?: OpenClawCronAuditContext
    ) => Promise<DeleteOpenClawCronResult>;
    readonly get: (
        input: GetOpenClawCronInput,
        signal?: AbortSignal
    ) => Promise<GetOpenClawCronResult>;
    readonly list: (
        input: ListOpenClawCronInput,
        signal?: AbortSignal
    ) => Promise<ListOpenClawCronResult>;
    readonly listRuns: (
        input: ListOpenClawCronRunsInput,
        signal?: AbortSignal
    ) => Promise<ListOpenClawCronRunsResult>;
    readonly reconcileExpired: (
        input: GetOpenClawCronInput,
        signal?: AbortSignal
    ) => Promise<GetOpenClawCronResult>;
    readonly run: (
        input: RunOpenClawCronInput,
        signal?: AbortSignal,
        auditContext?: OpenClawCronAuditContext
    ) => Promise<RunOpenClawCronResult>;
    readonly setEnabled: (
        input: SetOpenClawCronEnabledInput,
        actor: OpenClawCronIntentCreator,
        signal?: AbortSignal,
        auditContext?: OpenClawCronAuditContext
    ) => Promise<GetOpenClawCronResult>;
    readonly update: (
        input: UpdateOpenClawCronInput,
        signal?: AbortSignal,
        auditContext?: OpenClawCronAuditContext
    ) => Promise<GetOpenClawCronResult>;
}

export type OpenClawCronHeartbeatProjection =
    | Readonly<{
          pendingSync: "present" | "unknown";
          state: "unavailable";
      }>
    | Readonly<{
          count: number;
          health: OpenClawCronHeartbeatHealth;
          observedAtMs: number;
          pendingSync: "none" | "present" | "unknown";
          state: "fresh";
      }>
    | Readonly<{
          count: number;
          health: OpenClawCronHeartbeatHealth;
          observedAtMs: number;
          pendingSync: "none" | "present" | "unknown";
          staleSinceMs: number;
          state: "last-known-good";
      }>;

export interface OpenClawCronHeartbeatHealth {
    readonly disabledCount: number;
    readonly enabledCount: number;
    readonly inspectedCount: number;
    readonly intendedDisabledCount: number;
    readonly lastRunErrorCount: number;
    readonly runningCount: number;
    readonly staleRunningCount: number;
    readonly synchronizationConflictCount: number;
    readonly synchronizationPendingCount: number;
    readonly truncated: boolean;
    readonly unexpectedDisabledCount: number;
}

/** Identity-free state of one task-linked cron, never its provider id or name. */
export type OpenClawCronHeartbeatJobProjection =
    | Readonly<{ state: "missing" | "unavailable" }>
    | Readonly<{
          desiredEnabled?: boolean;
          enabled: boolean;
          lastDurationMs?: number;
          lastRunAtMs?: number;
          lastRunStatus?: "error" | "ok" | "skipped" | "unknown";
          nextRunAtMs?: number;
          runningAtMs?: number;
          state: "present";
          synchronization: "confirmed" | "conflict" | "pending";
      }>;

type OpenClawCronPresentHeartbeatJobProjection = Extract<
    OpenClawCronHeartbeatJobProjection,
    { readonly state: "present" }
>;

/** Non-fetching global summary seam with no job names, payloads, or identifiers. */
export interface OpenClawCronHeartbeatReader {
    readonly disposeHeartbeat: () => Promise<void>;
    readonly readHeartbeatJobProjection: (
        id: string
    ) => OpenClawCronHeartbeatJobProjection;
    readonly readHeartbeatProjection: () => OpenClawCronHeartbeatProjection;
    readonly refreshHeartbeatProjection: () => Promise<void>;
}

function parseInput<TSchema extends v.GenericSchema>(
    schema: TSchema,
    input: unknown
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, input, { abortEarly: true });
    if (!result.success) {
        throw new OpenClawCronServiceError("invalid-input", { cause: result.issues });
    }
    return result.output;
}

function serviceError(error: unknown, id?: string): OpenClawCronServiceError {
    if (error instanceof OpenClawCronServiceError) return error;
    if (isOpenClawCronProviderError(error)) {
        let reason: OpenClawCronServiceErrorReason;
        switch (error.kind) {
            case "conflict": {
                reason = "conflict";
                break;
            }
            case "invalid-data": {
                reason = "provider-data-invalid";
                break;
            }
            case "not-found": {
                reason = "not-found";
                break;
            }
            case "unknown-outcome": {
                reason = "unknown-outcome";
                break;
            }
            case "unavailable": {
                reason = "provider-unavailable";
                break;
            }
        }
        return new OpenClawCronServiceError(reason, { cause: error, id });
    }
    return new OpenClawCronServiceError("provider-unavailable", { cause: error, id });
}

function signalOptions(signal: AbortSignal | undefined): Readonly<{
    signal?: AbortSignal;
}> {
    return signal === undefined ? {} : { signal };
}

function listCacheKey(input: ListOpenClawCronInput): string {
    return JSON.stringify([
        input.enabled,
        input.lastRunStatus,
        input.limit,
        input.offset,
        input.query ?? null,
        input.scheduleKind,
        input.sortBy,
        input.sortDir,
    ]);
}

function runCacheKey(input: ListOpenClawCronRunsInput): string {
    return JSON.stringify([
        input.id,
        input.limit,
        input.offset,
        input.sortDir,
        input.statuses ?? null,
        input.deliveryStatuses ?? null,
    ]);
}

function providerUpdatePatch(
    input: UpdateOpenClawCronInput
): OpenClawCronProviderUpdatePatch {
    const payload = input.patch.payload;
    return {
        ...(input.patch.delivery === undefined ? {} : { delivery: input.patch.delivery }),
        ...(input.patch.description === undefined
            ? {}
            : { description: input.patch.description }),
        ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
        ...(payload === undefined
            ? {}
            : {
                  payload:
                      payload.kind === "system-event"
                          ? { kind: "systemEvent" as const, text: payload.text }
                          : {
                                kind: "agentTurn" as const,
                                ...(payload.lightContext === undefined
                                    ? {}
                                    : { lightContext: payload.lightContext }),
                                message: payload.message,
                                ...(payload.model === undefined
                                    ? {}
                                    : { model: payload.model }),
                                ...(payload.thinking === undefined
                                    ? {}
                                    : { thinking: payload.thinking }),
                                ...(payload.timeoutSeconds === undefined
                                    ? {}
                                    : { timeoutSeconds: payload.timeoutSeconds }),
                            },
              }),
        ...(input.patch.schedule === undefined ? {} : { schedule: input.patch.schedule }),
        ...(input.patch.wakeMode === undefined ? {} : { wakeMode: input.patch.wakeMode }),
    };
}

function assertExpectedRevision(
    job: OpenClawCronProviderJob,
    expectedConfigRevision: string
): void {
    if (job.configRevision !== expectedConfigRevision) {
        throw new OpenClawCronServiceError("conflict", { id: job.id });
    }
}

function deferredVoid(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

/** Minimum age before heartbeat performs another owned Gateway inventory read. */
export const openClawCronHeartbeatRefreshIntervalMs = 60_000;
/** Short retry gate after an unsuccessful refresh, without making stale data fresh. */
export const openClawCronHeartbeatFailureBackoffMs = 10_000;
/** Shared deadline below the HTTP listener ceiling for one owned refresh. */
export const openClawCronHeartbeatRefreshTimeoutMs = 8000;
/** Maximum complete cron rows inspected by one heartbeat refresh. */
export const openClawCronHeartbeatInventoryMaximum = 1000;
/** Maximum cumulative authenticated response-frame bytes admitted by one refresh. */
export const openClawCronHeartbeatInventoryMaximumBytes = 32 * 1024 * 1024;
/** A running cron older than this threshold is surfaced as potentially stuck. */
export const openClawCronHeartbeatStaleRunningMs = 1_800_000;

class OpenClawCronHeartbeatInventoryBudgetError extends OpenClawCronServiceError {
    constructor() {
        super("provider-data-invalid");
        this.name = "OpenClawCronHeartbeatInventoryBudgetError";
    }
}

function heartbeatSummary(
    jobs: ReadonlyMap<string, OpenClawCronPresentHeartbeatJobProjection>,
    total: number,
    observedAtMs: number
): Readonly<{
    health: OpenClawCronHeartbeatHealth;
    pendingSync: "none" | "present" | "unknown";
}> {
    let disabledCount = 0;
    let enabledCount = 0;
    let intendedDisabledCount = 0;
    let lastRunErrorCount = 0;
    let runningCount = 0;
    let staleRunningCount = 0;
    let synchronizationConflictCount = 0;
    let synchronizationPendingCount = 0;
    for (const job of jobs.values()) {
        if (job.enabled) enabledCount += 1;
        else disabledCount += 1;
        if (!job.enabled && job.desiredEnabled === false) {
            intendedDisabledCount += 1;
        }
        if (job.lastRunStatus === "error") lastRunErrorCount += 1;
        if (job.runningAtMs !== undefined) {
            runningCount += 1;
            if (
                job.runningAtMs <=
                Math.max(0, observedAtMs - openClawCronHeartbeatStaleRunningMs)
            ) {
                staleRunningCount += 1;
            }
        }
        if (job.synchronization === "conflict") {
            synchronizationConflictCount += 1;
        } else if (job.synchronization === "pending") {
            synchronizationPendingCount += 1;
        }
    }
    const health = Object.freeze({
        disabledCount,
        enabledCount,
        inspectedCount: jobs.size,
        intendedDisabledCount,
        lastRunErrorCount,
        runningCount,
        staleRunningCount,
        synchronizationConflictCount,
        synchronizationPendingCount,
        truncated: jobs.size < total,
        unexpectedDisabledCount: disabledCount - intendedDisabledCount,
    });
    let pendingSync: "none" | "present" | "unknown" = "none";
    if (synchronizationConflictCount + synchronizationPendingCount > 0) {
        pendingSync = "present";
    } else if (jobs.size < total) {
        pendingSync = "unknown";
    }
    return Object.freeze({ health, pendingSync });
}

function heartbeatJobProjection(
    job: OpenClawCronHeartbeatJobSummary
): OpenClawCronPresentHeartbeatJobProjection {
    return Object.freeze({
        ...(job.desiredEnabled === undefined
            ? {}
            : { desiredEnabled: job.desiredEnabled }),
        enabled: job.enabled,
        ...(job.lastDurationMs === undefined
            ? {}
            : { lastDurationMs: job.lastDurationMs }),
        ...(job.lastRunAtMs === undefined ? {} : { lastRunAtMs: job.lastRunAtMs }),
        ...(job.lastRunStatus === undefined ? {} : { lastRunStatus: job.lastRunStatus }),
        ...(job.nextRunAtMs === undefined ? {} : { nextRunAtMs: job.nextRunAtMs }),
        ...(job.runningAtMs === undefined ? {} : { runningAtMs: job.runningAtMs }),
        state: "present",
        synchronization: job.synchronization,
    });
}

function heartbeatInventoryInput(offset: number): ListOpenClawCronInput {
    return {
        enabled: "all",
        lastRunStatus: "all",
        limit: openClawCronPageMaximum,
        offset,
        scheduleKind: "all",
        sortBy: "name",
        sortDir: "asc",
    };
}

function defaultAmbiguousPendingSync(
    operation: OpenClawCronAuditOperation
): "present" | "unknown" | undefined {
    if (operation === "reconcile-expired") return "present";
    if (operation === "delete") return "unknown";
    return undefined;
}

/**
 * Isolated service for strict projections, LKG reads, append-only intent sagas, and controls.
 * @returns A bounded OpenClaw cron service.
 */
export function createOpenClawCronService(
    options: OpenClawCronServiceOptions
): OpenClawCronService & OpenClawCronHeartbeatReader {
    const now = options.clock ?? Date.now;
    const monotonicNow = options.monotonicClock ?? (() => performance.now());
    const auditRequired = options.auditRequired ?? true;
    const expirySystemActor = {
        id: options.expirySystemActorId ?? "openclaw-cron-expiry",
        kind: "system",
    } as const;
    const expiryAuditContext = {
        actor: {
            authenticatorId: null,
            id: expirySystemActor.id,
            kind: "system",
        },
    } as const satisfies OpenClawCronAuditContext;
    const listCache = new Map<string, Observed<OpenClawCronProviderListPage>>();
    const getCache = new Map<string, Observed<OpenClawCronProviderJob>>();
    const runsCache = new Map<string, Observed<OpenClawCronProviderRunPage>>();
    const jobLocks = new Map<string, Promise<void>>();
    let heartbeatJobProjections: ReadonlyMap<
        string,
        OpenClawCronPresentHeartbeatJobProjection
    > = new Map();
    let heartbeatDisposed = false;
    let heartbeatNextAttemptAtMonotonicMs: number | undefined;
    let heartbeatRefreshController: AbortController | undefined;
    let heartbeatRefreshPromise: Promise<void> | undefined;
    let heartbeatSnapshotGeneration = 0;
    let heartbeatProjection: OpenClawCronHeartbeatProjection = Object.freeze({
        pendingSync: "unknown",
        state: "unavailable",
    });

    function markHeartbeatProjectionStale(
        candidateCheckedAtMs?: number,
        pendingSync?: "present" | "unknown"
    ): void {
        const current = heartbeatProjection;
        if (current.state === "unavailable") {
            if (pendingSync === "present" && current.pendingSync !== "present") {
                heartbeatProjection = Object.freeze({
                    pendingSync: "present",
                    state: "unavailable",
                });
            }
            return;
        }
        let checkedAtMs = current.observedAtMs;
        try {
            checkedAtMs = v.parse(
                openClawCronTimestampSchema,
                candidateCheckedAtMs ?? now()
            );
        } catch {
            // Summary bookkeeping cannot change an already-known cron operation outcome.
        }
        heartbeatProjection = Object.freeze({
            count: current.count,
            health: current.health,
            observedAtMs: current.observedAtMs,
            pendingSync:
                current.pendingSync === "present" || pendingSync === "present"
                    ? "present"
                    : (pendingSync ?? current.pendingSync),
            staleSinceMs:
                current.state === "last-known-good"
                    ? current.staleSinceMs
                    : Math.max(checkedAtMs, current.observedAtMs),
            state: "last-known-good",
        });
    }

    function ambiguousMutation(
        id: string,
        cause: unknown,
        pendingSync?: "present" | "unknown"
    ): OpenClawCronServiceError {
        invalidateHeartbeatProjection(undefined, pendingSync);
        return new OpenClawCronServiceError("unknown-outcome", { cause, id });
    }

    function invalidateHeartbeatProjection(
        candidateCheckedAtMs?: number,
        pendingSync?: "present" | "unknown"
    ): void {
        heartbeatSnapshotGeneration += 1;
        heartbeatNextAttemptAtMonotonicMs = undefined;
        markHeartbeatProjectionStale(candidateCheckedAtMs, pendingSync);
    }

    function readHeartbeatProjection(): OpenClawCronHeartbeatProjection {
        return heartbeatProjection;
    }

    function readHeartbeatJobProjection(id: string): OpenClawCronHeartbeatJobProjection {
        if (heartbeatProjection.state !== "fresh") {
            return Object.freeze({ state: "unavailable" });
        }
        const present = heartbeatJobProjections.get(id);
        if (present !== undefined) return present;
        return Object.freeze({
            state: heartbeatProjection.health.truncated ? "unavailable" : "missing",
        });
    }

    let lastHeartbeatMonotonicMs = 0;

    function heartbeatMonotonicMs(): number {
        const candidate = monotonicNow();
        if (!Number.isFinite(candidate) || candidate < 0) {
            throw new RangeError("OpenClaw cron heartbeat monotonic clock is invalid");
        }
        lastHeartbeatMonotonicMs = Math.max(lastHeartbeatMonotonicMs, candidate);
        return lastHeartbeatMonotonicMs;
    }

    async function readFreshHeartbeatPage(
        offset: number,
        signal: AbortSignal
    ): Promise<OpenClawCronProviderListPage> {
        signal.throwIfAborted();
        try {
            const page = await options.provider.list({
                ...heartbeatInventoryInput(offset),
                compact: false,
                includeDeliveryPreviews: false,
                signal,
            });
            signal.throwIfAborted();
            return page;
        } catch (error) {
            if (signal.aborted) throw error;
            throw serviceError(error);
        }
    }

    function validateHeartbeatPage(
        page: OpenClawCronProviderListPage,
        index: number,
        inspectedTotal: number,
        snapshotRevision: string,
        total: number,
        ids: Set<string>
    ): void {
        const expectedOffset = index * openClawCronPageMaximum;
        const expectedLength = Math.min(
            openClawCronPageMaximum,
            Math.max(0, inspectedTotal - expectedOffset)
        );
        const expectedNextOffset = expectedOffset + expectedLength;
        const expectedHasMore = expectedNextOffset < total;
        if (
            page.limit !== openClawCronPageMaximum ||
            page.offset !== expectedOffset ||
            !Number.isSafeInteger(page.responseBytes) ||
            page.responseBytes < 1 ||
            page.total !== total ||
            page.snapshotRevision !== snapshotRevision ||
            page.jobs.length !== expectedLength ||
            page.hasMore !== expectedHasMore ||
            page.nextOffset !== (expectedHasMore ? expectedNextOffset : null)
        ) {
            throw new OpenClawCronServiceError("provider-data-invalid");
        }
        for (const { id } of page.jobs) {
            if (ids.has(id)) {
                throw new OpenClawCronServiceError("provider-data-invalid", {
                    id,
                });
            }
            ids.add(id);
        }
    }

    async function readFreshHeartbeatCandidate(signal: AbortSignal): Promise<{
        readonly health: OpenClawCronHeartbeatHealth;
        readonly jobs: ReadonlyMap<string, OpenClawCronPresentHeartbeatJobProjection>;
        readonly observedAtMs: number;
        readonly pendingSync: "none" | "present" | "unknown";
        readonly total: number;
    }> {
        let lastFailure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort();
            if (signal.aborted) {
                abortAttempt();
            } else {
                signal.addEventListener("abort", abortAttempt, { once: true });
            }
            try {
                let currentPage: OpenClawCronProviderListPage | undefined =
                    await readFreshHeartbeatPage(0, attemptController.signal);
                if (
                    !Number.isSafeInteger(currentPage.total) ||
                    currentPage.total < 0 ||
                    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(currentPage.snapshotRevision)
                ) {
                    throw new OpenClawCronServiceError("provider-data-invalid");
                }
                const total = currentPage.total;
                const snapshotRevision = currentPage.snapshotRevision;
                const inspectedTotal = Math.min(
                    total,
                    openClawCronHeartbeatInventoryMaximum
                );
                const pageCount = Math.max(
                    1,
                    Math.ceil(inspectedTotal / openClawCronPageMaximum)
                );
                const observedAtMs = v.parse(openClawCronTimestampSchema, now());
                const freshness = freshOpenClawCronSource(observedAtMs);
                const ids = new Set<string>();
                const jobs = new Map<string, OpenClawCronPresentHeartbeatJobProjection>();
                let admittedResponseBytes = 0;
                for (let index = 0; index < pageCount; index += 1) {
                    attemptController.signal.throwIfAborted();
                    if (index > 0) {
                        currentPage = await readFreshHeartbeatPage(
                            index * openClawCronPageMaximum,
                            attemptController.signal
                        );
                    }
                    const page = currentPage;
                    if (page === undefined) {
                        throw new OpenClawCronServiceError("provider-data-invalid");
                    }
                    validateHeartbeatPage(
                        page,
                        index,
                        inspectedTotal,
                        snapshotRevision,
                        total,
                        ids
                    );
                    if (
                        page.responseBytes >
                        openClawCronHeartbeatInventoryMaximumBytes - admittedResponseBytes
                    ) {
                        throw new OpenClawCronHeartbeatInventoryBudgetError();
                    }
                    admittedResponseBytes += page.responseBytes;
                    for (const job of page.jobs) {
                        const summary = projectOpenClawCronHeartbeatJobSummary(
                            job,
                            await getActiveIntent(job.id, attemptController.signal),
                            freshness,
                            observedAtMs
                        );
                        jobs.set(summary.id, heartbeatJobProjection(summary));
                    }
                    currentPage = undefined;
                }
                const summary = heartbeatSummary(jobs, total, observedAtMs);
                return {
                    health: summary.health,
                    jobs,
                    observedAtMs,
                    pendingSync: summary.pendingSync,
                    total,
                };
            } catch (error) {
                if (signal.aborted) throw error;
                const failure = serviceError(error);
                lastFailure = failure;
                if (
                    attempt === 0 &&
                    failure.reason === "provider-data-invalid" &&
                    !(error instanceof OpenClawCronHeartbeatInventoryBudgetError)
                ) {
                    continue;
                }
                throw failure;
            } finally {
                signal.removeEventListener("abort", abortAttempt);
                attemptController.abort();
            }
        }
        throw serviceError(lastFailure);
    }

    async function refreshHeartbeatProjection(): Promise<void> {
        if (heartbeatDisposed) return;
        const active = heartbeatRefreshPromise;
        if (active !== undefined) {
            await active;
            await refreshHeartbeatProjection();
            return;
        }
        let startedAtMonotonicMs: number;
        try {
            startedAtMonotonicMs = heartbeatMonotonicMs();
        } catch {
            markHeartbeatProjectionStale();
            return;
        }
        if (
            heartbeatNextAttemptAtMonotonicMs !== undefined &&
            startedAtMonotonicMs < heartbeatNextAttemptAtMonotonicMs
        ) {
            return;
        }

        const generation = heartbeatSnapshotGeneration;
        const controller = new AbortController();
        heartbeatRefreshController = controller;
        const timeout = setTimeout(
            () => controller.abort(),
            openClawCronHeartbeatRefreshTimeoutMs
        );
        timeout.unref?.();
        const flight = (async () => {
            try {
                const candidate = await readFreshHeartbeatCandidate(controller.signal);
                if (heartbeatDisposed || generation !== heartbeatSnapshotGeneration) {
                    return;
                }
                heartbeatJobProjections = candidate.jobs;
                heartbeatProjection = Object.freeze({
                    count: candidate.total,
                    health: candidate.health,
                    observedAtMs: candidate.observedAtMs,
                    pendingSync: candidate.pendingSync,
                    state: "fresh",
                });
                heartbeatNextAttemptAtMonotonicMs =
                    heartbeatMonotonicMs() + openClawCronHeartbeatRefreshIntervalMs;
            } catch {
                if (!heartbeatDisposed && generation === heartbeatSnapshotGeneration) {
                    markHeartbeatProjectionStale();
                    let completedAtMonotonicMs = startedAtMonotonicMs;
                    try {
                        completedAtMonotonicMs = heartbeatMonotonicMs();
                    } catch {
                        // Retain a bounded gate from the last valid monotonic observation.
                    }
                    heartbeatNextAttemptAtMonotonicMs =
                        completedAtMonotonicMs + openClawCronHeartbeatFailureBackoffMs;
                }
            } finally {
                clearTimeout(timeout);
                if (heartbeatRefreshController === controller) {
                    heartbeatRefreshController = undefined;
                    heartbeatRefreshPromise = undefined;
                }
            }
        })();
        heartbeatRefreshPromise = flight;
        await flight;
    }

    async function disposeHeartbeat(): Promise<void> {
        if (heartbeatDisposed) return;
        heartbeatDisposed = true;
        heartbeatSnapshotGeneration += 1;
        heartbeatRefreshController?.abort();
        await heartbeatRefreshPromise;
    }

    async function recordOperationAudit(
        operation: OpenClawCronAuditOperation,
        settlement: OpenClawCronAuditSettlement,
        targetId: string,
        context: OpenClawCronAuditContext | undefined
    ): Promise<void> {
        if (options.auditWriter === undefined || context === undefined) {
            if (!auditRequired) return;
            throw new OpenClawCronServiceError("audit-unavailable", { id: targetId });
        }
        try {
            await options.auditWriter.record({
                ...context,
                operation,
                settlement,
                targetId,
            });
        } catch (error) {
            throw new OpenClawCronServiceError("audit-unavailable", {
                cause: error,
                id: targetId,
            });
        }
    }

    async function settleOperationAudit(
        operation: OpenClawCronAuditOperation,
        settlement: OpenClawCronTerminalAuditSettlement,
        targetId: string,
        context: OpenClawCronAuditContext | undefined
    ): Promise<void> {
        try {
            await recordOperationAudit(operation, settlement, targetId, context);
        } catch {
            try {
                options.onAuditSettlementFailure?.({
                    operation,
                    settlement,
                    targetFingerprint: openClawCronAuditTargetFingerprint(targetId),
                });
            } catch {
                // Observability defects cannot replace the authoritative operation result.
            }
        }
    }

    async function withOperationAudit<T>(
        operation: OpenClawCronAuditOperation,
        targetId: string,
        context: OpenClawCronAuditContext | undefined,
        execute: () => Promise<T>,
        settlement: (result: T) => OpenClawCronTerminalAuditSettlement = () => "succeeded"
    ): Promise<T> {
        await recordOperationAudit(operation, "attempted", targetId, context);
        try {
            const result = await execute();
            await settleOperationAudit(operation, settlement(result), targetId, context);
            return result;
        } catch (error) {
            const failure =
                error instanceof OpenClawCronServiceError &&
                error.reason === "unknown-outcome"
                    ? ambiguousMutation(
                          targetId,
                          error,
                          defaultAmbiguousPendingSync(operation)
                      )
                    : error;
            await settleOperationAudit(
                operation,
                failure instanceof OpenClawCronServiceError &&
                    failure.reason === "unknown-outcome"
                    ? "partial"
                    : "failed",
                targetId,
                context
            );
            throw failure;
        }
    }

    async function withJobLock<T>(
        id: string,
        signal: AbortSignal | undefined,
        operation: () => Promise<T>
    ): Promise<T> {
        signal?.throwIfAborted();
        const previous = jobLocks.get(id) ?? Promise.resolve();
        const current = deferredVoid();
        jobLocks.set(id, current.promise);
        try {
            await previous;
            signal?.throwIfAborted();
            return await operation();
        } finally {
            current.resolve();
            if (jobLocks.get(id) === current.promise) jobLocks.delete(id);
        }
    }

    async function getActiveIntent(
        id: string,
        signal?: AbortSignal
    ): Promise<OpenClawCronActiveDisableIntent | undefined> {
        signal?.throwIfAborted();
        const intent = await options.intentStore.getActive(id);
        signal?.throwIfAborted();
        return intent;
    }

    async function activeIntentForFreshJob(
        job: OpenClawCronProviderJob,
        observedAtMs: number,
        signal?: AbortSignal
    ): Promise<OpenClawCronActiveDisableIntent | undefined> {
        const intent = await getActiveIntent(job.id, signal);
        if (
            intent?.expiresAtMs === undefined ||
            intent.expiresAtMs > observedAtMs ||
            !job.enabled
        ) {
            return intent;
        }
        const closed = await options.intentStore.closeActive({
            actor: expirySystemActor,
            atMs: observedAtMs,
            expectedRevision: intent.revision,
            externalJobId: job.id,
            reason: "expired",
        });
        signal?.throwIfAborted();
        if (closed) invalidateInventory(observedAtMs);
        return closed ? undefined : await getActiveIntent(job.id, signal);
    }

    function openLinkedTasks(
        jobs: readonly OpenClawCronProviderJob[]
    ): ReadonlyMap<string, OpenClawCronLinkedTask> {
        if (options.linkedTaskReader === undefined || jobs.length === 0) return new Map();
        const requestedIds = new Set(jobs.map(({ id }) => id));
        const records = options.linkedTaskReader.listOpenLinkedTasks([...requestedIds]);
        const result = new Map<string, OpenClawCronLinkedTask>();
        for (const record of records) {
            if (!requestedIds.has(record.cronJobId) || result.has(record.cronJobId)) {
                throw new OpenClawCronServiceError("provider-data-invalid", {
                    id: record.cronJobId,
                });
            }
            result.set(record.cronJobId, record.task);
        }
        return result;
    }

    async function projectFreshJob(
        job: OpenClawCronProviderJob,
        observedAtMs: number,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        const freshness = freshOpenClawCronSource(observedAtMs);
        const intent = await activeIntentForFreshJob(job, observedAtMs, signal);
        const result = projectOpenClawCronGetResult(
            job,
            intent,
            freshness,
            observedAtMs,
            openLinkedTasks([job]).get(job.id)
        );
        getCache.set(job.id, { observedAtMs, value: job });
        return result;
    }

    async function freshProviderJob(
        id: string,
        signal?: AbortSignal
    ): Promise<Observed<OpenClawCronProviderJob>> {
        signal?.throwIfAborted();
        let job: OpenClawCronProviderJob | undefined;
        try {
            job = await options.provider.get({ id, ...signalOptions(signal) });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw serviceError(error, id);
        }
        signal?.throwIfAborted();
        if (job === undefined) {
            getCache.delete(id);
            throw new OpenClawCronServiceError("not-found", { id });
        }
        if (job.id !== id) {
            throw new OpenClawCronServiceError("provider-data-invalid", { id });
        }
        const observedAtMs = now();
        const freshness = freshOpenClawCronSource(observedAtMs);
        projectOpenClawCronJob(job, undefined, freshness, observedAtMs);
        getCache.set(id, { observedAtMs, value: job });
        return { observedAtMs, value: job };
    }

    function invalidateInventory(
        candidateCheckedAtMs?: number,
        pendingSync?: "present" | "unknown"
    ): void {
        listCache.clear();
        invalidateHeartbeatProjection(candidateCheckedAtMs, pendingSync);
    }

    function clearTargetCaches(id: string): void {
        getCache.delete(id);
        for (const key of runsCache.keys()) {
            const decoded = JSON.parse(key) as readonly unknown[];
            if (decoded[0] === id) runsCache.delete(key);
        }
    }

    async function list(
        input: ListOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<ListOpenClawCronResult> {
        const parsed = parseInput(listOpenClawCronInputSchema, input);
        const key = listCacheKey(parsed);
        signal?.throwIfAborted();
        try {
            const page = await options.provider.list({
                ...parsed,
                compact: false,
                includeDeliveryPreviews: false,
                ...signalOptions(signal),
            });
            signal?.throwIfAborted();
            const observedAtMs = now();
            const result = await projectOpenClawCronListResult(
                page,
                (job) => activeIntentForFreshJob(job, observedAtMs, signal),
                freshOpenClawCronSource(observedAtMs),
                observedAtMs,
                openLinkedTasks(page.jobs)
            );
            listCache.set(key, { observedAtMs, value: page });
            for (const job of page.jobs) {
                getCache.set(job.id, { observedAtMs, value: job });
            }
            return result;
        } catch (error) {
            if (signal?.aborted) throw error;
            const cached = listCache.get(key);
            if (cached === undefined) {
                throw serviceError(error);
            }
            const checkedAtMs = now();
            const result = await projectOpenClawCronListResult(
                cached.value,
                (job) => getActiveIntent(job.id, signal),
                lastKnownGoodOpenClawCronSource(cached.observedAtMs, checkedAtMs),
                checkedAtMs,
                openLinkedTasks(cached.value.jobs)
            );
            return result;
        }
    }

    async function get(
        input: GetOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        const parsed = parseInput(getOpenClawCronInputSchema, input);
        try {
            const observed = await freshProviderJob(parsed.id, signal);
            return await projectFreshJob(observed.value, observed.observedAtMs, signal);
        } catch (error) {
            if (signal?.aborted) throw error;
            if (
                error instanceof OpenClawCronServiceError &&
                error.reason === "not-found"
            ) {
                throw error;
            }
            const cached = getCache.get(parsed.id);
            if (cached === undefined) throw serviceError(error, parsed.id);
            const checkedAtMs = now();
            return projectOpenClawCronGetResult(
                cached.value,
                await getActiveIntent(parsed.id, signal),
                lastKnownGoodOpenClawCronSource(cached.observedAtMs, checkedAtMs),
                checkedAtMs,
                openLinkedTasks([cached.value]).get(cached.value.id)
            );
        }
    }

    async function listRuns(
        input: ListOpenClawCronRunsInput,
        signal?: AbortSignal
    ): Promise<ListOpenClawCronRunsResult> {
        const parsed = parseInput(listOpenClawCronRunsInputSchema, input);
        const key = runCacheKey(parsed);
        signal?.throwIfAborted();
        try {
            const page = await options.provider.listRuns({
                ...parsed,
                ...signalOptions(signal),
            });
            signal?.throwIfAborted();
            const observedAtMs = now();
            const result = projectOpenClawCronRunsResult(
                page,
                freshOpenClawCronSource(observedAtMs)
            );
            runsCache.set(key, { observedAtMs, value: page });
            return result;
        } catch (error) {
            if (signal?.aborted) throw error;
            const cached = runsCache.get(key);
            if (cached === undefined) throw serviceError(error, parsed.id);
            return projectOpenClawCronRunsResult(
                cached.value,
                lastKnownGoodOpenClawCronSource(cached.observedAtMs, now())
            );
        }
    }

    function pendingDisableResult(
        preflight: Observed<OpenClawCronProviderJob>,
        intent: OpenClawCronActiveDisableIntent | undefined,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        signal?.throwIfAborted();
        if (intent === undefined) {
            throw ambiguousMutation(preflight.value.id, undefined, "present");
        }
        const checkedAtMs = now();
        invalidateInventory(checkedAtMs, "present");
        return Promise.resolve(
            projectOpenClawCronGetResult(
                preflight.value,
                intent,
                lastKnownGoodOpenClawCronSource(preflight.observedAtMs, checkedAtMs),
                checkedAtMs,
                openLinkedTasks([preflight.value]).get(preflight.value.id)
            )
        );
    }

    async function closeDeletedTarget(
        id: string,
        actor: OpenClawCronIntentCreator,
        signal?: AbortSignal
    ): Promise<void> {
        signal?.throwIfAborted();
        await options.intentStore.closeActive({
            actor,
            atMs: now(),
            externalJobId: id,
            reason: "target-deleted",
        });
    }

    async function setEnabled(
        input: SetOpenClawCronEnabledInput,
        actor: OpenClawCronIntentCreator,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        const parsed = parseInput(setOpenClawCronEnabledInputSchema, input);
        return await withJobLock(parsed.id, signal, async () => {
            const preflight = await freshProviderJob(parsed.id, signal);
            assertExpectedRevision(preflight.value, parsed.expectedConfigRevision);
            const mutationStartedAtMs = now();
            const disableInput = parsed.disableIntent ?? undefined;
            if (
                !parsed.enabled &&
                disableInput?.expiresAtMs !== undefined &&
                disableInput.expiresAtMs <= mutationStartedAtMs
            ) {
                throw new OpenClawCronServiceError("invalid-input", { id: parsed.id });
            }

            const previousIntent = await getActiveIntent(parsed.id, signal);
            const intent = parsed.enabled
                ? previousIntent
                : await options.intentStore.replaceActive({
                      actor,
                      ...(disableInput?.expiresAtMs === undefined
                          ? {}
                          : { expiresAtMs: disableInput.expiresAtMs }),
                      externalJobId: parsed.id,
                      reason: disableInput?.reason ?? "Operator disabled",
                      recordedAtMs: mutationStartedAtMs,
                  });
            if (!parsed.enabled && signal?.aborted) {
                return await pendingDisableResult(preflight, intent);
            }
            signal?.throwIfAborted();

            try {
                await options.provider.update({
                    expectedConfigRevision: parsed.expectedConfigRevision,
                    id: parsed.id,
                    patch: { enabled: parsed.enabled },
                    ...signalOptions(signal),
                });
            } catch (error) {
                const mapped = serviceError(error, parsed.id);
                if (mapped.reason === "provider-data-invalid") {
                    if (!parsed.enabled) {
                        return await pendingDisableResult(preflight, intent);
                    }
                    throw mapped;
                }
                if (mapped.reason === "not-found") {
                    await closeDeletedTarget(parsed.id, actor);
                    invalidateInventory();
                    throw mapped;
                }
                try {
                    const readback = await freshProviderJob(parsed.id);
                    if (readback.value.enabled === parsed.enabled) {
                        if (parsed.enabled && previousIntent !== undefined) {
                            try {
                                await options.intentStore.closeActive({
                                    actor,
                                    atMs: readback.observedAtMs,
                                    expectedRevision: previousIntent.revision,
                                    externalJobId: parsed.id,
                                    reason: "re-enabled",
                                });
                            } catch (settlementError) {
                                throw new OpenClawCronServiceError("unknown-outcome", {
                                    cause: settlementError,
                                    id: parsed.id,
                                });
                            }
                        }
                        invalidateInventory();
                        return await projectFreshJob(
                            readback.value,
                            readback.observedAtMs
                        );
                    }
                } catch (readbackError) {
                    if (
                        readbackError instanceof OpenClawCronServiceError &&
                        readbackError.reason === "not-found"
                    ) {
                        await closeDeletedTarget(parsed.id, actor);
                        invalidateInventory();
                        throw readbackError;
                    }
                    if (
                        readbackError instanceof OpenClawCronServiceError &&
                        readbackError.reason === "provider-data-invalid"
                    ) {
                        throw readbackError;
                    }
                    if (
                        readbackError instanceof OpenClawCronServiceError &&
                        readbackError.reason === "unknown-outcome"
                    ) {
                        throw ambiguousMutation(
                            parsed.id,
                            readbackError,
                            parsed.enabled && previousIntent !== undefined
                                ? "present"
                                : undefined
                        );
                    }
                }
                if (parsed.enabled) {
                    if (mapped.reason === "unknown-outcome") {
                        throw ambiguousMutation(
                            parsed.id,
                            mapped,
                            previousIntent === undefined ? undefined : "present"
                        );
                    }
                    throw mapped;
                }
                return await pendingDisableResult(preflight, intent);
            }

            let readback: Observed<OpenClawCronProviderJob>;
            try {
                readback = await freshProviderJob(parsed.id);
            } catch (error) {
                if (
                    error instanceof OpenClawCronServiceError &&
                    error.reason === "not-found"
                ) {
                    await closeDeletedTarget(parsed.id, actor);
                    invalidateInventory();
                    throw error;
                }
                if (!parsed.enabled) {
                    return await pendingDisableResult(preflight, intent);
                }
                throw ambiguousMutation(
                    parsed.id,
                    error,
                    previousIntent === undefined ? undefined : "present"
                );
            }

            if (readback.value.enabled !== parsed.enabled) {
                if (parsed.enabled) {
                    invalidateInventory(
                        undefined,
                        previousIntent === undefined ? undefined : "present"
                    );
                    throw new OpenClawCronServiceError("conflict", {
                        id: parsed.id,
                    });
                }
                return await pendingDisableResult(preflight, intent);
            }
            try {
                if (parsed.enabled && previousIntent !== undefined) {
                    await options.intentStore.closeActive({
                        actor,
                        atMs: readback.observedAtMs,
                        expectedRevision: previousIntent.revision,
                        externalJobId: parsed.id,
                        reason: "re-enabled",
                    });
                }
                invalidateInventory();
                return await projectFreshJob(readback.value, readback.observedAtMs);
            } catch (error) {
                throw ambiguousMutation(
                    parsed.id,
                    error,
                    previousIntent === undefined ? undefined : "present"
                );
            }
        });
    }

    async function update(
        input: UpdateOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        const parsed = parseInput(updateOpenClawCronInputSchema, input);
        return await withJobLock(parsed.id, signal, async () => {
            const preflight = await freshProviderJob(parsed.id, signal);
            assertExpectedRevision(preflight.value, parsed.expectedConfigRevision);
            let updateAcknowledged = false;
            try {
                await options.provider.update({
                    expectedConfigRevision: parsed.expectedConfigRevision,
                    id: parsed.id,
                    patch: providerUpdatePatch(parsed),
                    ...signalOptions(signal),
                });
                updateAcknowledged = true;
                const readback = await freshProviderJob(parsed.id);
                invalidateInventory();
                return await projectFreshJob(readback.value, readback.observedAtMs);
            } catch (error) {
                if (updateAcknowledged) {
                    throw ambiguousMutation(parsed.id, error);
                }
                const mapped = serviceError(error, parsed.id);
                throw mapped.reason === "unknown-outcome"
                    ? ambiguousMutation(parsed.id, mapped)
                    : mapped;
            }
        });
    }

    async function run(
        input: RunOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<RunOpenClawCronResult> {
        const parsed = parseInput(runOpenClawCronInputSchema, input);
        return await withJobLock(parsed.id, signal, async () => {
            const preflight = await freshProviderJob(parsed.id, signal);
            const intent = await getActiveIntent(parsed.id, signal);
            const dashboardOpenLinkedTask = openLinkedTasks([preflight.value]).get(
                preflight.value.id
            );
            projectOpenClawCronJob(
                preflight.value,
                intent,
                freshOpenClawCronSource(preflight.observedAtMs),
                preflight.observedAtMs,
                dashboardOpenLinkedTask
            );
            const fallbackProjectedJob = projectOpenClawCronJob(
                preflight.value,
                intent,
                lastKnownGoodOpenClawCronSource(
                    preflight.observedAtMs,
                    preflight.observedAtMs
                ),
                preflight.observedAtMs,
                dashboardOpenLinkedTask
            );
            const processInstanceId = options.provider.currentProcessInstanceId();
            if (processInstanceId === undefined) {
                throw new OpenClawCronServiceError("precondition-failed", {
                    id: parsed.id,
                });
            }
            let result: Awaited<ReturnType<OpenClawCronProvider["run"]>>;
            try {
                result = await options.provider.run({
                    expectedProcessInstanceId: processInstanceId,
                    id: parsed.id,
                    mode: "force",
                    ...signalOptions(signal),
                });
            } catch (error) {
                const mapped = serviceError(error, parsed.id);
                if (signal?.aborted && mapped.reason !== "unknown-outcome") {
                    throw error;
                }
                throw mapped.reason === "unknown-outcome"
                    ? ambiguousMutation(parsed.id, mapped)
                    : mapped;
            }
            if (result.processInstanceId !== processInstanceId) {
                throw ambiguousMutation(parsed.id, undefined);
            }
            if (result.ran === (result.reason !== undefined)) {
                throw new OpenClawCronServiceError("provider-data-invalid", {
                    id: parsed.id,
                });
            }
            let projectedJob: ReturnType<typeof projectOpenClawCronJob>;
            try {
                const current = await freshProviderJob(parsed.id);
                projectedJob = projectOpenClawCronJob(
                    current.value,
                    intent,
                    freshOpenClawCronSource(current.observedAtMs),
                    current.observedAtMs,
                    dashboardOpenLinkedTask
                );
            } catch {
                const checkedAtMs = now();
                projectedJob = fallbackProjectedJob;
                markHeartbeatProjectionStale(checkedAtMs);
            }
            const output = {
                job: projectedJob,
                outcome: result.ran ? ("accepted" as const) : ("not-run" as const),
                ...(result.reason === undefined ? {} : { reason: result.reason }),
            };
            invalidateInventory();
            return v.parse(runOpenClawCronResultSchema, output);
        });
    }

    async function remove(
        input: DeleteOpenClawCronInput,
        actor: OpenClawCronIntentCreator,
        signal?: AbortSignal
    ): Promise<DeleteOpenClawCronResult> {
        const parsed = parseInput(deleteOpenClawCronInputSchema, input);
        return await withJobLock(parsed.id, signal, async () => {
            let preflight: Observed<OpenClawCronProviderJob>;
            try {
                preflight = await freshProviderJob(parsed.id, signal);
            } catch (error) {
                if (
                    error instanceof OpenClawCronServiceError &&
                    error.reason === "not-found"
                ) {
                    await closeDeletedTarget(parsed.id, actor, signal);
                    invalidateInventory();
                    clearTargetCaches(parsed.id);
                    return v.parse(deleteOpenClawCronResultSchema, {
                        deleted: true,
                        id: parsed.id,
                        observedAtMs: now(),
                    });
                }
                throw error;
            }
            assertExpectedRevision(preflight.value, parsed.expectedConfigRevision);
            const activeIntent = await getActiveIntent(parsed.id, signal);
            const removalPendingSync = activeIntent === undefined ? "unknown" : "present";
            let removalError: OpenClawCronServiceError | undefined;
            try {
                await options.provider.remove({
                    id: parsed.id,
                    ...signalOptions(signal),
                });
            } catch (error) {
                removalError = serviceError(error, parsed.id);
            }
            let readback: OpenClawCronProviderJob | undefined;
            try {
                readback = await options.provider.get({
                    id: parsed.id,
                });
            } catch (error) {
                if (removalError?.reason === "unknown-outcome") {
                    throw ambiguousMutation(parsed.id, removalError, removalPendingSync);
                }
                if (removalError !== undefined) throw removalError;
                throw ambiguousMutation(parsed.id, error, removalPendingSync);
            }
            if (readback !== undefined) {
                if (removalError?.reason === "unknown-outcome") {
                    throw ambiguousMutation(parsed.id, removalError, removalPendingSync);
                }
                throw (
                    removalError ??
                    new OpenClawCronServiceError("conflict", { id: parsed.id })
                );
            }
            try {
                await closeDeletedTarget(parsed.id, actor);
            } catch (error) {
                throw ambiguousMutation(parsed.id, error, removalPendingSync);
            }
            invalidateInventory();
            clearTargetCaches(parsed.id);
            return v.parse(deleteOpenClawCronResultSchema, {
                deleted: true,
                id: parsed.id,
                observedAtMs: now(),
            });
        });
    }

    async function reconcileExpired(
        input: GetOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<GetOpenClawCronResult> {
        const parsed = parseInput(getOpenClawCronInputSchema, input);
        return await withJobLock(parsed.id, signal, async () => {
            const intent = await getActiveIntent(parsed.id, signal);
            const observed = await freshProviderJob(parsed.id, signal);
            if (
                intent?.expiresAtMs === undefined ||
                intent.expiresAtMs > observed.observedAtMs ||
                observed.value.enabled
            ) {
                return await projectFreshJob(
                    observed.value,
                    observed.observedAtMs,
                    signal
                );
            }
            const expectedConfigRevision = observed.value.configRevision;
            if (expectedConfigRevision === undefined) {
                throw new OpenClawCronServiceError("precondition-failed", {
                    id: parsed.id,
                });
            }
            return await withOperationAudit(
                "reconcile-expired",
                parsed.id,
                expiryAuditContext,
                async () => {
                    let updateAcknowledged = false;
                    try {
                        await options.provider.update({
                            expectedConfigRevision,
                            id: parsed.id,
                            patch: { enabled: true },
                            ...signalOptions(signal),
                        });
                        updateAcknowledged = true;
                        const readback = await freshProviderJob(parsed.id);
                        if (readback.value.enabled) {
                            await options.intentStore.closeActive({
                                actor: expirySystemActor,
                                atMs: readback.observedAtMs,
                                expectedRevision: intent.revision,
                                externalJobId: parsed.id,
                                reason: "expired",
                            });
                        }
                        invalidateInventory();
                        return await projectFreshJob(
                            readback.value,
                            readback.observedAtMs
                        );
                    } catch (error) {
                        if (updateAcknowledged) {
                            throw ambiguousMutation(parsed.id, error, "present");
                        }
                        const mapped = serviceError(error, parsed.id);
                        if (signal?.aborted && mapped.reason !== "unknown-outcome") {
                            throw error;
                        }
                        throw mapped.reason === "unknown-outcome"
                            ? ambiguousMutation(parsed.id, mapped, "present")
                            : mapped;
                    }
                },
                (result) =>
                    result.job.enabled && result.job.synchronization.state === "confirmed"
                        ? "succeeded"
                        : "partial"
            );
        });
    }

    const auditedDelete: OpenClawCronService["delete"] = (
        input,
        actor,
        signal,
        auditContext
    ) =>
        withOperationAudit("delete", input.id, auditContext, () =>
            remove(input, actor, signal)
        );
    const auditedRun: OpenClawCronService["run"] = (input, signal, auditContext) =>
        withOperationAudit("run", input.id, auditContext, () => run(input, signal));
    const auditedSetEnabled: OpenClawCronService["setEnabled"] = (
        input,
        actor,
        signal,
        auditContext
    ) =>
        withOperationAudit(
            "set-enabled",
            input.id,
            auditContext,
            () => setEnabled(input, actor, signal),
            (result) =>
                result.job.synchronization.state === "confirmed" ? "succeeded" : "partial"
        );
    const auditedUpdate: OpenClawCronService["update"] = (input, signal, auditContext) =>
        withOperationAudit("update", input.id, auditContext, () => update(input, signal));

    return Object.freeze({
        delete: auditedDelete,
        disposeHeartbeat,
        get,
        list,
        listRuns,
        readHeartbeatJobProjection,
        readHeartbeatProjection,
        refreshHeartbeatProjection,
        reconcileExpired,
        run: auditedRun,
        setEnabled: auditedSetEnabled,
        update: auditedUpdate,
    });
}
