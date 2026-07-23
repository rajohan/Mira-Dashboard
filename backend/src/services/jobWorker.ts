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

const workerState: {
    isStarted: boolean;
    pendingStop?: Promise<void>;
    stopGeneration: number;
} = {
    isStarted: false,
    stopGeneration: 0,
};

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
    if (workerState.isStarted || workerState.pendingStop) return;
    workerState.isStarted = true;
    try {
        registerScheduledActions();
        startScheduledJobExecutor();
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
