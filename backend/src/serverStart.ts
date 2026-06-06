import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.js";
import gateway from "./gateway.js";
import { resolveListenPort, server } from "./server.js";
import {
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
} from "./services/scheduledJobs.js";

let isStarting = false;
let afterBackgroundServicesStartedForTest: (() => void) | undefined;

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

        startScheduledJobScheduler();
        scheduledJobSchedulerStarted = true;
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
    setAfterBackgroundServicesStartedForTest(callback: (() => void) | undefined): void {
        afterBackgroundServicesStartedForTest = callback;
    },
};
