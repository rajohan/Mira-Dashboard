import type {
    ScheduledJob,
    ScheduledJobRun,
    ScheduledJobTriggerType,
} from "../../../contracts/jobs.ts";
import type { SchedulerMetrics } from "../../../contracts/metrics.ts";
import { database, sqlNullable } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import { withJobResourceClass } from "../lib/jobResources.ts";
import { runWithLogContext } from "../lib/logContext.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    claimNextJobExecution,
    didHeartbeatJobWorker,
    finishJobExecution,
    getJobExecution,
    getJobExecutionSummary,
    heartbeatJobExecution,
    insertJobExecution,
    type JobExecutionRecord,
    protectRunningJobExecutionFromCancellation,
    recoverExpiredJobExecutions,
    registerJobWorker,
    unregisterJobWorker,
    updateJobExecutionOutput,
} from "./jobExecutionQueue.ts";
import { waitForJobExecution } from "./queuedJobExecution.ts";
import {
    registeredScheduledJobAction,
    ScheduledJobActionError,
    type ScheduledJobActionContext,
    type ScheduledJobActionRegistration,
    ScheduledJobInterruptionError,
} from "./scheduledJobs/actionRegistry.ts";
import { ScheduledJobValidationError } from "./scheduledJobs/errors.ts";
import {
    DeploymentCutoverReconciler,
    type DeploymentCutoverRecoveryHandler,
    type DeploymentGuardianStateReader,
} from "./scheduledJobs/deploymentCutoverReconciler.ts";
import { calculateNextRunAt } from "./scheduledJobs/schedule.ts";
import {
    getScheduledJob,
    insertScheduledRun,
    scheduledRunById,
} from "./scheduledJobs/repository.ts";

export {
    isScheduledJobValidationError,
    ScheduledJobValidationError,
} from "./scheduledJobs/errors.ts";
export { calculateNextRunAt } from "./scheduledJobs/schedule.ts";
export {
    getScheduledJob,
    listScheduledJobRuns,
    listScheduledJobs,
    removeScheduledJobsNotInAction,
    type ScheduledJobDefinition,
    updateScheduledJob,
    upsertScheduledJob,
} from "./scheduledJobs/repository.ts";
export {
    registerScheduledJobAction,
    ScheduledJobActionError,
    type ScheduledJobActionContext,
    type ScheduledJobActionHandler,
    type ScheduledJobActionOptions,
} from "./scheduledJobs/actionRegistry.ts";
export type {
    DeploymentCutoverRecoveryHandler,
    OrphanedDeploymentCutover,
} from "./scheduledJobs/deploymentCutoverReconciler.ts";

const logger = createStructuredLogger("scheduled-jobs");

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const schedulerTickMs = 30_000;
const executorTickMs = 1000;
const executorHeartbeatMs = 1000;
const executorCapacity = 1;
const interruptedHandlerGraceMs = 30_000;
const RELEASE_COMMIT_PATTERN = /^(?:[\da-f]{8,40}|development)$/u;
const activeExecutionControllers = new Map<string, AbortController>();
const activeExecutionRuns = new Map<string, Promise<void>>();
const deploymentCutoverReconciler = new DeploymentCutoverReconciler();

const scheduledJobRuntimeState: {
    scheduler: NodeJS.Timeout | undefined;
    executor: NodeJS.Timeout | undefined;
    workerHeartbeat: NodeJS.Timeout | undefined;
    executorClaimPauseGeneration: number;
    isSchedulerTickRunning: boolean;
    isExecutorClaimingPaused: boolean;
    isExecutorTickRunning: boolean;
    lastSchedulerTickAt: string | undefined;
    lastSchedulerTickDurationMs: number;
    schedulerQueueFailures: number;
    schedulerTickFailures: number;
    schedulerTicks: number;
    workerId: string;
} = {
    scheduler: undefined,
    executor: undefined,
    workerHeartbeat: undefined,
    executorClaimPauseGeneration: 0,
    isSchedulerTickRunning: false,
    isExecutorClaimingPaused: false,
    isExecutorTickRunning: false,
    lastSchedulerTickAt: undefined,
    lastSchedulerTickDurationMs: 0,
    schedulerQueueFailures: 0,
    schedulerTickFailures: 0,
    schedulerTicks: 0,
    workerId: "",
};

