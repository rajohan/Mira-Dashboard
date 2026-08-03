import { startScheduledJobExecutor } from "../../src/services/scheduledJobs/runtime.ts";

const TEST_EXECUTOR_TICK_INTERVAL_MS = 10;

/**
 * Starts the real queue worker with a short polling interval for deterministic tests.
 * @param releaseCommit Release identity used by the test worker.
 */
export function startTestScheduledJobExecutor(releaseCommit = "development"): void {
    startScheduledJobExecutor(releaseCommit, {
        tickIntervalMs: TEST_EXECUTOR_TICK_INTERVAL_MS,
    });
}
