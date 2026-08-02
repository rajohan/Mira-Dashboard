import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { registerBackupScheduledJobs } from "./backups/scheduling.ts";
import {
    enqueueDatabaseSummaryRefresh,
    registerCacheRefreshScheduledJobs,
} from "./cacheRefresh/cacheRefreshScheduler.ts";
import { DATABASE_SUMMARY_KEY } from "./cacheRefresh/databaseSummaryCacheProducer.ts";
import {
    startCacheRefreshMetricsSession,
    stopCacheRefreshMetricsSession,
} from "./cacheRefreshMetrics.ts";
import { registerDockerExecutionActions } from "./dockerActions.ts";
import { registerDockerUpdaterScheduledJobs } from "./dockerUpdater/scheduler.ts";
import { registerExecExecutionActions } from "./execJobs.ts";
import { registerGitHygieneScheduledJobs } from "./gitHygiene/scheduler.ts";
import { registerLogRotationScheduledJobs } from "./logRotation/scheduler.ts";
import { registerOpenClawExecutionActions } from "./openclawActions.ts";
import { registerPullRequestPreviewExecutionActions } from "./pullRequestPreviews/service.ts";
import { registerPullRequestExecutionActions } from "./pullRequests/executionActions.ts";
import {
    startScheduledJobExecutor,
    startScheduledJobScheduler,
    stopScheduledJobExecutor,
    stopScheduledJobScheduler,
} from "./scheduledJobs/runtime.ts";
import { registerSqliteMaintenanceScheduledJob } from "./sqliteMaintenance.ts";

const logger = createStructuredLogger("job-worker");

const workerState: {
    isStarted: boolean;
    pendingStop?: Promise<void>;
    stopGeneration: number;
} = {
    isStarted: false,
    stopGeneration: 0,
};

export type DashboardJobProfile = "full" | "isolated";

/**
 * Selects whether the worker may register host-control execution actions.
 * @returns Dashboard job profile result.
 */
export function dashboardJobProfile(
    environment: Record<string, string | undefined> = process.env
): DashboardJobProfile {
    return environment.NODE_ENV !== "production" &&
        environment.MIRA_DASHBOARD_DEV_SAFE_MODE === "1"
        ? "isolated"
        : "full";
}

function trackWorkerStop(operation: () => Promise<void>): Promise<void> {
    const generation = ++workerState.stopGeneration;
    const pendingStop = (async () => {
        try {
            await operation();
        } finally {
            if (workerState.stopGeneration === generation) {
                workerState.pendingStop = undefined;
            }
        }
    })();
    workerState.pendingStop = pendingStop;
    return pendingStop;
}

function registerScheduledActions(profile = dashboardJobProfile()): void {
    registerCacheRefreshScheduledJobs({
        ...(profile === "isolated" && {
            allowedKeys: [DATABASE_SUMMARY_KEY],
        }),
        refreshDatabaseOnStartup: true,
        seedStrategy: "queue",
    });
    registerSqliteMaintenanceScheduledJob({
        enqueueDatabaseSummaryRefresh,
    });
    if (profile === "isolated") {
        return;
    }
    registerBackupScheduledJobs();
    registerDockerExecutionActions();
    registerDockerUpdaterScheduledJobs();
    registerExecExecutionActions();
    registerGitHygieneScheduledJobs();
    registerLogRotationScheduledJobs();
    registerOpenClawExecutionActions();
    registerPullRequestExecutionActions();
    registerPullRequestPreviewExecutionActions();
}

function startCacheRefreshMetrics(): void {
    try {
        startCacheRefreshMetricsSession();
    } catch (error) {
        logger.warn("job_worker.cache_refresh_metrics_start_failed", { error });
    }
}

function stopCacheRefreshMetrics(): void {
    try {
        stopCacheRefreshMetricsSession();
    } catch (error) {
        logger.warn("job_worker.cache_refresh_metrics_stop_failed", { error });
    }
}

/**
 * Starts the persistent queue scheduler and its single-concurrency executor.
 * @param releaseCommit Release commit value.
 */
export function startDashboardJobWorker(releaseCommit = "development"): void {
    if (workerState.isStarted || workerState.pendingStop) return;
    workerState.isStarted = true;
    const profile = dashboardJobProfile();
    try {
        startCacheRefreshMetrics();
        registerScheduledActions(profile);
        startScheduledJobExecutor(releaseCommit);
        startScheduledJobScheduler();
        logger.info("job_worker.started", { profile, releaseCommit });
    } catch (error) {
        stopScheduledJobScheduler();
        void trackWorkerStop(async () => {
            try {
                await stopScheduledJobExecutor();
                workerState.isStarted = false;
                stopCacheRefreshMetrics();
            } catch (cleanupError) {
                logger.error("job_worker.executor_startup_rollback_failed", {
                    error: cleanupError,
                });
            }
        });
        throw error;
    }
}

/** Stops claims first, then cooperatively aborts the active execution. */
export async function stopDashboardJobWorker(): Promise<void> {
    for (;;) {
        const pendingStop = workerState.pendingStop;
        if (pendingStop) {
            await pendingStop;
            continue;
        }
        if (!workerState.isStarted) return;
        await trackWorkerStop(async () => {
            stopScheduledJobScheduler();
            await stopScheduledJobExecutor();
            stopCacheRefreshMetrics();
            // Release the startup guard only after executor cleanup succeeds.
            workerState.isStarted = false;
            logger.info("job_worker.stopped");
        });
        return;
    }
}
