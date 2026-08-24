import { addMilliseconds, subMilliseconds } from "date-fns";
import { Effect } from "effect";
import * as v from "valibot";

import {
    type JobRunResult,
    jobPayloadSchema,
    jobRunResultSchema,
    jobWorkerFreshnessMs,
} from "../../../contracts/jobModel.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    type JobActionDefinition,
    type JobActionEventWriteResult,
    type JobActionRegistration,
    type JobCacheAttemptCommit,
    type JobCacheAttemptWriteResult,
    JobActionRetryableError,
    jobActionDefinitions,
    parseJobActionOutputMessage,
    parseJobActionProgress,
} from "./actionRegistry.ts";
import type { JobRunRecord, ScheduledJobRecord } from "./records.ts";
import { toScheduleConfiguration } from "./records.ts";
import { buildRegisteredSchedule } from "./registeredSchedule.ts";
import {
    type ClaimNextRunInput,
    type JobMutationSideEffects,
    type JobClaimOutcome,
    type JobRepository,
    type JobRunInsert,
    type ListDueSchedulesInput,
    type ScheduledJobInsert,
    type WorkerLifecycleResult,
    type WorkerInstanceInsert,
} from "./repository.ts";
import { nextScheduleOccurrence } from "./scheduleTime.ts";

export const jobWorkerCapacity = 1;
export const jobWorkerHeartbeatIntervalMs = 10_000;
export const jobClaimLeaseMs = 120_000;
export const jobClaimRenewalIntervalMs = 30_000;
export const jobClaimCancellationPollIntervalMs = 1000;
export const jobWorkerIdlePollIntervalMs = 1000;
export const jobWorkerForceDrainMs = 5000;
export const jobSchedulePollIntervalMs = 1000;
export const jobSchedulePollLimit = 32;
export const jobSchedulePollScanLimit = jobSchedulePollLimit * 8;
export const jobDisableIntentExpiryLimit = 32;
export const jobExpiredClaimRecoveryLimit = 32;

type JobWorkerRepository = Pick<
    JobRepository,
    | "appendClaimEvent"
    | "beginWorkerDrain"
    | "claimNextRun"
    | "enqueueNextDueSchedule"
    | "expireDisableIntents"
    | "heartbeatWorker"
    | "listDueSchedules"
    | "readClaimCancellation"
    | "reconcileSchedules"
    | "recoverExpiredClaims"
    | "registerWorker"
    | "renewClaim"
    | "settleClaim"
    | "stopWorker"
>;

export type JobWorkerMutationOutcome = "accepted" | "cancelled" | "failed" | "succeeded";

export interface JobWorkerSideEffectInput {
    readonly action: string;
    readonly at: Date;
    readonly outcome: JobWorkerMutationOutcome;
    readonly targetId: string;
}

/** Required atomic audit/realtime rows for worker-owned durable mutations. */
export interface JobWorkerSideEffectFactory {
    forQueue(input: JobWorkerSideEffectInput): JobMutationSideEffects;
    forRun(input: JobWorkerSideEffectInput): JobMutationSideEffects;
    forRunEvent(input: JobWorkerSideEffectInput): JobMutationSideEffects;
    forSchedule(input: JobWorkerSideEffectInput): JobMutationSideEffects;
    forScheduleEvent(input: JobWorkerSideEffectInput): JobMutationSideEffects;
}

export interface JobWorkerCoordinatorTimings {
    readonly cancellationPollMs: number;
    readonly claimLeaseMs: number;
    readonly claimRenewalMs: number;
    readonly heartbeatMs: number;
    readonly idlePollMs: number;
    readonly forceDrainMs: number;
    readonly schedulePollMs: number;
    readonly workerFreshnessMs: number;
}

export interface JobWorkerCoordinatorOptions {
    readonly actionDefinitions?: readonly JobActionDefinition[];
    readonly databaseReleaseId: string;
    readonly commitCacheAttempt?: (input: {
        readonly at: Date;
        readonly attempt: number;
        readonly leaseToken: string;
        readonly outcome: JobCacheAttemptCommit;
        readonly runId: string;
        readonly workerId: string;
    }) => Promise<JobCacheAttemptWriteResult>;
    readonly findAction?: (actionKey: string) => JobActionRegistration | undefined;
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly pid: number;
    readonly repository: JobWorkerRepository;
    readonly sideEffects: JobWorkerSideEffectFactory;
    readonly timings?: Partial<JobWorkerCoordinatorTimings>;
    readonly workerInstanceId: string;
}

/** Process-owned lifecycle for one single-capacity durable job coordinator. */
export interface JobWorkerCoordinator {
    readonly completion: Promise<void>;
    dispose(forceSignal?: AbortSignal): Promise<void>;
    initialize(): Promise<void>;
}

class JobClaimLostError extends Error {
    constructor() {
        super("Durable job claim was lost");
        this.name = "JobClaimLostError";
    }
}

