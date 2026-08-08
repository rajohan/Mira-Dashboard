import { getTime, max as maximumDate, subMilliseconds, toDate } from "date-fns";
import { Context, Data, Effect } from "effect";
import * as v from "valibot";

import {
    type JobRunSummary,
    type JobWorkerControl,
    type ScheduleConfiguration,
    type ScheduleSummary,
    jobWorkerFreshnessMs,
    jobTimestampSchema,
} from "../../../contracts/jobModel.ts";
import {
    type JobRunDetail,
    type ListJobRunsInput,
    type ListJobRunsResult,
    type CancelJobRunInput,
    type GetJobRunInput,
    type SetJobClaimingPausedInput,
    jobRunDetailSchema,
    listJobRunsResultSchema,
} from "../../../contracts/jobs.ts";
import {
    type GetScheduleInput,
    type ListScheduleRunsInput,
    type ListScheduleRunsResult,
    type ListSchedulesInput,
    type ListSchedulesResult,
    type RunScheduleInput,
    type UpdateScheduleInput,
    listScheduleRunsResultSchema,
    listSchedulesResultSchema,
} from "../../../contracts/schedules.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { isDatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    type JobActionRegistration,
    findJobActionRegistration,
    isRegisteredJobSchedule,
    jobActionRegistrations,
} from "./actionRegistry.ts";
import {
    JobConflictError,
    JobNotFoundError,
    type JobOperationError,
    JobValidationError,
} from "./errors.ts";
import {
    toJobRunEvent,
    toJobRunResult,
    toJobRunSummary,
    toJobWorkerControl,
    toJobWorkerSummary,
    toScheduleSummary,
} from "./records.ts";
import { buildRegisteredSchedule } from "./registeredSchedule.ts";
import {
    type JobMutationSideEffects,
    type JobRepository,
    type ScheduleRecordWithRelations,
} from "./repository.ts";
import { nextScheduleOccurrence } from "./scheduleTime.ts";
import {
    type JobAuditActor,
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "./sideEffects.ts";

const systemActor = Object.freeze({
    authenticatorId: null,
    id: "jobs-scheduler",
    kind: "system",
} satisfies JobAuditActor);

class JobUnexpectedOperationError extends Data.TaggedError(
    "JobUnexpectedOperationError"
)<{ readonly cause: unknown }> {}

interface JobServiceShape {
    readonly cancelRun: (
        principal: AuthenticatedPrincipal,
        input: CancelJobRunInput
    ) => Effect.Effect<JobRunSummary, JobOperationError>;
    readonly getRun: (
        input: GetJobRunInput
    ) => Effect.Effect<JobRunDetail, JobNotFoundError>;
    readonly getSchedule: (
        input: GetScheduleInput
    ) => Effect.Effect<ScheduleSummary, JobNotFoundError>;
    readonly listRuns: (input: ListJobRunsInput) => Effect.Effect<ListJobRunsResult>;
    readonly listScheduleRuns: (
        input: ListScheduleRunsInput
    ) => Effect.Effect<ListScheduleRunsResult, JobNotFoundError>;
    readonly listSchedules: (
        input: ListSchedulesInput
    ) => Effect.Effect<ListSchedulesResult>;
    readonly runSchedule: (
        principal: AuthenticatedPrincipal,
        input: RunScheduleInput
    ) => Effect.Effect<JobRunSummary, JobOperationError>;
    readonly setClaimingPaused: (
        principal: AuthenticatedPrincipal,
        input: SetJobClaimingPausedInput
    ) => Effect.Effect<JobWorkerControl, JobOperationError>;
    readonly updateSchedule: (
        principal: AuthenticatedPrincipal,
        input: UpdateScheduleInput
    ) => Effect.Effect<ScheduleSummary, JobOperationError>;
}

/** Effect service for durable job inventory and Dashboard-local schedules. */
export class JobService extends Context.Service<JobService, JobServiceShape>()(
    "mira-dashboard/server/domains/jobs/JobService"
) {}

export interface JobServiceDependencies {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly repository: JobRepository;
    readonly wakeEventPump?: () => Promise<void> | void;
}

export type JobScheduleReconciliationDependencies = JobServiceDependencies;

interface AuthenticatedJobActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

function principalActor(principal: AuthenticatedPrincipal): AuthenticatedJobActor {
    return {
        id: principal.id,
        kind: principal.kind === "session" ? "user" : "automation",
    };
}

function principalAuditActor(principal: AuthenticatedPrincipal): JobAuditActor {
    return {
        authenticatorId: principal.authenticatorId,
        id: principal.id,
        kind: principal.kind === "session" ? "user" : "automation",
    };
}

function readEffect<T, E>(
    operation: () => T,
    isExpected: (error: unknown) => error is E
): Effect.Effect<T, E> {
    return Effect.try({
        catch: (error) =>
            isExpected(error) ? error : new JobUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchIf(
            (error): error is JobUnexpectedOperationError =>
                error instanceof JobUnexpectedOperationError,
            (error) => Effect.die(error.cause)
        )
    );
}

function mutationEffect<T>(
    operation: () => Promise<T>
): Effect.Effect<T, JobOperationError> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof JobConflictError ||
            error instanceof JobNotFoundError ||
            error instanceof JobValidationError ||
            isDatabaseRuntimeWriteUnavailableError(error)
                ? error
                : new JobUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("JobUnexpectedOperationError", (error) => Effect.die(error.cause))
    );
}

