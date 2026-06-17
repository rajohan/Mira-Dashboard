import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.js";
import gateway from "./gateway.js";
import { registerBackupScheduledJobs } from "./routes/backups.js";
import { resolveListenPort, server } from "./server.js";
import {
    registerCacheRefreshScheduledJobs,
    waitForLocalCacheSeed,
} from "./services/cacheRefresh.js";
import { registerDockerUpdaterScheduledJobs } from "./services/dockerUpdater.js";
import { registerOpenClawNotificationScheduledJobs } from "./services/openclawNotifications.js";
import {
    registerQuotaNotificationScheduledJobs,
    runQuotaNotificationCheck,
} from "./services/quotaNotifications.js";
import {
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
} from "./services/scheduledJobs.js";

let isStarting = false;
let afterBackgroundServicesStartedForTest: (() => void) | undefined;
let stopSchedulerOnServerClose: (() => void) | undefined;

function isPackagedServerEntrypoint(argvPath = process.argv[1]): boolean {
    return Boolean(argvPath?.replaceAll("\\", "/").endsWith("/dist/serverStart.js"));
}

function shouldStartScheduledJobs(
    nodeEnv = process.env.NODE_ENV,
    disableScheduler = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER,
    argvPath = process.argv[1]
): boolean {
    if (disableScheduler === "1" || nodeEnv === "development" || nodeEnv === "test") {
        return false;
    }
    return nodeEnv === "production" || isPackagedServerEntrypoint(argvPath);
}

function installSchedulerCloseCleanup(): void {
    if (stopSchedulerOnServerClose) {
        return;
    }
    stopSchedulerOnServerClose = () => {
        stopScheduledJobScheduler();
        stopSchedulerOnServerClose = undefined;
    };
    server.once("close", stopSchedulerOnServerClose);
}

function removeSchedulerCloseCleanup(): void {
    if (!stopSchedulerOnServerClose) {
        return;
    }

    server.removeListener("close", stopSchedulerOnServerClose);
    stopSchedulerOnServerClose = undefined;
}

function queueQuotaNotificationCheckAfterSeed(
    seedPromise = waitForLocalCacheSeed("quotas.summary"),
    notificationCheck = runQuotaNotificationCheck
): void {
    void (async () => {
        try {
            await seedPromise;
            try {
                await notificationCheck();
            } catch (error) {
                console.warn("[Backend] Startup quota notification check failed:", error);
            }
        } catch (error) {
            console.warn(
                "[Backend] Skipping startup quota notification check after cache seed failure:",
                error
            );
        }
    })();
}

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(): void {
    let gatewayStarted = false;
    let scheduledJobSchedulerStarted = false;
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

        if (shouldStartScheduledJobs()) {
            registerBackupScheduledJobs();
            registerCacheRefreshScheduledJobs();
            registerDockerUpdaterScheduledJobs();
            registerQuotaNotificationScheduledJobs();
            registerOpenClawNotificationScheduledJobs();
            startScheduledJobScheduler();
            scheduledJobSchedulerStarted = true;
            installSchedulerCloseCleanup();
        }
        queueQuotaNotificationCheckAfterSeed();
        afterBackgroundServicesStartedForTest?.();
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
        const rollback = (fn: () => void, label: string): void => {
            try {
                fn();
            } catch (cleanupError) {
                console.error(label, cleanupError);
            }
        };
        if (scheduledJobSchedulerStarted) {
            removeSchedulerCloseCleanup();
            rollback(
                stopScheduledJobScheduler,
                "[Backend] Failed to stop scheduled job scheduler:"
            );
        }
        if (gatewayStarted) {
            rollback(() => gateway.shutdown(), "[Backend] Failed to stop gateway:");
        }
        rollback(() => server.close(), "[Backend] Failed to close server:");
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
        server.close();
    };
    server.once("listening", onListening);
    server.once("error", onError);
    try {
        server.listen(port, handleServerListening);
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

export const __testing = {
    queueQuotaNotificationCheckAfterSeed,
    removeSchedulerCloseCleanup,
    setAfterBackgroundServicesStartedForTest(callback: (() => void) | undefined): void {
        afterBackgroundServicesStartedForTest = callback;
    },
    shouldStartScheduledJobs,
};
