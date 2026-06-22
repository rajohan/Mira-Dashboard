import path from "node:path";

import gateway from "./gateway.ts";
import { json } from "./http.ts";
import { withRequestPolicy } from "./requestPolicy.ts";
import { agentRoutes } from "./routes/agentRoutes.ts";
import { authRoutes } from "./routes/authRoutes.ts";
import { backupRoutes } from "./routes/backupRoutes.ts";
import { cacheRoutes } from "./routes/cacheRoutes.ts";
import { configFileRoutes } from "./routes/configFileRoutes.ts";
import { cronRoutes } from "./routes/cronRoutes.ts";
import { databaseRoutes } from "./routes/databaseRoutes.ts";
import { dockerRoutes } from "./routes/dockerRoutes.ts";
import { execRoutes } from "./routes/execRoutes.ts";
import { fileRoutes } from "./routes/fileRoutes.ts";
import { jobRoutes } from "./routes/jobRoutes.ts";
import { logRoutes } from "./routes/logRoutes.ts";
import { mediaRoutes } from "./routes/mediaRoutes.ts";
import { metricsRoutes } from "./routes/metricsRoutes.ts";
import { moltbookRoutes } from "./routes/moltbookRoutes.ts";
import { notificationRoutes } from "./routes/notificationRoutes.ts";
import { openclawConfigRoutes } from "./routes/openclawConfigRoutes.ts";
import { opsRoutes } from "./routes/opsRoutes.ts";
import { pullRequestRoutes } from "./routes/pullRequestRoutes.ts";
import { sessionRoutes } from "./routes/sessionRoutes.ts";
import { settingsRoutes } from "./routes/settingsRoutes.ts";
import { sttRoutes } from "./routes/sttRoutes.ts";
import { taskRoutes } from "./routes/taskRoutes.ts";
import { terminalRoutes } from "./routes/terminalRoutes.ts";
import { ttsRoutes } from "./routes/ttsRoutes.ts";

const BACKEND_COMMIT = (() => {
    try {
        return (
            Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
                cwd: path.join(import.meta.dirname, ".."),
                stderr: "ignore",
            })
                .stdout?.toString()
                ?.trim() || "unknown"
        );
    } catch {
        return "unknown";
    }
})();

function backendCommit(): string {
    return BACKEND_COMMIT;
}

function health() {
    return json({
        status: "isOk",
        gatewayConnected: gateway.isConnected(),
        sessionCount: gateway.getSessions().length,
        backendCommit: backendCommit() || "unknown",
    });
}

function sessions() {
    return json(gateway.getSessions());
}

const routeTable = {
    "/health": {
        GET: health,
    },
    "/api/health": {
        GET: health,
    },
    "/api/sessions": {
        GET: sessions,
    },
    ...agentRoutes,
    ...authRoutes,
    ...backupRoutes,
    ...cacheRoutes,
    ...configFileRoutes,
    ...cronRoutes,
    ...databaseRoutes,
    ...dockerRoutes,
    ...execRoutes,
    ...fileRoutes,
    ...jobRoutes,
    ...logRoutes,
    ...mediaRoutes,
    ...metricsRoutes,
    ...moltbookRoutes,
    ...notificationRoutes,
    ...opsRoutes,
    ...openclawConfigRoutes,
    ...pullRequestRoutes,
    ...sessionRoutes,
    ...settingsRoutes,
    ...sttRoutes,
    ...taskRoutes,
    ...terminalRoutes,
    ...ttsRoutes,
    "/api/*": () => json({ error: "Not found" }, { status: 404 }),
} as const;

export const routes = withRequestPolicy(routeTable);
