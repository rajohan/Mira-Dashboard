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
    projectOpenClawCronJob,
    projectOpenClawCronListResult,
    projectOpenClawCronRunsResult,
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
          observedAtMs: number;
          pendingSync: "none" | "present" | "unknown";
          state: "fresh";
      }>
    | Readonly<{
          count: number;
          observedAtMs: number;
          pendingSync: "none" | "present" | "unknown";
          staleSinceMs: number;
          state: "last-known-good";
      }>;

/** Non-fetching global summary seam with no job names, payloads, or identifiers. */
export interface OpenClawCronHeartbeatReader {
    readonly readHeartbeatProjection: () => OpenClawCronHeartbeatProjection;
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

function isGlobalInventory(input: ListOpenClawCronInput): boolean {
    return (
        input.enabled === "all" &&
        input.lastRunStatus === "all" &&
        input.offset === 0 &&
        input.query === undefined &&
        input.scheduleKind === "all"
    );
}

function pendingSyncState(
    result: ListOpenClawCronResult
): "none" | "present" | "unknown" {
    if (
        result.jobs.some(({ synchronization }) => synchronization.state !== "confirmed")
    ) {
        return "present";
    }
    return result.hasMore ? "unknown" : "none";
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
    let heartbeatProjection: OpenClawCronHeartbeatProjection = Object.freeze({
        pendingSync: "unknown",
        state: "unavailable",
    });
    let nextHeartbeatProjectionGeneration = 0;
    let committedHeartbeatProjectionGeneration = 0;

    function rememberHeartbeatProjection(
        result: ListOpenClawCronResult,
        generation: number
    ): void {
        if (generation < committedHeartbeatProjectionGeneration) return;
        committedHeartbeatProjectionGeneration = generation;
        const shared = {
            count: result.total,
            observedAtMs: result.freshness.observedAtMs,
            pendingSync: pendingSyncState(result),
        };
        heartbeatProjection =
            result.freshness.kind === "fresh"
                ? Object.freeze({ ...shared, state: "fresh" })
                : Object.freeze({
                      ...shared,
                      staleSinceMs: result.freshness.staleSinceMs,
                      state: "last-known-good",
                  });
    }

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
        committedHeartbeatProjectionGeneration = nextHeartbeatProjectionGeneration += 1;
        markHeartbeatProjectionStale(undefined, pendingSync);
        return new OpenClawCronServiceError("unknown-outcome", { cause, id });
    }

    function readHeartbeatProjection(): OpenClawCronHeartbeatProjection {
        return heartbeatProjection;
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

    function invalidateInventory(): void {
        listCache.clear();
        committedHeartbeatProjectionGeneration = nextHeartbeatProjectionGeneration += 1;
        markHeartbeatProjectionStale();
    }

    async function list(
        input: ListOpenClawCronInput,
        signal?: AbortSignal
    ): Promise<ListOpenClawCronResult> {
        const parsed = parseInput(listOpenClawCronInputSchema, input);
        const key = listCacheKey(parsed);
        const heartbeatGeneration = isGlobalInventory(parsed)
            ? (nextHeartbeatProjectionGeneration += 1)
            : undefined;
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
            if (heartbeatGeneration !== undefined) {
                rememberHeartbeatProjection(result, heartbeatGeneration);
            }
            return result;
        } catch (error) {
            if (signal?.aborted) throw error;
            const cached = listCache.get(key);
            if (cached === undefined) {
                if (heartbeatGeneration !== undefined) {
                    markHeartbeatProjectionStale();
                }
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
            if (heartbeatGeneration !== undefined) {
                rememberHeartbeatProjection(result, heartbeatGeneration);
            }
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
        markHeartbeatProjectionStale(checkedAtMs, "present");
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
                    markHeartbeatProjectionStale(
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
            getCache.delete(parsed.id);
            for (const key of runsCache.keys()) {
                const decoded = JSON.parse(key) as readonly unknown[];
                if (decoded[0] === parsed.id) runsCache.delete(key);
            }
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
        get,
        list,
        listRuns,
        readHeartbeatProjection,
        reconcileExpired,
        run: auditedRun,
        setEnabled: auditedSetEnabled,
        update: auditedUpdate,
    });
}