class JobActionCancelledError extends Error {
    constructor() {
        super("Durable job cancellation was requested");
        this.name = "JobActionCancelledError";
    }
}

class JobActionTimedOutError extends Error {
    constructor() {
        super("Durable job action timed out");
        this.name = "JobActionTimedOutError";
    }
}

class JobCoordinatorShutdownError extends Error {
    constructor() {
        super("Durable job worker is shutting down");
        this.name = "JobCoordinatorShutdownError";
    }
}

class JobActionFinishedError extends Error {
    constructor() {
        super("Durable job action finished");
        this.name = "JobActionFinishedError";
    }
}

function findNoAction(_actionKey: string): JobActionRegistration | undefined {
    return;
}

const defaultTimings: JobWorkerCoordinatorTimings = Object.freeze({
    cancellationPollMs: jobClaimCancellationPollIntervalMs,
    claimLeaseMs: jobClaimLeaseMs,
    claimRenewalMs: jobClaimRenewalIntervalMs,
    heartbeatMs: jobWorkerHeartbeatIntervalMs,
    idlePollMs: jobWorkerIdlePollIntervalMs,
    forceDrainMs: jobWorkerForceDrainMs,
    schedulePollMs: jobSchedulePollIntervalMs,
    workerFreshnessMs: jobWorkerFreshnessMs,
});

