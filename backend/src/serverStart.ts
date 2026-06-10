import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.js";
import gateway from "./gateway.js";
import { resolveListenPort, server } from "./server.js";
import {
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
} from "./services/scheduledJobs.js";

let isStarting = false;
let afterBackgroundServicesStartedForTest: (() => void | Promise<void>) | undefined;
const closeCleanups: Array<() => void | Promise<void>> = [];
let closeCleanupInstalled = false;
let closeCleanupPromise: Promise<void> | undefined;

function onServerClose(): void {
    closeCleanupPromise = runCloseCleanups();
    void closeCleanupPromise.finally(() => {
        closeCleanupPromise = undefined;
    });
}

async function rollback(fn: () => void | Promise<void>, label: string): Promise<unknown> {
    try {
        return await fn();
    } catch (cleanupError) {
        console.error(label, cleanupError);
        return cleanupError;
    }
}

function installCloseCleanup(cleanup: () => void | Promise<void>): () => void {
    closeCleanups.push(cleanup);
    if (!closeCleanupInstalled) {
        closeCleanupInstalled = true;
        server.once("close", onServerClose);
    }
    return () => removeCloseCleanup(cleanup);
}

function removeCloseCleanup(cleanup?: () => void | Promise<void>): void {
    if (cleanup) {
        const index = closeCleanups.lastIndexOf(cleanup);
        if (index !== -1) {
            closeCleanups.splice(index, 1);
        }
    } else {
        closeCleanups.length = 0;
    }
    closeCleanupPromise = undefined;

    if (!closeCleanupInstalled || closeCleanups.length > 0) {
        return;
    }
    server.off("close", onServerClose);
    closeCleanupInstalled = false;
}

async function runCloseCleanups(): Promise<void> {
    closeCleanupInstalled = false;
    const cleanups = closeCleanups.splice(0);
    await Promise.all(
        cleanups.map((cleanup) =>
            rollback(cleanup, "[Backend] Failed to run server close cleanup:")
        )
    );
}

async function closeServerForRollback(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
    await (closeCleanupPromise ?? runCloseCleanups());
    closeCleanupPromise = undefined;
}

/** Starts Gateway and the scheduled job scheduler after the HTTP server is listening. */
export async function handleServerListening(): Promise<void> {
    let gatewayStarted = false;
    let scheduledJobSchedulerStarted = false;
    let removeBackgroundCleanup: (() => void) | undefined;
    try {
        const token = getPersistedGatewayToken() || process.env.OPENCLAW_TOKEN;
        if (token) {
            gateway.init(token);
            gatewayStarted = true;
        } else {
            console.warn(
                "[Backend] No gateway token configured yet; waiting for bootstrap registration"
            );
        }

        startScheduledJobScheduler();
        scheduledJobSchedulerStarted = true;
        removeBackgroundCleanup = installCloseCleanup(async () => {
            if (scheduledJobSchedulerStarted) {
                await rollback(
                    stopScheduledJobScheduler,
                    "[Backend] Failed to stop scheduled job scheduler:"
                );
            }
            if (gatewayStarted) {
                await rollback(
                    () => gateway.shutdown(),
                    "[Backend] Failed to stop gateway:"
                );
            }
        });
        await afterBackgroundServicesStartedForTest?.();
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
        removeBackgroundCleanup?.();
        if (scheduledJobSchedulerStarted) {
            await rollback(
                stopScheduledJobScheduler,
                "[Backend] Failed to stop scheduled job scheduler:"
            );
        }
        if (gatewayStarted) {
            await rollback(() => gateway.shutdown(), "[Backend] Failed to stop gateway:");
        }
        await rollback(closeServerForRollback, "[Backend] Failed to close server:");
        throw error;
    }
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): void {
    if (server.listening || server.address() !== null || isStarting) {
        return;
    }
    isStarting = true;
    const onListening = () => {
        server.removeListener("error", onError);
        isStarting = false;
    };
    const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        server.removeListener("error", onError);
        isStarting = false;
        console.error("[Backend] Failed to start server:", error);
        process.exitCode = 1;
        void rollback(closeServerForRollback, "[Backend] Failed to close server:");
    };
    server.once("listening", onListening);
    server.once("error", onError);
    try {
        server.listen(port, () => {
            void handleServerListening().catch(() => {
                process.exitCode = 1;
            });
        });
    } catch (error) {
        server.removeListener("listening", onListening);
        server.removeListener("error", onError);
        isStarting = false;
        throw error;
    }
}

export function isDirectEntrypoint(
    argvPath = process.argv[1],
    moduleUrl = import.meta.url
): boolean {
    return Boolean(argvPath && moduleUrl === pathToFileURL(argvPath).href);
}

export function shouldStartOnImport(
    startOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT,
    directEntrypoint = isDirectEntrypoint()
): boolean {
    return startOnImport === "1" || directEntrypoint;
}

if (shouldStartOnImport()) {
    startBackendServer();
}

function setAfterBackgroundServicesStartedForTest(
    callback: (() => void | Promise<void>) | undefined
): void {
    afterBackgroundServicesStartedForTest = callback;
}

export const __testing = Object.freeze({
    installCloseCleanup,
    removeCloseCleanup,
    setAfterBackgroundServicesStartedForTest,
});
