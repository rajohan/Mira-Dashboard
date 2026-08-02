import type { SchedulerMetrics } from "../../../../contracts/metrics.ts";
import { database } from "../../database/connection.ts";
import { runWithLogContext } from "../../lib/logContext.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    getJobExecutionSummary,
    type JobExecutionRecord,
} from "../jobExecutionQueue/repository.ts";
import {
    claimNextJobExecution,
    didHeartbeatJobWorker,
    recoverExpiredJobExecutions,
    registerJobWorker,
    unregisterJobWorker,
} from "../jobExecutionQueue/worker.ts";
import {
    DeploymentCutoverReconciler,
    type DeploymentCutoverRecoveryHandler,
    type DeploymentGuardianStateReader,
} from "./deploymentCutoverReconciler.ts";
import { enqueueScheduledJob, nowIso } from "./enqueue.ts";
import { executeClaimedJobExecution, executorHeartbeatMs } from "./execution.ts";

const logger = createStructuredLogger("scheduled-jobs");

const schedulerTickMs = 30_000;
const executorTickMs = 1000;
const executorCapacity = 1;
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
                pauseExecutorClaims,
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