function nowIso(): string {
    return dateToISOString(new Date());
}

interface EnqueueScheduledJobOptions {
    availableAt?: string;
}

function isActiveExecutionConflict(error: unknown): boolean {
    const message = errorMessage(error, "");
    return (
        message.includes("UNIQUE constraint failed: job_executions.scheduled_job_id") ||
        message.includes("idx_job_executions_active_scheduled_job")
    );
}

function jobStatusError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
}

export function enqueueScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual",
    options: EnqueueScheduledJobOptions = {}
): ScheduledJobRun {
    const job = getScheduledJob(id);
    if (!job) throw jobStatusError("Scheduled job not found", 404);
    if (triggerType !== "manual" && !job.enabled) {
        throw jobStatusError("Scheduled job is disabled", 409);
    }

    const queuedAt = nowIso();
    database.run("BEGIN IMMEDIATE");
    try {
        if (triggerType === "schedule") {
            const nextRunAt = calculateNextRunAt(job, new Date(queuedAt));
            const update = database
                .prepare(
                    `UPDATE scheduled_jobs
                     SET next_run_at = ?, updated_at = ?
                     WHERE id = ? AND enabled = 1
                       AND next_run_at IS NOT NULL AND next_run_at <= ?`
                )
                .run(sqlNullable(nextRunAt), queuedAt, job.id, queuedAt);
            if (update.changes === 0) {
                throw jobStatusError("Scheduled job is no longer due", 409);
            }
        }

        const runId = insertScheduledRun(job.id, triggerType, "queued", queuedAt);
        insertJobExecution({
            actionKey: job.actionKey,
            availableAt: options.availableAt,
            displayName: job.name,
            payload: job.actionPayload,
            queuedAt,
            resourceClass: job.resourceClass,
            scheduledJobId: job.id,
            scheduledRunId: runId,
            timeoutMs: job.timeoutMs,
            triggerType,
        });
        database.run("COMMIT");
        return scheduledRunById(runId) as ScheduledJobRun;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the enqueue error.
        }
        if (isActiveExecutionConflict(error)) {
            throw jobStatusError("Scheduled job is already queued or running", 409);
        }
        throw error;
    }
}

export async function runScheduledJob(
    id: string,
    triggerType: ScheduledJobTriggerType = "manual",
    signal?: AbortSignal
): Promise<ScheduledJobRun> {
    const job = getScheduledJob(id);
    if (!job) throw jobStatusError("Scheduled job not found", 404);
    const action = registeredScheduledJobAction(job.actionKey);
    if (!action && triggerType === "manual") {
        throw new ScheduledJobValidationError(
            `No scheduled job action registered for ${job.actionKey}`
        );
    }
    const run = enqueueScheduledJob(id, triggerType);
    if (!run.executionId) throw jobStatusError("Scheduled job was not queued", 500);
    await waitForJobExecution(run.executionId, { signal });
    return scheduledRunById(run.id) as ScheduledJobRun;
}

