import { pathToFileURL } from "node:url";

import { getPersistedGatewayToken } from "./auth.js";
import gateway from "./gateway.js";
import { resolveListenPort, server } from "./server.js";
import { startOpenClawNotificationMonitor } from "./services/openclawNotifications.js";
import { startQuotaNotificationMonitor } from "./services/quotaNotifications.js";

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(): void {
    const token = getPersistedGatewayToken() || process.env.OPENCLAW_TOKEN;
    if (token) {
        gateway.init(token);
    } else {
        console.warn(
            "[Backend] No gateway token configured yet; waiting for bootstrap registration"
        );
    }

    startQuotaNotificationMonitor();
    startOpenClawNotificationMonitor();
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): void {
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
