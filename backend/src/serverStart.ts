import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { createServer, resolveListenPort } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import { registerBackupScheduledJobs } from "./services/backups.ts";
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

const serverStartState: {
    activeServer: ReturnType<typeof createServer> | null;
    stopSchedulerOnServerClose?: () => void;
    isStarting: boolean;
} = {
    activeServer: null,
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
}

function removeSchedulerCloseCleanup(): void {
    if (!serverStartState.stopSchedulerOnServerClose) {
        return;
    }

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
        rollback(() => {
            serverStartState.activeServer?.stop(true);
            serverStartState.activeServer = null;
        }, "[Backend] Failed to close server:");
        throw error;
    }
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): void {
    if (serverStartState.activeServer || serverStartState.isStarting) {
        return;
    }
    serverStartState.isStarting = true;
    try {
        serverStartState.activeServer = createServer(port);
        handleServerListening();
        serverStartState.isStarting = false;
    } catch (error) {
        serverStartState.isStarting = false;
        serverStartState.activeServer = null;
        console.error("[Backend] Failed to start server:", error);
        process.exitCode = 1;
        throw error;
    }
}

export async function stopBackendServer(): Promise<void> {
    const server = serverStartState.activeServer;
    serverStartState.activeServer = null;
    try {
        removeSchedulerCloseCleanup();
        stopScheduledJobScheduler();
        gateway.shutdown();
    } finally {
        await server?.stop(true);
    }
}

export function isDirectEntrypoint(
    argvPath = process.argv[1],
    moduleUrl = import.meta.url
): boolean {
    return Boolean(argvPath && moduleUrl === Bun.pathToFileURL(argvPath).href);
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