async function executeClaimedJobExecution(
    execution: JobExecutionRecord,
    workerId: string,
    signal?: AbortSignal
): Promise<JobExecutionRecord | ScheduledJobRun> {
    const currentJob = execution.scheduledJobId
        ? getScheduledJob(execution.scheduledJobId)
        : undefined;
    if (!currentJob && execution.scheduledJobId) {
        return finishJobExecution(
            execution.id,
            workerId,
            "cancelled",
            "Scheduled job was removed before execution",
            {}
        );
    }
    if (currentJob && !currentJob.enabled && execution.triggerType !== "manual") {
        const finishedExecution = finishJobExecution(
            execution.id,
            workerId,
            "cancelled",
            "Scheduled job was disabled before execution",
            {}
        );
        return execution.scheduledRunId === undefined
            ? finishedExecution
            : (scheduledRunById(execution.scheduledRunId) as ScheduledJobRun);
    }
    const job: ScheduledJob = currentJob
        ? {
              ...currentJob,
              actionKey: execution.actionKey,
              actionPayload: execution.payload,
              resourceClass: execution.resourceClass,
              timeoutMs: execution.timeoutMs,
          }
        : {
              actionKey: execution.actionKey,
              actionPayload: execution.payload,
              createdAt: execution.queuedAt,
              cronExpression: undefined,
              description: "",
              disableIntent: undefined,
              enabled: true,
              id: execution.id,
              intervalSeconds: 60,
              isQueued: false,
              isRunning: true,
              lastRun: undefined,
              name: execution.displayName,
              nextRunAt: undefined,
              resourceClass: execution.resourceClass,
              scheduleType: "interval",
              timeOfDay: undefined,
              timeoutMs: execution.timeoutMs,
              updatedAt: execution.startedAt ?? execution.queuedAt,
          };
    const action = registeredScheduledJobAction(execution.actionKey);
    const controller = new AbortController();
    const abortFromSignal = () => controller.abort();
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (signal?.aborted) controller.abort();
    const heartbeat = setInterval(() => {
        try {
            const lease = heartbeatJobExecution(execution.id, workerId);
            if (!lease.hasLease || lease.cancelRequested) controller.abort();
        } catch (error) {
            logger.warn("scheduled_jobs.execution_heartbeat_failed", {
                error,
                executionId: execution.id,
            });
        }
    }, executorHeartbeatMs);
    heartbeat.unref();

    let status: "success" | "failed" = "success";
    let message: string | undefined;
    let output: Record<string, unknown>;
    try {
        try {
            if (!action) {
                throw new ScheduledJobValidationError(
                    `No scheduled job action registered for ${execution.actionKey}`
                );
            }
            output = await withJobResourceClass(execution.resourceClass, () =>
                runActionWithTimeout(
                    execution.timeoutMs,
                    action,
                    job,
                    {
                        executionId: execution.id,
                        pauseWorkerClaims: pauseExecutorClaims,
                        protectFromCancellation: () => {
                            protectRunningJobExecutionFromCancellation(execution.id);
                        },
                        updateOutput: (nextOutput) => {
                            updateJobExecutionOutput(execution.id, workerId, nextOutput);
                        },
                    },
                    controller.signal
                )
            );
        } catch (error) {
            if (error instanceof ScheduledJobInterruptionError) {
                const didSettle = await waitForInterruptedHandler(
                    error.getHandlerSettled()
                );
                if (!didSettle) {
                    logger.warn("scheduled_jobs.interrupted_action_cleanup_timed_out", {
                        executionId: execution.id,
                    });
                }
            }
            status = "failed";
            message = errorMessage(error, "Scheduled job failed");
            const progressOutput = getJobExecution(execution.id)?.output ?? {};
            const statusCode = Number(
                (error as { statusCode?: unknown } | undefined)?.statusCode
            );
            output = {
                ...progressOutput,
                ...(error instanceof ScheduledJobActionError && error.output),
                ...(Number.isSafeInteger(statusCode) &&
                    statusCode >= 400 &&
                    statusCode < 600 && { statusCode }),
            };
        }
        const finishedExecution = finishJobExecution(
            execution.id,
            workerId,
            status,
            message,
            output
        );
        return execution.scheduledRunId === undefined
            ? finishedExecution
            : (scheduledRunById(execution.scheduledRunId) as ScheduledJobRun);
    } finally {
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", abortFromSignal);
    }
}

async function runActionWithTimeout(
    timeoutMs: number,
    action: ScheduledJobActionRegistration,
    job: ScheduledJob,
    context: ScheduledJobActionContext,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
        throw new Error("Scheduled job aborted");
    }
    const controller = new AbortController();
    const abortPromise = Promise.withResolvers<never>();
    let handlerSettled: Promise<unknown> = Promise.resolve();
    const interrupt = (message: string) => {
        abortPromise.reject(new ScheduledJobInterruptionError(message, handlerSettled));
        controller.abort();
    };
    const abortFromSignal = () => interrupt("Scheduled job aborted");
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    try {
        timeout = setTimeout(() => {
            logger.warn("scheduled_jobs.execution_timed_out", {
                timeoutMs,
            });
            interrupt("Scheduled job timed out");
        }, timeoutMs);
        timeout?.unref();
        const handlerPromise = Promise.resolve(
            action.handler(job, controller.signal, context)
        );
        handlerSettled = suppressHandlerPromiseRejection(handlerPromise);
        const output = (await Promise.race([handlerPromise, abortPromise.promise])) ?? {};
        return output;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abortFromSignal);
    }
}