function parsePositiveDuration(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} is invalid`);
    }
    return value;
}

function resolveTimings(
    input: Partial<JobWorkerCoordinatorTimings> | undefined
): JobWorkerCoordinatorTimings {
    const values = { ...defaultTimings, ...input };
    return Object.freeze({
        cancellationPollMs: parsePositiveDuration(
            values.cancellationPollMs,
            "Job cancellation polling interval"
        ),
        claimLeaseMs: parsePositiveDuration(values.claimLeaseMs, "Job claim lease"),
        claimRenewalMs: parsePositiveDuration(
            values.claimRenewalMs,
            "Job claim renewal interval"
        ),
        heartbeatMs: parsePositiveDuration(
            values.heartbeatMs,
            "Job worker heartbeat interval"
        ),
        idlePollMs: parsePositiveDuration(
            values.idlePollMs,
            "Job worker idle polling interval"
        ),
        forceDrainMs: parsePositiveDuration(
            values.forceDrainMs,
            "Job worker forced-drain timeout"
        ),
        schedulePollMs: parsePositiveDuration(
            values.schedulePollMs,
            "Job schedule polling interval"
        ),
        workerFreshnessMs: parsePositiveDuration(
            values.workerFreshnessMs,
            "Job worker freshness window"
        ),
    });
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
        return Promise.reject(
            signal.reason instanceof Error
                ? signal.reason
                : new JobCoordinatorShutdownError()
        );
    }
    return new Promise((resolve, reject) => {
        const finish = (): void => {
            signal?.removeEventListener("abort", abort);
            resolve();
        };
        const timeout = setTimeout(finish, milliseconds);
        const abort = (): void => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            reject(
                signal?.reason instanceof Error
                    ? signal.reason
                    : new JobCoordinatorShutdownError()
            );
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new JobCoordinatorShutdownError();
}

function mergeSideEffects(
    effects: readonly JobMutationSideEffects[]
): JobMutationSideEffects {
    return Object.freeze({
        auditEvents: Object.freeze(effects.flatMap((effect) => effect.auditEvents)),
        realtimeEvents: Object.freeze(effects.flatMap((effect) => effect.realtimeEvents)),
    });
}

function settlementMutationOutcome(run: JobRunRecord): JobWorkerMutationOutcome {
    if (run.state === "cancelled") return "cancelled";
    if (run.state === "succeeded") return "succeeded";
    return "failed";
}

function durableRunTransitionSideEffects(
    factory: JobWorkerSideEffectFactory,
    requestedAction: string,
    settled: JobRunRecord
): JobMutationSideEffects {
    const outcome = settlementMutationOutcome(settled);
    const action = settled.state === "cancelled" ? "jobs.run.cancelled" : requestedAction;
    return mergeSideEffects([
        factory.forRun({
            action,
            at: settled.updatedAt,
            outcome,
            targetId: settled.id,
        }),
        ...(settled.scheduledJobId === null
            ? []
            : [
                  factory.forScheduleEvent({
                      action,
                      at: settled.updatedAt,
                      outcome,
                      targetId: settled.scheduledJobId,
                  }),
              ]),
    ]);
}

function durableRunEventSideEffects(
    factory: JobWorkerSideEffectFactory,
    action: string,
    run: JobRunRecord
): JobMutationSideEffects {
    return mergeSideEffects([
        factory.forRunEvent({
            action,
            at: run.updatedAt,
            outcome: "accepted",
            targetId: run.id,
        }),
        ...(run.scheduledJobId === null
            ? []
            : [
                  factory.forScheduleEvent({
                      action,
                      at: run.updatedAt,
                      outcome: "accepted",
                      targetId: run.scheduledJobId,
                  }),
              ]),
    ]);
}

function scheduleInsert(registration: JobActionDefinition, at: Date): ScheduledJobInsert {
    const schedule = buildRegisteredSchedule(registration, at);
    if (schedule === undefined) {
        throw new RangeError("Default job schedule has no representable occurrence");
    }
    return schedule;
}

function scheduledRunIdentity(
    scheduleId: string,
    scheduledForAtMs: number
): {
    readonly enqueueSha256: string;
    readonly idempotencyKey: string;
} {
    const idempotencySource =
        `mira-dashboard:schedules.run:scheduled:v1:${scheduleId}:` +
        String(scheduledForAtMs);
    const enqueueSource = JSON.stringify({
        procedure: "schedules.run",
        scheduleId,
        scheduledForAtMs,
        triggerType: "schedule",
        version: 1,
    });
    return Object.freeze({
        enqueueSha256: sha256Hex(enqueueSource),
        idempotencyKey: sha256Hex(idempotencySource),
    });
}

function scheduledRunInsert(
    schedule: ScheduledJobRecord,
    at: Date,
    generateId: () => string
): JobRunInsert {
    if (schedule.nextRunAt === null) {
        throw new Error("Due schedule is missing its durable cursor");
    }
    const identity = scheduledRunIdentity(schedule.id, schedule.nextRunAt.getTime());
    return {
        actionKey: schedule.actionKey,
        attemptLimit: schedule.attemptLimit,
        availableAt: at,
        cancellationPolicy: schedule.cancellationPolicy,
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: schedule.name,
        enqueueSha256: identity.enqueueSha256,
        finishedAt: null,
        firstStartedAt: null,
        heartbeatAt: null,
        id: generateId(),
        idempotencyKey: identity.idempotencyKey,
        lastAttemptStartedAt: null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadJson: schedule.actionPayloadJson,
        priority: schedule.priority,
        queuedAt: at,
        requestedById: "system.scheduler",
        requestedByKind: "system",
        resourceClass: schedule.resourceClass,
        resourceKeysJson: schedule.resourceKeysJson,
        resultJson: null,
        retrySafe: schedule.retrySafe,
        scheduledForAt: schedule.nextRunAt,
        scheduledJobId: schedule.id,
        scheduledJobVersion: schedule.version,
        state: "queued",
        terminalCode: null,
        terminalMessage: null,
        timeoutMs: schedule.timeoutMs,
        triggerType: "schedule",
        updatedAt: at,
    };
}

/**
 * Capped retry delay after one already-recorded failed attempt.
 * @param attemptCount Current positive durable attempt count.
 * @returns Delay before another retry-safe claim.
 */
export function jobRetryDelayMs(attemptCount: number): number {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
        throw new RangeError("Job attempt count is invalid");
    }
    return Math.min(60_000, 1000 * 2 ** Math.min(attemptCount - 1, 16));
}

function retryAt(run: JobRunRecord, at: Date): Date {
    return addMilliseconds(at, jobRetryDelayMs(run.attemptCount));
}

function actionFailureOutcome(
    run: JobRunRecord,
    at: Date,
    retryable: boolean,
    terminalCode: string,
    terminalMessage: string
) {
    return {
        kind: "failed" as const,
        ...(retryable && run.retrySafe && run.attemptCount < run.attemptLimit
            ? { retryAt: retryAt(run, at) }
            : {}),
        terminalCode,
        terminalMessage,
    };
}

function executionOutcome(
    run: JobRunRecord,
    at: Date,
    result: JobRunResult | undefined,
    abortReason: unknown,
    actionFailure: unknown
): JobClaimOutcome {
    if (result !== undefined) {
        return { kind: "succeeded", resultJson: JSON.stringify(result) };
    }
    if (abortReason instanceof JobActionTimedOutError) {
        return {
            kind: "timed-out",
            terminalCode: "action-timeout",
            terminalMessage: "The job action exceeded its execution timeout.",
        };
    }
    if (abortReason instanceof JobActionCancelledError) {
        return {
            kind: "cancelled",
            terminalCode: "cancel-requested",
            terminalMessage: "The job action was cancelled.",
        };
    }
    const shutdown = abortReason instanceof JobCoordinatorShutdownError;
    return actionFailureOutcome(
        run,
        at,
        shutdown || actionFailure instanceof JobActionRetryableError,
        shutdown ? "worker-shutdown" : "action-failed",
        shutdown
            ? "The worker stopped before the action completed."
            : "The job action failed."
    );
}

function normalizeCoordinatorFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error("Durable job coordinator failed", { cause: error });
}

function workerReachedState(
    result: WorkerLifecycleResult,
    state: "draining" | "stopped"
): boolean {
    return (
        (result.kind === "updated" || result.kind === "state-changed") &&
        result.worker.state === state
    );
}

async function waitForActiveExecution(
    execution: Promise<void>,
    forceSignal: AbortSignal | undefined,
    forceDrainMs: number
): Promise<void> {
    if (forceSignal === undefined) {
        await execution;
        return;
    }
    if (!forceSignal.aborted) {
        let requestForce: (() => void) | undefined;
        const forced = new Promise<"forced">((resolve) => {
            requestForce = () => resolve("forced");
        });
        const onForce = (): void => requestForce?.();
        forceSignal.addEventListener("abort", onForce, { once: true });
        try {
            const result = await Promise.race([
                execution.then(() => "completed" as const),
                forced,
            ]);
            if (result === "completed") return;
        } finally {
            forceSignal.removeEventListener("abort", onForce);
        }
    }
    const drainController = new AbortController();
    try {
        await Promise.race([
            execution,
            waitFor(forceDrainMs, drainController.signal).then(() => {
                throw new Error("Durable job action exceeded forced-drain timeout");
            }),
        ]);
    } finally {
        drainController.abort(new JobCoordinatorShutdownError());
    }
}

interface ExecuteClaimOptions {
    readonly commitCacheAttempt: JobWorkerCoordinatorOptions["commitCacheAttempt"];
    readonly databaseReleaseId: string;
    readonly findAction: (actionKey: string) => JobActionRegistration | undefined;
    readonly lifecycleSignal: AbortSignal;
    readonly nowMs: () => number;
    readonly repository: JobWorkerRepository;
    readonly run: JobRunRecord;
    readonly sideEffects: JobWorkerSideEffectFactory;
    readonly timings: JobWorkerCoordinatorTimings;
    readonly workerInstanceId: string;
}

async function executeClaim(options: ExecuteClaimOptions): Promise<void> {
    const run = options.run;
    const leaseToken = run.leaseToken;
    const claimHeartbeatAtMs = run.heartbeatAt?.getTime();
    if (
        leaseToken === null ||
        claimHeartbeatAtMs === undefined ||
        run.leaseOwnerId !== options.workerInstanceId
    ) {
        throw new JobClaimLostError();
    }
    const registration = options.findAction(run.actionKey);
    if (registration === undefined) {
        const at = new Date(options.nowMs());
        const outcome = {
            kind: "failed",
            terminalCode: "action-unavailable",
            terminalMessage: "This release does not implement the queued action.",
        } as const satisfies JobClaimOutcome;
        await options.repository.settleClaim({
            at,
            leaseToken,
            outcome,
            runId: run.id,
            sideEffectsForRun: (settled) =>
                durableRunTransitionSideEffects(
                    options.sideEffects,
                    "jobs.run.action-unavailable",
                    settled
                ),
            workerId: options.workerInstanceId,
        });
        return;
    }

    const actionController = new AbortController();
    let monitorFailure: unknown;
    const stopAction = (reason: unknown): void => {
        if (!actionController.signal.aborted) actionController.abort(reason);
    };
    const lifecycleAbort = (): void => stopAction(new JobCoordinatorShutdownError());
    options.lifecycleSignal.addEventListener("abort", lifecycleAbort, { once: true });
    if (options.lifecycleSignal.aborted) lifecycleAbort();
    const timeout = setTimeout(
        () => stopAction(new JobActionTimedOutError()),
        run.timeoutMs
    );

    const monitor = async (): Promise<void> => {
        let renewalDueAt = claimHeartbeatAtMs + options.timings.claimRenewalMs;
        while (!actionController.signal.aborted) {
            await waitFor(options.timings.cancellationPollMs, actionController.signal);
            if (actionController.signal.aborted) return;
            try {
                const at = new Date(options.nowMs());
                const cancellation = options.repository.readClaimCancellation({
                    at,
                    leaseToken,
                    runId: run.id,
                    workerId: options.workerInstanceId,
                });
                if (!cancellation.valid) {
                    stopAction(new JobClaimLostError());
                    return;
                }
                if (cancellation.cancelRequested) {
                    stopAction(new JobActionCancelledError());
                    return;
                }
                if (at.getTime() < renewalDueAt) continue;
                const renewal = await options.repository.renewClaim({
                    at,
                    leaseExpiresAt: addMilliseconds(at, options.timings.claimLeaseMs),
                    leaseToken,
                    runId: run.id,
                    workerId: options.workerInstanceId,
                });
                if (renewal.kind === "lost-claim") {
                    stopAction(new JobClaimLostError());
                    return;
                }
                renewalDueAt = at.getTime() + options.timings.claimRenewalMs;
            } catch (error) {
                monitorFailure = error;
                stopAction(error);
                return;
            }
        }
    };

    const appendEvent = async (
        kind: "progress" | "stderr" | "stdout",
        value: JsonObject | string
    ): Promise<JobActionEventWriteResult> => {
        const at = new Date(options.nowMs());
        const result = await options.repository.appendClaimEvent({
            at,
            kind,
            leaseToken,
            ...(kind === "progress"
                ? {
                      progressJson: JSON.stringify(
                          parseJobActionProgress(value as JsonObject)
                      ),
                  }
                : { message: parseJobActionOutputMessage(value as string) }),
            runId: run.id,
            sideEffectsForRun: (updatedRun) =>
                durableRunEventSideEffects(
                    options.sideEffects,
                    "jobs.run.event",
                    updatedRun
                ),
            workerId: options.workerInstanceId,
        });
        if (result.kind === "lost-claim") throw new JobClaimLostError();
        return result.kind;
    };

    let parsedActionPayload: JsonObject | undefined;
    const action = Effect.suspend(() => {
        parsedActionPayload = v.parse(jobPayloadSchema, parseJsonText(run.payloadJson));
        return registration.execute(
            Object.freeze({
                commitCacheAttempt: async (outcome: JobCacheAttemptCommit) => {
                    if (
                        registration.manualExposure !== "cache-write" ||
                        options.commitCacheAttempt === undefined
                    ) {
                        throw new Error("Cache attempt persistence is unavailable");
                    }
                    const result = await options.commitCacheAttempt({
                        at: new Date(options.nowMs()),
                        attempt: run.attemptCount,
                        leaseToken,
                        outcome,
                        runId: run.id,
                        workerId: options.workerInstanceId,
                    });
                    if (result === "lost-claim") throw new JobClaimLostError();
                    return result;
                },
                databaseReleaseId: options.databaseReleaseId,
                nowMs: options.nowMs,
                reportProgress: (progress: JsonObject) =>
                    Effect.tryPromise(() => appendEvent("progress", progress)),
                workerInstanceId: options.workerInstanceId,
                writeOutput: (kind: "stderr" | "stdout", message: string) =>
                    Effect.tryPromise(() => appendEvent(kind, message)),
            }),
            parsedActionPayload
        );
    });
    const monitorPromise = monitor().catch((error: unknown) => {
        if (!actionController.signal.aborted) {
            monitorFailure = error;
            stopAction(error);
        }
    });

    let result: JobRunResult | undefined;
    let actionFailure: unknown;
    try {
        result = v.parse(
            jobRunResultSchema,
            await Effect.runPromise(action, { signal: actionController.signal })
        );
    } catch (error) {
        // The public settlement below deliberately redacts action defects.
        actionFailure = error;
    } finally {
        clearTimeout(timeout);
        options.lifecycleSignal.removeEventListener("abort", lifecycleAbort);
        stopAction(new JobActionFinishedError());
        await monitorPromise;
    }

    if (monitorFailure !== undefined) {
        throw monitorFailure instanceof Error
            ? monitorFailure
            : new Error("Durable job claim monitor failed", {
                  cause: monitorFailure,
              });
    }
    const abortReason: unknown = actionController.signal.reason;
    if (abortReason instanceof JobClaimLostError) return;
    const at = new Date(options.nowMs());
    const outcome = executionOutcome(run, at, result, abortReason, actionFailure);
    const settlement = await options.repository.settleClaim({
        at,
        leaseToken,
        outcome,
        runId: run.id,
        sideEffectsForRun: (settled) =>
            durableRunTransitionSideEffects(
                options.sideEffects,
                `jobs.run.${outcome.kind}`,
                settled
            ),
        workerId: options.workerInstanceId,
    });
    if (
        settlement.kind === "settled" &&
        settlement.run.state === "succeeded" &&
        registration.afterSuccessfulSettlement !== undefined
    ) {
        if (parsedActionPayload === undefined) {
            throw new Error("Successful job action payload was not retained");
        }
        await registration.afterSuccessfulSettlement(parsedActionPayload);
    }
}

/**
 * Creates the Effect-owned coordinator for schedule polling, claims, and execution.
 * @param options Repository, action registry, clock, and process identity.
 * @returns Idempotent process lifecycle with an observable unexpected-failure promise.
 */
export function createJobWorkerCoordinator(
    options: JobWorkerCoordinatorOptions
): JobWorkerCoordinator {
    const timings = resolveTimings(options.timings);
    const nowMs = options.nowMs ?? Date.now;
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const findAction = options.findAction ?? findNoAction;
    const actionDefinitions = options.actionDefinitions ?? jobActionDefinitions;
    const abortController = new AbortController();
    let activeExecution: Promise<void> | undefined;
    let initializePromise: Promise<void> | undefined;
    let disposePromise: Promise<void> | undefined;
    let programPromise: Promise<void> | undefined;
    let claimCursor: ClaimNextRunInput["cursor"];
    let dueScheduleAvailableThrough: Date | undefined;
    let dueScheduleCursor: ListDueSchedulesInput["cursor"];
    const activePasses = {
        claim: new Set<Promise<unknown>>(),
        heartbeat: new Set<Promise<unknown>>(),
        schedule: new Set<Promise<unknown>>(),
    };
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    const trackPass = <T>(
        kind: keyof typeof activePasses,
        operation: () => Promise<T>
    ): Promise<T> => {
        const execution = operation();
        activePasses[kind].add(execution);
        void execution.then(
            () => activePasses[kind].delete(execution),
            () => activePasses[kind].delete(execution)
        );
        return execution;
    };

    const heartbeatPass = async (signal: AbortSignal): Promise<void> => {
        throwIfAborted(signal);
        const worker = await options.repository.heartbeatWorker({
            at: new Date(nowMs()),
            workerId: options.workerInstanceId,
        });
        throwIfAborted(signal);
        if (worker === undefined) throw new Error("Job worker registration was lost");
    };
    const heartbeatLoop = Effect.tryPromise({
        catch: (error) => error,
        try: (signal) => trackPass("heartbeat", () => heartbeatPass(signal)),
    }).pipe(Effect.andThen(Effect.sleep(timings.heartbeatMs)), Effect.forever);

    const schedulePass = async (signal: AbortSignal): Promise<void> => {
        throwIfAborted(signal);
        const at = new Date(nowMs());
        const expired = await options.repository.expireDisableIntents({
            at,
            canReenableSchedule: (schedule) =>
                findAction(schedule.actionKey)?.scheduleId === schedule.id,
            limit: jobDisableIntentExpiryLimit,
            nextRunAt: (schedule, after) => {
                const next = nextScheduleOccurrence(
                    toScheduleConfiguration(schedule),
                    after.getTime(),
                    (schedule.nextRunAt ?? schedule.createdAt).getTime()
                );
                return next === undefined ? undefined : new Date(next);
            },
            sideEffectsForSchedule: (schedule, intent) =>
                options.sideEffects.forSchedule({
                    action: "schedules.disable-intent-expired",
                    at: intent.endedAt ?? schedule.updatedAt,
                    outcome: "accepted",
                    targetId: schedule.id,
                }),
            systemActorId: "system.jobs-worker",
        });
        throwIfAborted(signal);
        const leftDisabledScheduleIds = new Set<string>();
        for (const result of expired) {
            switch (result.kind) {
                case "left-disabled": {
                    if (result.schedule.enabled) {
                        throw new Error(
                            "Retired schedule was enabled after disable-intent expiry"
                        );
                    }
                    leftDisabledScheduleIds.add(result.schedule.id);
                    break;
                }
                case "next-occurrence-unavailable": {
                    throw new RangeError(
                        "Expired disable intent has no representable next occurrence"
                    );
                }
                case "re-enabled": {
                    if (!result.schedule.enabled) {
                        throw new Error(
                            "Registered schedule remained disabled after disable-intent expiry"
                        );
                    }
                    break;
                }
                default: {
                    result satisfies never;
                }
            }
        }
        let enqueuedScheduleCount = 0;
        let scannedScheduleCount = 0;
        const availableThrough =
            dueScheduleCursor === undefined ? at : (dueScheduleAvailableThrough ?? at);
        dueScheduleAvailableThrough = availableThrough;
        const effectiveAt = new Date(Math.max(at.getTime(), availableThrough.getTime()));
        while (
            enqueuedScheduleCount < jobSchedulePollLimit &&
            scannedScheduleCount < jobSchedulePollScanLimit
        ) {
            throwIfAborted(signal);
            const pageLimit = Math.min(
                jobSchedulePollLimit,
                jobSchedulePollScanLimit - scannedScheduleCount
            );
            const schedules = options.repository.listDueSchedules({
                at: availableThrough,
                ...(dueScheduleCursor === undefined ? {} : { cursor: dueScheduleCursor }),
                limit: pageLimit,
            });
            if (schedules.length === 0) {
                dueScheduleAvailableThrough = undefined;
                dueScheduleCursor = undefined;
                break;
            }
            for (const schedule of schedules) {
                throwIfAborted(signal);
                if (schedule.nextRunAt === null) {
                    throw new Error("Due schedule is missing its keyset cursor");
                }
                const cursor = {
                    id: schedule.id,
                    nextRunAt: schedule.nextRunAt,
                } as const;
                if (!leftDisabledScheduleIds.has(schedule.id)) {
                    const nextRunAtMs = nextScheduleOccurrence(
                        toScheduleConfiguration(schedule),
                        effectiveAt.getTime(),
                        schedule.nextRunAt.getTime()
                    );
                    if (nextRunAtMs === undefined) {
                        throw new RangeError(
                            "Due schedule has no representable next occurrence"
                        );
                    }
                    const run = scheduledRunInsert(schedule, effectiveAt, generateId);
                    const sideEffects = mergeSideEffects([
                        options.sideEffects.forSchedule({
                            action: "schedules.enqueue-due",
                            at: effectiveAt,
                            outcome: "accepted",
                            targetId: schedule.id,
                        }),
                        options.sideEffects.forRun({
                            action: "jobs.run.enqueue-scheduled",
                            at: effectiveAt,
                            outcome: "accepted",
                            targetId: run.id,
                        }),
                    ]);
                    const result = await options.repository.enqueueNextDueSchedule({
                        ...sideEffects,
                        at: effectiveAt,
                        nextRunAt: new Date(nextRunAtMs),
                        observedNextRunAt: schedule.nextRunAt,
                        run,
                        scheduleId: schedule.id,
                    });
                    if (result.kind === "inserted") enqueuedScheduleCount += 1;
                    throwIfAborted(signal);
                }
                dueScheduleCursor = cursor;
                scannedScheduleCount += 1;
                if (enqueuedScheduleCount >= jobSchedulePollLimit) return;
            }
            if (schedules.length < pageLimit) {
                dueScheduleAvailableThrough = undefined;
                dueScheduleCursor = undefined;
                break;
            }
        }
    };
    const scheduleLoop = Effect.tryPromise({
        catch: (error) => error,
        try: (signal) => trackPass("schedule", () => schedulePass(signal)),
    }).pipe(Effect.andThen(Effect.sleep(timings.schedulePollMs)), Effect.forever);

    const claimPass = async (signal: AbortSignal): Promise<void> => {
        const at = new Date(nowMs());
        await options.repository.recoverExpiredClaims({
            at,
            limit: jobExpiredClaimRecoveryLimit,
            retryAt: (run) => retryAt(run, at),
            sideEffectsForRun: (run) =>
                durableRunTransitionSideEffects(
                    options.sideEffects,
                    "jobs.run.lease-expired",
                    run
                ),
        });
        throwIfAborted(signal);
        const leaseToken = generateId();
        const claim = await options.repository.claimNextRun({
            at,
            ...(claimCursor === undefined ? {} : { cursor: claimCursor }),
            leaseExpiresAt: addMilliseconds(at, timings.claimLeaseMs),
            leaseToken,
            minimumHeartbeatAt: subMilliseconds(at, timings.workerFreshnessMs),
            sideEffectsForClaim: (run) =>
                mergeSideEffects([
                    options.sideEffects.forQueue({
                        action: "jobs.run.claim",
                        at: run.updatedAt,
                        outcome: "accepted",
                        targetId: options.workerInstanceId,
                    }),
                    durableRunEventSideEffects(
                        options.sideEffects,
                        "jobs.run.claim",
                        run
                    ),
                ]),
            workerId: options.workerInstanceId,
        });
        if (claim.kind === "page-exhausted") {
            claimCursor = claim.cursor;
            throwIfAborted(signal);
            return;
        }
        claimCursor = undefined;
        if (claim.kind !== "claimed") {
            throwIfAborted(signal);
            if (claim.kind === "worker-unavailable") {
                throw new Error("Job worker cannot claim durable work");
            }
            await waitFor(timings.idlePollMs, signal);
            return;
        }
        if (signal.aborted) {
            const shutdownAt = new Date(nowMs());
            const outcome = actionFailureOutcome(
                claim.run,
                shutdownAt,
                true,
                "worker-shutdown",
                "The worker stopped before the action completed."
            );
            await options.repository.settleClaim({
                at: shutdownAt,
                leaseToken,
                outcome,
                runId: claim.run.id,
                sideEffectsForRun: (settled) =>
                    durableRunTransitionSideEffects(
                        options.sideEffects,
                        `jobs.run.${outcome.kind}`,
                        settled
                    ),
                workerId: options.workerInstanceId,
            });
            return;
        }
        activeExecution = executeClaim({
            commitCacheAttempt: options.commitCacheAttempt,
            databaseReleaseId: options.databaseReleaseId,
            findAction,
            lifecycleSignal: signal,
            nowMs,
            repository: options.repository,
            run: claim.run,
            sideEffects: options.sideEffects,
            timings,
            workerInstanceId: options.workerInstanceId,
        });
        try {
            await activeExecution;
        } finally {
            activeExecution = undefined;
        }
    };
    const claimLoop = Effect.tryPromise({
        catch: (error) => error,
        try: (signal) => trackPass("claim", () => claimPass(signal)),
    }).pipe(Effect.forever);

    const program = Effect.all([heartbeatLoop, scheduleLoop, claimLoop], {
        concurrency: "unbounded",
        discard: true,
    });

    const initialize = async (): Promise<void> => {
        const at = new Date(nowMs());
        const schedules = actionDefinitions.map((definition) =>
            scheduleInsert(definition, at)
        );
        await options.repository.reconcileSchedules({
            at,
            retiredRunCancellation: {
                actor: { id: "system.jobs-worker", kind: "system" },
                sideEffectsForRun: (run) =>
                    durableRunTransitionSideEffects(
                        options.sideEffects,
                        "jobs.run.cancelled",
                        run
                    ),
                terminalCode: "cancelled/schedule-retired",
                terminalMessage:
                    "Cancelled because the schedule was retired from the action registry",
            },
            schedules,
            sideEffectsForSchedule: (schedule) =>
                options.sideEffects.forSchedule({
                    action: "schedules.reconcile",
                    at: schedule.updatedAt,
                    outcome: "accepted",
                    targetId: schedule.id,
                }),
        });
        const worker: WorkerInstanceInsert = {
            capacity: jobWorkerCapacity,
            drainingAt: null,
            heartbeatAt: at,
            id: options.workerInstanceId,
            pid: options.pid,
            releaseId: options.databaseReleaseId,
            startedAt: at,
            state: "online",
            stoppedAt: null,
        };
        await options.repository.registerWorker({
            ...options.sideEffects.forQueue({
                action: "jobs.worker.register",
                at,
                outcome: "accepted",
                targetId: options.workerInstanceId,
            }),
            worker,
        });
        programPromise = Effect.runPromise(program, {
            signal: abortController.signal,
        });
        void programPromise.then(
            () => {
                if (disposePromise === undefined) {
                    rejectCompletion?.(
                        new Error("Durable job coordinator stopped unexpectedly")
                    );
                } else {
                    resolveCompletion?.();
                }
                return;
            },
            (error: unknown) => {
                if (disposePromise === undefined) rejectCompletion?.(error);
                else resolveCompletion?.();
                return;
            }
        );
    };

    const dispose = async (forceSignal?: AbortSignal): Promise<void> => {
        if (initializePromise === undefined) {
            abortController.abort(new JobCoordinatorShutdownError());
            resolveCompletion?.();
            return;
        }
        try {
            await initializePromise;
        } catch (error) {
            abortController.abort(new JobCoordinatorShutdownError());
            throw normalizeCoordinatorFailure(error);
        }
        let failure: Error | undefined;
        const drainingAt = new Date(nowMs());
        try {
            const result = await options.repository.beginWorkerDrain({
                at: drainingAt,
                sideEffectsForWorker: (worker) =>
                    options.sideEffects.forQueue({
                        action: "jobs.worker.drain",
                        at: worker.heartbeatAt,
                        outcome: "accepted",
                        targetId: worker.id,
                    }),
                workerId: options.workerInstanceId,
            });
            if (!workerReachedState(result, "draining")) {
                throw new Error("Durable job worker could not enter draining state");
            }
        } catch (error) {
            failure = normalizeCoordinatorFailure(error);
        }
        abortController.abort(new JobCoordinatorShutdownError());
        let activeExecutionDrained = true;
        if (activeExecution !== undefined) {
            try {
                await waitForActiveExecution(
                    activeExecution,
                    forceSignal,
                    timings.forceDrainMs
                );
            } catch (error) {
                activeExecutionDrained = false;
                failure ??= normalizeCoordinatorFailure(error);
            }
        }
        if (activeExecutionDrained && programPromise !== undefined) {
            await programPromise.catch(() => {});
        }
        const passes = [
            ...activePasses.heartbeat,
            ...activePasses.schedule,
            ...(activeExecutionDrained ? activePasses.claim : []),
        ];
        if (passes.length > 0) await Promise.allSettled(passes);
        const stoppedAt = new Date(nowMs());
        try {
            const result = await options.repository.stopWorker({
                at: stoppedAt,
                sideEffectsForWorker: (worker) =>
                    options.sideEffects.forQueue({
                        action: "jobs.worker.stop",
                        at: worker.heartbeatAt,
                        outcome: "succeeded",
                        targetId: worker.id,
                    }),
                workerId: options.workerInstanceId,
            });
            if (!workerReachedState(result, "stopped")) {
                throw new Error("Durable job worker could not enter stopped state");
            }
        } catch (error) {
            failure ??= normalizeCoordinatorFailure(error);
        }
        resolveCompletion?.();
        if (failure !== undefined) throw failure;
    };

    return Object.freeze({
        completion,
        dispose(forceSignal?: AbortSignal) {
            disposePromise ??= dispose(forceSignal);
            return disposePromise;
        },
        initialize() {
            if (disposePromise !== undefined) {
                return Promise.reject(new Error("Durable job coordinator is disposed"));
            }
            initializePromise ??= initialize().catch((error: unknown) => {
                const failure = normalizeCoordinatorFailure(error);
                rejectCompletion?.(failure);
                throw failure;
            });
            return initializePromise;
        },
    });
}
