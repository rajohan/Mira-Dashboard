import { validateAuthenticationConfig, validateStoredSecretConfig } from "./auth.ts";
import { getRuntimeReleaseIdentity } from "./releaseManifest.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";

const WORKER_KEEP_ALIVE_INTERVAL_MS = 60_000;

export { runLogRotationCli } from "./services/logRotation.ts";

export function isDirectWorkerEntrypoint(isMain = import.meta.main): boolean {
    return isMain;
}

/** Keeps the dedicated worker process referenced while its runtime timers are idle. */
export function createWorkerKeepAliveHandle(): NodeJS.Timeout {
    return setInterval(() => 0, WORKER_KEEP_ALIVE_INTERVAL_MS);
}

export async function runDashboardWorker(): Promise<void> {
    const release = await getRuntimeReleaseIdentity();
    if (process.env.NODE_ENV === "production" && !release.ready) {
        throw new Error(
            `Worker release identity is not ready (${release.issue ?? release.source})`
        );
    }
    const releaseCommit = release.commitSha ?? release.backendCommit;
    if (!/^[\da-f]{8,40}$/u.test(releaseCommit)) {
        throw new Error("Worker release identity does not contain a valid commit");
    }
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
        console.error("[Worker] Failed:", error);
        process.exitCode = 1;
    }
}