async function suppressHandlerPromiseRejection(
    handlerPromise: Promise<unknown>
): Promise<void> {
    try {
        await handlerPromise;
    } catch {
        // The race reports handler failures unless the timeout already won.
    }
}

async function waitForInterruptedHandler(
    handlerSettled: Promise<unknown>
): Promise<boolean> {
    const didSettle = async () => {
        await handlerSettled;
        return true;
    };
    const timeout = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => timeout.resolve(false), interruptedHandlerGraceMs);
    timer.unref();
    try {
        return await Promise.race([didSettle(), timeout.promise]);
    } finally {
        clearTimeout(timer);
    }
}

function isStaleScheduledRunError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode?: unknown }).statusCode === 409
    );
}

function runDueJobs(): void {
    const dueAt = nowIso();
    const rows = database
        .prepare(
            `SELECT id FROM scheduled_jobs
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at, id`
        )
        .all(dueAt) as Array<{ id: string }>;
    for (const row of rows) {
        try {
            enqueueScheduledJob(row.id, "schedule");
        } catch (error) {
            if (!isStaleScheduledRunError(error)) {
                scheduledJobRuntimeState.schedulerQueueFailures += 1;
                logger.warn("scheduled_jobs.due_job_queue_failed", { error });
            }
            // Keep later due jobs queueing even if a persisted row is stale.
        }
    }
}

async function observeClaimedExecution(
    execution: JobExecutionRecord,
    controller: AbortController
): Promise<void> {
    try {
        await runWithLogContext({ jobId: execution.id }, () =>
            executeClaimedJobExecution(
                execution,
                scheduledJobRuntimeState.workerId,
                controller.signal
            )
        );
    } catch (error) {
        logger.warn("scheduled_jobs.queued_execution_failed", {
            error,
            executionId: execution.id,
        });
    } finally {
        activeExecutionControllers.delete(execution.id);
        activeExecutionRuns.delete(execution.id);
        queueMicrotask(executorTick);
    }
}

function pauseExecutorClaims(): () => void {
    const generation = ++scheduledJobRuntimeState.executorClaimPauseGeneration;
    scheduledJobRuntimeState.isExecutorClaimingPaused = true;
    let isResumed = false;
    return () => {
        if (isResumed) return;
        isResumed = true;
        if (scheduledJobRuntimeState.executorClaimPauseGeneration !== generation) {
            return;
        }
        scheduledJobRuntimeState.isExecutorClaimingPaused = false;
        queueMicrotask(executorTick);
    };
}

function resetExecutorClaimPause(): void {
    scheduledJobRuntimeState.executorClaimPauseGeneration += 1;
    scheduledJobRuntimeState.isExecutorClaimingPaused = false;
    deploymentCutoverReconciler.reset();
}

export function reconcileOrphanedDeploymentCutovers(
    timestamp = nowIso(),
    readGuardianState?: DeploymentGuardianStateReader,
    ...recoveryHandlerOverride: [
        recoverCutover?: DeploymentCutoverRecoveryHandler | undefined,
    ]
): number {
    return deploymentCutoverReconciler.reconcile(
        timestamp,
        readGuardianState,
        ...recoveryHandlerOverride
    );
}

/** Registers the detached rollback scheduler used for orphaned release cutovers. */
export function registerDeploymentCutoverRecoveryHandler(
    didScheduleRecovery: DeploymentCutoverRecoveryHandler
): void {
    deploymentCutoverReconciler.registerRecoveryHandler(didScheduleRecovery);
}

