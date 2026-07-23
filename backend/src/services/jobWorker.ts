import { registerBackupScheduledJobs } from "./backups.ts";
import { registerCacheRefreshScheduledJobs } from "./cacheRefresh.ts";
import { registerDockerExecutionActions } from "./dockerActions.ts";
import { registerDockerUpdaterScheduledJobs } from "./dockerUpdater.ts";
import { registerExecExecutionActions } from "./execJobs.ts";
import { registerGitHygieneScheduledJobs } from "./gitHygiene.ts";
import { registerLogRotationScheduledJobs } from "./logRotation.ts";
import { registerOpenClawExecutionActions } from "./openclawActions.ts";
import { registerPullRequestExecutionActions } from "./pullRequests.ts";
import {
    startScheduledJobExecutor,
    startScheduledJobScheduler,
    stopScheduledJobExecutor,
    stopScheduledJobScheduler,
} from "./scheduledJobs.ts";

const workerState: { isStarted: boolean; isStopping: boolean } = {
    isStarted: false,
    isStopping: false,
};

function registerScheduledActions(): void {
    registerBackupScheduledJobs();
    registerCacheRefreshScheduledJobs({ seedStrategy: "queue" });
    registerDockerExecutionActions();
    registerDockerUpdaterScheduledJobs();
    registerExecExecutionActions();
    registerGitHygieneScheduledJobs();
    registerLogRotationScheduledJobs();
    registerOpenClawExecutionActions();
    registerPullRequestExecutionActions();
}

/** Starts the persistent queue scheduler and its single-concurrency executor. */
export function startDashboardJobWorker(): void {
    if (workerState.isStarted || workerState.isStopping) return;
    workerState.isStarted = true;
    try {
        registerScheduledActions();
        startScheduledJobExecutor();
        startScheduledJobScheduler();
    } catch (error) {
        stopScheduledJobScheduler();
        workerState.isStarted = false;
        workerState.isStopping = true;
        void stopScheduledJobExecutor()
            .catch((cleanupError) => {
                console.error(
                    "[JobWorker] Failed to roll back executor startup:",
                    cleanupError
                );
            })
            .finally(() => {
                workerState.isStopping = false;
            });
        throw error;
    }
}

/** Stops claims first, then cooperatively aborts the active execution. */
export async function stopDashboardJobWorker(): Promise<void> {
    if (!workerState.isStarted || workerState.isStopping) return;
    workerState.isStopping = true;
    try {
        stopScheduledJobScheduler();
        await stopScheduledJobExecutor();
        workerState.isStarted = false;
    } finally {
        workerState.isStopping = false;
    }
}
