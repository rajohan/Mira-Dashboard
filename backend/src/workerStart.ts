import { validateAuthenticationConfig, validateStoredSecretConfig } from "./auth.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";
import {
    getRuntimeReleaseIdentity,
    requireRunnableReleaseCommit,
} from "./releaseManifest.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";

const WORKER_KEEP_ALIVE_INTERVAL_MS = 60_000;
const logger = createStructuredLogger("worker");

export { runLogRotationCli } from "./services/logRotation.ts";

export function isDirectWorkerEntrypoint(isMain = import.meta.main): boolean {
    return isMain;
}

/**
 * Keeps the dedicated worker process referenced while its runtime timers are idle.
 * @returns Create worker keep alive handle result.
 */
export function createWorkerKeepAliveHandle(): NodeJS.Timeout {
    return setInterval(() => 0, WORKER_KEEP_ALIVE_INTERVAL_MS);
}

export async function runDashboardWorker(): Promise<void> {
    const release = await getRuntimeReleaseIdentity();
    const releaseCommit = requireRunnableReleaseCommit(release, "Worker");
    validateAuthenticationConfig();
    validateStoredSecretConfig();
    const shutdown = Promise.withResolvers<NodeJS.Signals>();
    const stop = (signal: NodeJS.Signals) => shutdown.resolve(signal);
    const keepAlive = createWorkerKeepAliveHandle();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        startDashboardJobWorker(releaseCommit);
        await shutdown.promise;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        try {
            await stopDashboardJobWorker();
        } finally {
            clearInterval(keepAlive);
        }
    }
}

if (isDirectWorkerEntrypoint()) {
    try {
        await runDashboardWorker();
    } catch (error) {
        logger.error("worker.entrypoint_failed", { error });
        process.exitCode = 1;
    }
}