function hasPendingDeploymentCutover(): boolean {
    return deploymentCutoverReconciler.hasPending();
}

function executorTick(): void {
    if (
        !scheduledJobRuntimeState.executor ||
        scheduledJobRuntimeState.isExecutorClaimingPaused ||
        scheduledJobRuntimeState.isExecutorTickRunning ||
        activeExecutionRuns.size >= executorCapacity
    ) {
        return;
    }
    scheduledJobRuntimeState.isExecutorTickRunning = true;
    try {
        // The in-memory pause is lost when the deployment restarts this worker.
        // Keep replacement workers idle until the detached guardian records a
        // terminal deployment status in the shared database.
        if (hasPendingDeploymentCutover()) {
            return;
        }
        const execution = claimNextJobExecution(
            scheduledJobRuntimeState.workerId,
            executorCapacity
        );
        if (!execution) return;
        const controller = new AbortController();
        activeExecutionControllers.set(execution.id, controller);
        const run = observeClaimedExecution(execution, controller);
        activeExecutionRuns.set(execution.id, run);
    } catch (error) {
        logger.warn("scheduled_jobs.executor_tick_failed", { error });
    } finally {
        scheduledJobRuntimeState.isExecutorTickRunning = false;
    }
}

function scheduleTick(): void {
    if (scheduledJobRuntimeState.isSchedulerTickRunning) {
        return;
    }
    scheduledJobRuntimeState.isSchedulerTickRunning = true;
    scheduledJobRuntimeState.schedulerTicks += 1;
    scheduledJobRuntimeState.lastSchedulerTickAt = nowIso();
    const startedAt = performance.now();
    try {
        runDueJobs();
    } catch (error) {
        scheduledJobRuntimeState.schedulerTickFailures += 1;
        logger.warn("scheduled_jobs.scheduler_tick_failed", { error });
    } finally {
        scheduledJobRuntimeState.lastSchedulerTickDurationMs =
            Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
        scheduledJobRuntimeState.isSchedulerTickRunning = false;
    }
}

/**
 * Returns queue, worker, and due-schedule telemetry without job payloads.
 * @param timestamp Timestamp value.
 * @returns queue, worker, and due-schedule telemetry without job payloads.
 */
export function getScheduledJobSchedulerMetrics(
    timestamp = Date.now()
): SchedulerMetrics {
    const dueAt = new Date(timestamp).toISOString();
    let due: {
        count: number | null | undefined;
        oldest_due_at: string | null | undefined;
    } = { count: 0, oldest_due_at: undefined };
    let queue: ReturnType<typeof getJobExecutionSummary> = {
        activeResourceClasses: [],
        oldestQueuedAgeMs: undefined,
        oldestQueuedAt: undefined,
        queued: 0,
        running: 0,
        workerCapacity: 0,
        workerCount: 0,
        workerLastHeartbeatAt: undefined,
        workerOnline: false,
    };
    try {
        due = database
            .prepare(
                `SELECT COUNT(*) AS count, MIN(next_run_at) AS oldest_due_at
                 FROM scheduled_jobs
                 WHERE enabled = 1
                   AND next_run_at IS NOT NULL
                   AND next_run_at <= ?`
            )
            .get(dueAt) as typeof due;
        queue = getJobExecutionSummary(timestamp);
    } catch {
        // Diagnostics must remain available while readiness reports a database fault.
    }
    const oldestDueAt = due.oldest_due_at ?? undefined;
    const parsedOldestDueAt = oldestDueAt ? Date.parse(oldestDueAt) : Number.NaN;
    return {
        ...queue,
        dueJobs: Number(due.count ?? 0),
        executorActive: scheduledJobRuntimeState.executor !== undefined,
        executorTickRunning: scheduledJobRuntimeState.isExecutorTickRunning,
        lastTickAt: scheduledJobRuntimeState.lastSchedulerTickAt,
        lastTickDurationMs: scheduledJobRuntimeState.lastSchedulerTickDurationMs,
        oldestDueAt,
        queueFailures: scheduledJobRuntimeState.schedulerQueueFailures,
        scheduleLagMs: Number.isFinite(parsedOldestDueAt)
            ? Math.max(0, timestamp - parsedOldestDueAt)
            : 0,
        schedulerActive: scheduledJobRuntimeState.scheduler !== undefined,
        schedulerTickRunning: scheduledJobRuntimeState.isSchedulerTickRunning,
        tickFailures: scheduledJobRuntimeState.schedulerTickFailures,
        ticks: scheduledJobRuntimeState.schedulerTicks,
    };
}