function pageResult<TRecord, TValue>(
    records: readonly TRecord[],
    limit: number,
    map: (record: TRecord) => TValue
): { readonly hasNextPage: boolean; readonly page: TValue[] } {
    return {
        hasNextPage: records.length > limit,
        page: records.slice(0, limit).map((record) => map(record)),
    };
}

function readSchedule(
    repository: JobRepository,
    id: string
): ScheduleRecordWithRelations {
    const relation = repository.findSchedule(id);
    if (relation === undefined) {
        throw new JobNotFoundError({ id, resource: "schedule" });
    }
    return relation;
}

function listRuns(
    repository: JobRepository,
    input: ListJobRunsInput,
    minimumWorkerHeartbeatAt: Date
): ListJobRunsResult {
    const snapshot = repository.listRunsWithQueueState({
        ...input,
        minimumHeartbeatAt: minimumWorkerHeartbeatAt,
    });
    const { hasNextPage, page } = pageResult(snapshot.runs, input.limit, toJobRunSummary);
    const queue = snapshot.queue;
    const last = page.at(-1);
    return v.parse(listJobRunsResultSchema, {
        ...(hasNextPage && last !== undefined
            ? { nextCursor: { id: last.id, queuedAtMs: last.queuedAtMs } }
            : {}),
        runs: page,
        summary: {
            activeResourceClasses: [...queue.activeResourceClasses],
            control: toJobWorkerControl(queue.control),
            ...(queue.oldestQueuedAt === undefined
                ? {}
                : { oldestQueuedAtMs: getTime(queue.oldestQueuedAt) }),
            stateCounts: queue.stateCounts,
            workers: queue.workers.map(({ activeRunCount, worker }) =>
                toJobWorkerSummary(worker, activeRunCount)
            ),
        },
    });
}

function getRun(repository: JobRepository, input: GetJobRunInput): JobRunDetail {
    const detail = repository.findRunDetail({
        ...(input.eventCursor === undefined
            ? {}
            : { beforeSequence: input.eventCursor.sequence }),
        limit: input.eventLimit,
        runId: input.id,
    });
    if (detail === undefined) {
        throw new JobNotFoundError({ id: input.id, resource: "job-run" });
    }
    const { events: records, run } = detail;
    const { hasNextPage, page } = pageResult(records, input.eventLimit, toJobRunEvent);
    const last = page.at(-1);
    return v.parse(jobRunDetailSchema, {
        events: page,
        ...(hasNextPage && last !== undefined
            ? { nextEventCursor: { sequence: last.sequence } }
            : {}),
        ...(run.resultJson === null ? {} : { result: toJobRunResult(run) }),
        run: toJobRunSummary(run),
    });
}

function listSchedules(
    repository: JobRepository,
    input: ListSchedulesInput
): ListSchedulesResult {
    const { hasNextPage, page } = pageResult(
        repository.listSchedules(input),
        input.limit,
        ({ activeDisableIntent, activeRun, latestRun, schedule }) =>
            toScheduleSummary(schedule, {
                ...(activeDisableIntent === undefined ? {} : { activeDisableIntent }),
                ...(activeRun === undefined ? {} : { activeRun }),
                ...(latestRun === undefined ? {} : { latestRun }),
            })
    );
    const last = page.at(-1);
    return v.parse(listSchedulesResultSchema, {
        ...(hasNextPage && last !== undefined ? { nextCursor: { id: last.id } } : {}),
        schedules: page,
    });
}

