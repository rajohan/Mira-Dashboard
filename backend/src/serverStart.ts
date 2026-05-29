import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.js";
import gateway from "./gateway.js";
import { resolveListenPort, server } from "./server.js";
import {
    startOpenClawNotificationMonitor,
    stopOpenClawNotificationMonitor,
} from "./services/openclawNotifications.js";
import {
    startQuotaNotificationMonitor,
    stopQuotaNotificationMonitor,
} from "./services/quotaNotifications.js";

let isStarting = false;

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(): void {
    let gatewayStarted = false;
    let quotaMonitorStarted = false;
    let openClawMonitorStarted = false;
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

        startQuotaNotificationMonitor();
        quotaMonitorStarted = true;
        openClawMonitorStarted = true;
        startOpenClawNotificationMonitor();
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
        if (openClawMonitorStarted) {
            stopOpenClawNotificationMonitor();
        }
        if (quotaMonitorStarted) {
            stopQuotaNotificationMonitor();
        }
        if (gatewayStarted) {
            gateway.shutdown();
        }
        server.close();
        throw error;
    }
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): void {
    if (server.listening || server.address() !== null || isStarting) {
        return;
    }
    isStarting = true;
    server.once("listening", () => {
        isStarting = false;
    });
    server.once("error", () => {
        isStarting = false;
    });
    server.listen(port, handleServerListening);
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