export function startScheduledJobScheduler(): void {
    if (scheduledJobRuntimeState.scheduler) {
        return;
    }
    scheduledJobRuntimeState.scheduler = setInterval(scheduleTick, schedulerTickMs);
    scheduledJobRuntimeState.scheduler.unref();
    scheduleTick();
}

function workerIdForRelease(releaseCommit: string): string {
    if (!RELEASE_COMMIT_PATTERN.test(releaseCommit)) {
        throw new Error("Job worker release commit must be an 8-40 character SHA");
    }
    return `dashboard-worker:${releaseCommit}:${process.pid}:${Bun.randomUUIDv7()}`;
}

export function startScheduledJobExecutor(releaseCommit = "development"): void {
    if (scheduledJobRuntimeState.executor) return;
    scheduledJobRuntimeState.workerId = workerIdForRelease(releaseCommit);
    resetExecutorClaimPause();
    const timestamp = nowIso();
    const recoveredOrphanedRuns = recoverOrphanedScheduledJobRuns(timestamp);
    if (recoveredOrphanedRuns > 0) {
        logger.warn("scheduled_jobs.orphaned_runs_recovered", {
            recovered: recoveredOrphanedRuns,
        });
    }
    const recovered = recoverExpiredJobExecutions(timestamp);
    if (recovered > 0) {
        logger.warn("scheduled_jobs.expired_execution_leases_recovered", {
            recovered,
        });
    }
    registerJobWorker(scheduledJobRuntimeState.workerId, executorCapacity);
    scheduledJobRuntimeState.workerHeartbeat = setInterval(() => {
        try {
            didHeartbeatJobWorker(scheduledJobRuntimeState.workerId);
        } catch (error) {
            logger.warn("scheduled_jobs.worker_heartbeat_failed", { error });
        }
    }, executorHeartbeatMs);
    scheduledJobRuntimeState.workerHeartbeat.unref();
    scheduledJobRuntimeState.executor = setInterval(executorTick, executorTickMs);
    scheduledJobRuntimeState.executor.unref();
    executorTick();
}

export function recoverOrphanedScheduledJobRuns(timestamp = nowIso()): number {
    return database
        .prepare(
            `UPDATE scheduled_job_runs
             SET status = 'failed', finished_at = ?,
                 message = 'Scheduled job interrupted before worker lease recovery'
             WHERE status = 'running'
               AND NOT EXISTS (
                   SELECT 1
                   FROM job_executions
                   WHERE scheduled_run_id = scheduled_job_runs.id
                     AND status IN ('queued', 'running')
               )`
        )
        .run(timestamp).changes;
}

export function stopScheduledJobScheduler(): void {
    if (!scheduledJobRuntimeState.scheduler) {
        return;
    }
    clearInterval(scheduledJobRuntimeState.scheduler);
    scheduledJobRuntimeState.scheduler = undefined;
}

export async function stopScheduledJobExecutor(): Promise<void> {
    if (scheduledJobRuntimeState.executor) {
        clearInterval(scheduledJobRuntimeState.executor);
        scheduledJobRuntimeState.executor = undefined;
    }
    if (scheduledJobRuntimeState.workerHeartbeat) {
        clearInterval(scheduledJobRuntimeState.workerHeartbeat);
        scheduledJobRuntimeState.workerHeartbeat = undefined;
    }
    for (const controller of activeExecutionControllers.values()) {
        controller.abort();
    }
    await Promise.allSettled(activeExecutionRuns.values());
    activeExecutionControllers.clear();
    activeExecutionRuns.clear();
    unregisterJobWorker(scheduledJobRuntimeState.workerId);
    resetExecutorClaimPause();
}
