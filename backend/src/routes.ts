import gateway from "./gateway.ts";
import { diagnosticsSnapshot, livenessSnapshot, readinessSnapshot } from "./health.ts";
import { json } from "./http.ts";
import { withRequestPolicy } from "./requestPolicy.ts";
import { accountSecurityRoutes } from "./routes/accountSecurityRoutes.ts";
import { agentRoutes } from "./routes/agentRoutes.ts";
import { auditRoutes } from "./routes/auditRoutes.ts";
import { authRoutes } from "./routes/authRoutes.ts";
import { backupRoutes } from "./routes/backupRoutes.ts";
import { cacheRoutes } from "./routes/cacheRoutes.ts";
import { configFileRoutes } from "./routes/configFileRoutes.ts";
import { cronRoutes } from "./routes/cronRoutes.ts";
import { databaseRoutes } from "./routes/databaseRoutes.ts";
import { dockerRoutes } from "./routes/dockerRoutes.ts";
import { execRoutes } from "./routes/execRoutes.ts";
import { fileRoutes } from "./routes/fileRoutes.ts";
import { jobExecutionRoutes } from "./routes/jobExecutionRoutes.ts";
import { jobRoutes } from "./routes/jobRoutes.ts";
import { logRoutes } from "./routes/logRoutes.ts";
import { mediaRoutes } from "./routes/mediaRoutes.ts";
import { metricsRoutes } from "./routes/metricsRoutes.ts";
import { moltbookRoutes } from "./routes/moltbookRoutes.ts";
import { notificationRoutes } from "./routes/notificationRoutes.ts";
import { openclawConfigRoutes } from "./routes/openclawConfigRoutes.ts";
import { opsRoutes } from "./routes/opsRoutes.ts";
import { pullRequestRoutes } from "./routes/pullRequestRoutes.ts";
import { reportRoutes } from "./routes/reportRoutes.ts";
import { sessionRoutes } from "./routes/sessionRoutes.ts";
import { settingsRoutes } from "./routes/settingsRoutes.ts";
import { sttRoutes } from "./routes/sttRoutes.ts";
import { taskRoutes } from "./routes/taskRoutes.ts";
import { terminalRoutes } from "./routes/terminalRoutes.ts";
import { ttsRoutes } from "./routes/ttsRoutes.ts";
import { routeFailureResponse } from "./routeSupport.ts";
function live() {
    return json(livenessSnapshot());
}

async function ready() {
    const snapshot = await readinessSnapshot();
    return json(snapshot, { status: snapshot.status === "isReady" ? 200 : 503 });
}

async function diagnostics() {
    return json(await diagnosticsSnapshot());
}

function sessions() {
    return json(gateway.getSessions());
}

const routeTable = {
    "/api/health/diagnostics": {
        GET: diagnostics,
    },
    "/api/health/live": {
        GET: live,
        HEAD: live,
    },
    "/api/health/ready": {
        GET: ready,
        HEAD: ready,
    },
    "/api/sessions": {
        GET: sessions,
    },
    ...accountSecurityRoutes,
    ...agentRoutes,
    ...auditRoutes,
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
    ...jobExecutionRoutes,
    ...logRoutes,
    ...mediaRoutes,
    ...metricsRoutes,
    ...moltbookRoutes,
    ...notificationRoutes,
    ...opsRoutes,
    ...openclawConfigRoutes,
    ...pullRequestRoutes,
    ...reportRoutes,
    ...sessionRoutes,
    ...settingsRoutes,
    ...sttRoutes,
    ...taskRoutes,
    ...terminalRoutes,
    ...ttsRoutes,
    "/api/*": () =>
        routeFailureResponse({ context: "routing", message: "Not found", status: 404 }),
} as const;

export const routes = withRequestPolicy(routeTable);
