import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";

export function isDirectWorkerEntrypoint(
    argvPath = process.argv[1],
    moduleUrl = import.meta.url
): boolean {
    return Boolean(argvPath && moduleUrl === Bun.pathToFileURL(argvPath).href);
}

export async function runDashboardWorker(): Promise<void> {
    startDashboardJobWorker();
    const shutdown = Promise.withResolvers<NodeJS.Signals>();
    const stop = (signal: NodeJS.Signals) => shutdown.resolve(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await shutdown.promise;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await stopDashboardJobWorker();
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
