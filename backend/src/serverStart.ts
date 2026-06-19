import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { registerBackupScheduledJobs } from "./routes/backups.ts";
import { resolveListenPort, server } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import {
    registerCacheRefreshScheduledJobs,
    waitForLocalCacheSeed,
} from "./services/cacheRefresh.ts";
import { registerDockerUpdaterScheduledJobs } from "./services/dockerUpdater.ts";
import { registerLogRotationScheduledJobs } from "./services/logRotation.ts";
import { registerOpenClawNotificationScheduledJobs } from "./services/openclawNotifications.ts";
import {
    runQuotaNotificationCheck,
    shouldRegisterQuotaNotificationScheduledJobs,
} from "./services/quotaNotifications.ts";
import {
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
} from "./services/scheduledJobs.ts";

const serverStartState: { stopSchedulerOnServerClose?: () => void; isStarting: boolean } =
    {
        isStarting: false,
    };

export { runLogRotationCli } from "./services/logRotation.ts";

function installSchedulerCloseCleanup(): void {
    if (serverStartState.stopSchedulerOnServerClose) {
        return;
    }
    serverStartState.stopSchedulerOnServerClose = () => {
        stopScheduledJobScheduler();
        serverStartState.stopSchedulerOnServerClose = undefined;
    };
    server.once("close", serverStartState.stopSchedulerOnServerClose);
}

function removeSchedulerCloseCleanup(): void {
    if (!serverStartState.stopSchedulerOnServerClose) {
        return;
    }

    server.removeListener("close", serverStartState.stopSchedulerOnServerClose);
    serverStartState.stopSchedulerOnServerClose = undefined;
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

export function resolveGatewayToken(
    environment = process.env,
    persistedToken = getPersistedGatewayToken
): string | undefined {
    return (
        environment.OPENCLAW_GATEWAY_TOKEN?.trim() ||
        environment.OPENCLAW_TOKEN?.trim() ||
        persistedToken()?.trim() ||
        undefined
    );
}

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(): void {
    let isGatewayStarted = false;
    let isScheduledJobSchedulerStarted = false;
    let shouldQueueStartupQuotaCheck = true;
    try {
        const token = resolveGatewayToken();
        if (token) {
            gateway.init(token);
            isGatewayStarted = true;
        } else {
            console.warn(
                "[Backend] No gateway token configured yet; waiting for bootstrap registration"
            );
        }

        if (shouldStartScheduledJobs()) {
            registerBackupScheduledJobs();
            registerCacheRefreshScheduledJobs();
            registerDockerUpdaterScheduledJobs();
            registerLogRotationScheduledJobs();
            shouldQueueStartupQuotaCheck = shouldRegisterQuotaNotificationScheduledJobs();
            registerOpenClawNotificationScheduledJobs();
            startScheduledJobScheduler();
            isScheduledJobSchedulerStarted = true;
            installSchedulerCloseCleanup();
        }
        if (shouldQueueStartupQuotaCheck) {
            queueQuotaNotificationCheckAfterSeed();
        }
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
        const rollback = (function_: () => void, label: string): void => {
            try {
                function_();
            } catch (cleanupError) {
                console.error(label, cleanupError);
            }
        };
        if (isScheduledJobSchedulerStarted) {
            removeSchedulerCloseCleanup();
            rollback(
                stopScheduledJobScheduler,
                "[Backend] Failed to stop scheduled job scheduler:"
            );
        }
        if (isGatewayStarted) {
            rollback(() => gateway.shutdown(), "[Backend] Failed to stop gateway:");
        }
        rollback(() => server.close(), "[Backend] Failed to close server:");
        throw error;
    }
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): void {
    if (server.listening || server.address() !== null || serverStartState.isStarting) {
        return;
    }
    serverStartState.isStarting = true;
    const onListening = () => {
        server.removeListener("error", onError);
        serverStartState.isStarting = false;
    };
    const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        server.removeListener("error", onError);
        serverStartState.isStarting = false;
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
        serverStartState.isStarting = false;
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
    isDirect = isDirectEntrypoint()
): boolean {
    return startOnImport === "1" || isDirect;
}

if (shouldStartOnImport()) {
    startBackendServer();
}