function listScheduleRuns(
    repository: JobRepository,
    input: ListScheduleRunsInput
): ListScheduleRunsResult {
    readSchedule(repository, input.id);
    const { hasNextPage, page } = pageResult(
        repository.listScheduleRuns(input),
        input.limit,
        toJobRunSummary
    );
    const last = page.at(-1);
    return v.parse(listScheduleRunsResultSchema, {
        ...(hasNextPage && last !== undefined
            ? { nextCursor: { id: last.id, queuedAtMs: last.queuedAtMs } }
            : {}),
        runs: page,
    });
}

function operationTime(nowMs: () => number, durableDates: readonly Date[]): Date {
    const now = toDate(v.parse(jobTimestampSchema, nowMs()));
    return maximumDate([now, ...durableDates]);
}

function minimumWorkerHeartbeatAt(nowMs: () => number): Date {
    return subMilliseconds(operationTime(nowMs, []), jobWorkerFreshnessMs);
}

function schedulesAreEqual(
    left: ScheduleConfiguration,
    right: ScheduleConfiguration
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "interval" && right.kind === "interval") {
        return left.intervalMs === right.intervalMs;
    }
    if (left.kind === "daily" && right.kind === "daily") {
        return left.timeOfDay === right.timeOfDay && left.timeZone === right.timeZone;
    }
    if (left.kind === "cron" && right.kind === "cron") {
        return left.expression === right.expression && left.timeZone === right.timeZone;
    }
    return false;
}

function mutationSideEffects(
    generateId: () => string,
    input: Omit<Parameters<typeof createJobMutationSideEffects>[0], "auditId">
): JobMutationSideEffects {
    return createJobMutationSideEffects({ ...input, auditId: generateId() });
}

function scheduleInsertShape(registration: JobActionRegistration, at: Date) {
    const schedule = buildRegisteredSchedule(registration, at);
    if (schedule === undefined) {
        throw new JobValidationError({
            id: registration.scheduleId,
            reason: "next-occurrence-unavailable",
            resource: "schedule",
        });
    }
    return schedule;
}

/**
 * Creates the domain service and reconciles the reviewed schedule directory.
 * @param dependencies Process-owned repository, clock, IDs, and realtime wakeup.
 * @returns Durable jobs service used by both jobs and schedules routers.
 */
