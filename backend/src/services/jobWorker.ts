import { registerBackupScheduledJobs } from "./backups.ts";
import {
    DATABASE_SUMMARY_KEY,
    enqueueDatabaseSummaryRefresh,
    registerCacheRefreshScheduledJobs,
} from "./cacheRefresh.ts";
import { registerDockerExecutionActions } from "./dockerActions.ts";
import { registerDockerUpdaterScheduledJobs } from "./dockerUpdater.ts";
import { registerExecExecutionActions } from "./execJobs.ts";
import { registerGitHygieneScheduledJobs } from "./gitHygiene.ts";
import { registerLogRotationScheduledJobs } from "./logRotation.ts";
import { registerOpenClawExecutionActions } from "./openclawActions.ts";
import { registerPullRequestPreviewExecutionActions } from "./pullRequestPreviews.ts";
import { registerPullRequestExecutionActions } from "./pullRequests.ts";
import {
    startScheduledJobExecutor,
    startScheduledJobScheduler,
    stopScheduledJobExecutor,
    stopScheduledJobScheduler,
} from "./scheduledJobs.ts";
import { registerSqliteMaintenanceScheduledJob } from "./sqliteMaintenance.ts";

const workerState: {
    isStarted: boolean;
    pendingStop?: Promise<void>;
    stopGeneration: number;
} = {
    isStarted: false,
    stopGeneration: 0,
};

export type DashboardJobProfile = "full" | "isolated";

/** Selects whether the worker may register host-control execution actions. */
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

/** Starts the persistent queue scheduler and its single-concurrency executor. */
export function startDashboardJobWorker(releaseCommit = "development"): void {
    if (workerState.isStarted || workerState.pendingStop) return;
    workerState.isStarted = true;
    try {
        registerScheduledActions();
        startScheduledJobExecutor(releaseCommit);
        startScheduledJobScheduler();
    } catch (error) {
        stopScheduledJobScheduler();
        void trackWorkerStop(async () => {
            try {
                await stopScheduledJobExecutor();
                workerState.isStarted = false;
            } catch (cleanupError) {
                console.error(
                    "[JobWorker] Failed to roll back executor startup:",
                    cleanupError
                );
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
            // Release the startup guard only after executor cleanup succeeds.
            workerState.isStarted = false;
        });
        return;
    }
}