export function createJobService(
    dependencies: JobServiceDependencies
): JobService["Service"] {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;

    async function wake(): Promise<void> {
        if (dependencies.wakeEventPump === undefined) return;
        try {
            await dependencies.wakeEventPump();
        } catch {
            // Durable outbox state is authoritative; a later pump cycle will observe it.
        }
    }

    const service: JobService["Service"] = {
        cancelRun: (principal, input) =>
            mutationEffect(async () => {
                const current = dependencies.repository.findRun(input.id);
                if (current === undefined) {
                    throw new JobNotFoundError({
                        id: input.id,
                        resource: "job-run",
                    });
                }
                const at = operationTime(nowMs, [current.updatedAt]);
                const result = await dependencies.repository.cancelRun({
                    actor: principalActor(principal),
                    at,
                    id: input.id,
                    ...mutationSideEffects(generateId, {
                        action: "jobs.run.cancel",
                        actor: principalAuditActor(principal),
                        occurredAt: at,
                        outcome: "accepted",
                        realtime: {
                            id: input.id,
                            kind: "run",
                            operation: "updated",
                        },
                        targetId: input.id,
                        targetType: "job-run",
                    }),
                    terminalCode: "cancelled/operator-request",
                    terminalMessage: "Cancelled by an operator",
                });
                if (result.kind === "not-found") {
                    throw new JobNotFoundError({ id: input.id, resource: "job-run" });
                }
                if (result.kind === "unsupported") {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "cancellation-not-supported",
                        resource: "job-run",
                    });
                }
                if (result.kind === "cancelled" || result.kind === "requested") {
                    await wake();
                }
                return toJobRunSummary(result.run);
            }),
        getRun: (input) =>
            readEffect(
                () => getRun(dependencies.repository, input),
                (error): error is JobNotFoundError => error instanceof JobNotFoundError
            ),
        getSchedule: (input) =>
            readEffect(
                () => {
                    const relation = readSchedule(dependencies.repository, input.id);
                    return toScheduleSummary(relation.schedule, relation);
                },
                (error): error is JobNotFoundError => error instanceof JobNotFoundError
            ),
        listRuns: (input) =>
            readEffect(
                () =>
                    listRuns(
                        dependencies.repository,
                        input,
                        minimumWorkerHeartbeatAt(nowMs)
                    ),
                (_error): _error is never => false
            ),
        listScheduleRuns: (input) =>
            readEffect(
                () => listScheduleRuns(dependencies.repository, input),
                (error): error is JobNotFoundError => error instanceof JobNotFoundError
            ),
        listSchedules: (input) =>
            readEffect(
                () => listSchedules(dependencies.repository, input),
                (_error): _error is never => false
            ),
        runSchedule: (principal, input) =>
            mutationEffect(async () => {
                const { schedule } = readSchedule(dependencies.repository, input.id);
                const registration = findJobActionRegistration(schedule.actionKey);
                if (!isRegisteredJobSchedule(schedule.id, schedule.actionKey)) {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "action-unavailable",
                        resource: "schedule",
                    });
                }
                if (registration?.manualExposure !== "jobs-write") {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "action-not-manually-exposed",
                        resource: "schedule",
                    });
                }
                const at = operationTime(nowMs, [schedule.updatedAt]);
                const runId = generateId();
                const actor = principalActor(principal);
                const runSideEffects = mutationSideEffects(generateId, {
                    action: "jobs.run.enqueue",
                    actor: principalAuditActor(principal),
                    occurredAt: at,
                    outcome: "accepted",
                    realtime: {
                        id: runId,
                        kind: "run",
                        operation: "created",
                    },
                    targetId: runId,
                    targetType: "job-run",
                });
                const scheduleSideEffects = createJobRealtimeSideEffects({
                    occurredAt: at,
                    realtime: {
                        id: schedule.id,
                        kind: "schedule",
                        operation: "updated",
                    },
                });
                const result = await dependencies.repository.enqueueManualRun({
                    auditEvents: runSideEffects.auditEvents,
                    queuedEvent: {
                        attempt: 0,
                        jobRunId: runId,
                        kind: "queued",
                        message: null,
                        occurredAt: at,
                        progressJson: null,
                        sequence: 1,
                        workerInstanceId: null,
                    },
                    run: {
                        actionKey: schedule.actionKey,
                        attemptLimit: schedule.attemptLimit,
                        availableAt: at,
                        cancellationPolicy: schedule.cancellationPolicy,
                        cancelRequestedAt: null,
                        cancelRequestedById: null,
                        cancelRequestedByKind: null,
                        displayName: schedule.name,
                        enqueueSha256: sha256Hex(
                            JSON.stringify({
                                procedure: "schedules.run",
                                scheduleId: schedule.id,
                                triggerType: "manual",
                                version: 1,
                            })
                        ),
                        finishedAt: null,
                        firstStartedAt: null,
                        heartbeatAt: null,
                        id: runId,
                        idempotencyKey: input.idempotencyKey,
                        lastAttemptStartedAt: null,
                        leaseExpiresAt: null,
                        leaseOwnerId: null,
                        leaseToken: null,
                        payloadJson: schedule.actionPayloadJson,
                        priority: schedule.priority,
                        queuedAt: at,
                        requestedById: actor.id,
                        requestedByKind: actor.kind,
                        resourceClass: schedule.resourceClass,
                        resourceKeysJson: schedule.resourceKeysJson,
                        resultJson: null,
                        retrySafe: schedule.retrySafe,
                        scheduledForAt: null,
                        scheduledJobId: schedule.id,
                        scheduledJobVersion: schedule.version,
                        state: "queued",
                        terminalCode: null,
                        terminalMessage: null,
                        timeoutMs: schedule.timeoutMs,
                        triggerType: "manual",
                        updatedAt: at,
                    },
                    realtimeEvents: Object.freeze([
                        ...runSideEffects.realtimeEvents,
                        ...scheduleSideEffects.realtimeEvents,
                    ]),
                });
                if (result.kind === "idempotency-mismatch") {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "idempotency-mismatch",
                        resource: "schedule",
                    });
                }
                if (result.kind === "active") {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "run-already-active",
                        resource: "schedule",
                    });
                }
                if (result.kind === "inserted") await wake();
                return toJobRunSummary(result.run);
            }),
        setClaimingPaused: (principal, input) =>
            mutationEffect(async () => {
                const current = dependencies.repository.readWorkerControl();
                const at = operationTime(nowMs, [current.updatedAt]);
                const result = await dependencies.repository.setClaimingPaused({
                    actor: principalActor(principal),
                    at,
                    expectedVersion: input.expectedVersion,
                    paused: input.paused,
                    ...mutationSideEffects(generateId, {
                        action: "jobs.claim.pause",
                        actor: principalAuditActor(principal),
                        occurredAt: at,
                        outcome: "accepted",
                        realtime: { id: "worker-control", kind: "queue" },
                        targetId: "worker-control",
                        targetType: "job-worker",
                    }),
                });
                if (result.kind === "version-changed") {
                    throw new JobConflictError({
                        id: "worker-control",
                        reason: "version-changed",
                        resource: "worker-control",
                    });
                }
                await wake();
                return toJobWorkerControl(result.control);
            }),
        updateSchedule: (principal, input) =>
            mutationEffect(async () => {
                const current = readSchedule(dependencies.repository, input.id);
                if (
                    !isRegisteredJobSchedule(
                        current.schedule.id,
                        current.schedule.actionKey
                    )
                ) {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "action-unavailable",
                        resource: "schedule",
                    });
                }
                const at = operationTime(nowMs, [current.schedule.updatedAt]);
                const currentConfiguration = toScheduleSummary(
                    current.schedule,
                    current
                ).schedule;
                const changesSchedule =
                    input.patch.schedule !== undefined &&
                    !schedulesAreEqual(input.patch.schedule, currentConfiguration);
                const editsEnabledScheduleCadence =
                    current.schedule.enabled &&
                    input.patch.enabled === true &&
                    changesSchedule;
                const replacesActiveDisableIntent =
                    current.activeDisableIntent !== undefined &&
                    current.schedule.enabled === false &&
                    input.patch.enabled === false &&
                    input.patch.disableIntent !== undefined &&
                    input.patch.disableIntent !== null;
                if (
                    input.patch.enabled !== undefined &&
                    input.patch.enabled === current.schedule.enabled &&
                    !replacesActiveDisableIntent &&
                    !editsEnabledScheduleCadence
                ) {
                    throw new JobValidationError({
                        id: input.id,
                        reason: "enabled-state-unchanged",
                        resource: "schedule",
                    });
                }
                if (
                    input.patch.enabled === undefined &&
                    input.patch.schedule !== undefined &&
                    !changesSchedule
                ) {
                    throw new JobValidationError({
                        id: input.id,
                        reason: "schedule-unchanged",
                        resource: "schedule",
                    });
                }
                if (
                    input.patch.disableIntent?.expiresAtMs !== undefined &&
                    input.patch.disableIntent.expiresAtMs <= getTime(at)
                ) {
                    throw new JobValidationError({
                        id: input.id,
                        reason: "disable-intent-expired",
                        resource: "schedule",
                    });
                }
                const targetEnabled = input.patch.enabled ?? current.schedule.enabled;
                const targetConfiguration =
                    input.patch.schedule === undefined ? undefined : input.patch.schedule;
                const shouldCalculateNextRun =
                    targetEnabled || targetConfiguration !== undefined;
                const cadenceAnchorMs =
                    targetConfiguration === undefined
                        ? getTime(
                              current.schedule.nextRunAt ?? current.schedule.createdAt
                          )
                        : getTime(at);
                const existingNextRunAtMs =
                    current.schedule.nextRunAt === null
                        ? undefined
                        : getTime(current.schedule.nextRunAt);
                const nextRunAtMs = shouldCalculateNextRun
                    ? nextScheduleOccurrence(
                          targetConfiguration ?? currentConfiguration,
                          getTime(at),
                          cadenceAnchorMs
                      )
                    : existingNextRunAtMs;
                if (shouldCalculateNextRun && nextRunAtMs === undefined) {
                    throw new JobValidationError({
                        id: input.id,
                        reason: "next-occurrence-unavailable",
                        resource: "schedule",
                    });
                }
                const actor = principalActor(principal);
                const result = await dependencies.repository.updateSchedule({
                    at,
                    ...(current.activeDisableIntent === undefined ||
                    input.patch.enabled === undefined
                        ? {}
                        : {
                              closeActiveIntent: {
                                  endedAt: at,
                                  endedById: actor.id,
                                  endedByKind: actor.kind,
                                  endedReason:
                                      input.patch.enabled === true
                                          ? "re-enabled"
                                          : "replaced",
                              },
                          }),
                    expectedActiveDisableIntentId:
                        current.activeDisableIntent?.id ?? null,
                    expectedVersion: input.expectedVersion,
                    id: input.id,
                    ...(input.patch.disableIntent === undefined ||
                    input.patch.disableIntent === null
                        ? {}
                        : {
                              insertDisableIntent: {
                                  createdAt: at,
                                  createdById: actor.id,
                                  createdByKind: actor.kind,
                                  endedAt: null,
                                  endedById: null,
                                  endedByKind: null,
                                  endedReason: null,
                                  expiresAt:
                                      input.patch.disableIntent.expiresAtMs === undefined
                                          ? null
                                          : toDate(input.patch.disableIntent.expiresAtMs),
                                  externalJobId: null,
                                  externalProvider: null,
                                  id: generateId(),
                                  reason: input.patch.disableIntent.reason,
                                  scheduledJobId: input.id,
                                  targetKind: "dashboard-schedule",
                              },
                          }),
                    patch: {
                        ...(input.patch.enabled === undefined
                            ? {}
                            : { enabled: input.patch.enabled }),
                        nextRunAt: nextRunAtMs === undefined ? null : toDate(nextRunAtMs),
                        ...(targetConfiguration === undefined
                            ? {}
                            : { schedule: targetConfiguration }),
                    },
                    ...(input.patch.enabled === false
                        ? {
                              queuedCancellation: {
                                  at,
                                  terminalCode: "cancelled/schedule-disabled",
                                  terminalMessage:
                                      "Cancelled because the schedule was disabled",
                              },
                              queuedCancellationSideEffects: (run) =>
                                  mutationSideEffects(generateId, {
                                      action: "jobs.run.cancel",
                                      actor: principalAuditActor(principal),
                                      occurredAt: at,
                                      outcome: "cancelled",
                                      realtime: {
                                          id: run.id,
                                          kind: "run",
                                          operation: "updated",
                                      },
                                      targetId: run.id,
                                      targetType: "job-run",
                                  }),
                          }
                        : {}),
                    ...mutationSideEffects(generateId, {
                        action: "jobs.schedule.update",
                        actor: principalAuditActor(principal),
                        occurredAt: at,
                        outcome: "accepted",
                        realtime: {
                            id: input.id,
                            kind: "schedule",
                            operation: "updated",
                        },
                        targetId: input.id,
                        targetType: "schedule",
                    }),
                });
                if (result.kind === "not-found") {
                    throw new JobNotFoundError({ id: input.id, resource: "schedule" });
                }
                if (result.kind === "cancellation-not-supported") {
                    throw new JobConflictError({
                        id: result.run.id,
                        reason: "cancellation-not-supported",
                        resource: "job-run",
                    });
                }
                if (result.kind === "version-changed") {
                    throw new JobConflictError({
                        id: input.id,
                        reason: "version-changed",
                        resource: "schedule",
                    });
                }
                await wake();
                const updated = readSchedule(dependencies.repository, input.id);
                return toScheduleSummary(updated.schedule, updated);
            }),
    };

    return service;
}

/**
 * Reconciles the reviewed action directory before web or worker traffic is accepted.
 * @param dependencies Process-owned repository, clock, IDs, and realtime wakeup.
 * @returns Promise that resolves only after the durable reconciliation commits.
 */
export async function reconcileJobSchedules(
    dependencies: JobScheduleReconciliationDependencies
): Promise<void> {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const at = toDate(v.parse(jobTimestampSchema, nowMs()));
    await dependencies.repository.reconcileSchedules({
        at,
        schedules: jobActionRegistrations.map((registration) =>
            scheduleInsertShape(registration, at)
        ),
        sideEffectsForSchedule: (schedule) =>
            mutationSideEffects(generateId, {
                action: "jobs.schedule.reconcile",
                actor: systemActor,
                occurredAt: schedule.updatedAt,
                outcome: "succeeded",
                realtime: {
                    id: schedule.id,
                    kind: "schedule",
                    operation: "updated",
                },
                targetId: schedule.id,
                targetType: "schedule",
            }),
    });
    if (dependencies.wakeEventPump !== undefined) {
        try {
            await dependencies.wakeEventPump();
        } catch {
            // Reconciliation and its durable outbox rows already committed.
        }
    }
}
