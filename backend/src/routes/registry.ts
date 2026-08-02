import { json } from "../http/core.ts";
import { routeFailureResponse } from "../http/routeSupport.ts";
import { withRequestPolicy } from "../requestPolicy/evaluator.ts";
import {
    diagnosticsSnapshot,
    livenessSnapshot,
    readinessSnapshot,
} from "../server/health.ts";
import gateway from "../services/gateway/runtime.ts";
import { accountSecurityRoutes } from "./accountSecurityRoutes.ts";
import { agentRoutes } from "./agentRoutes.ts";
import { auditRoutes } from "./auditRoutes.ts";
import { authRoutes } from "./authRoutes.ts";
import { backupRoutes } from "./backupRoutes.ts";
import { cacheRoutes } from "./cacheRoutes.ts";
import { configFileRoutes } from "./configFileRoutes.ts";
import { cronRoutes } from "./cronRoutes.ts";
import { databaseRoutes } from "./databaseRoutes.ts";
import { dockerRoutes } from "./dockerRoutes.ts";
import { execRoutes } from "./execRoutes.ts";
import { fileRoutes } from "./fileRoutes.ts";
import { jobExecutionRoutes } from "./jobExecutionRoutes.ts";
import { jobRoutes } from "./jobRoutes.ts";
import { logRoutes } from "./logRoutes.ts";
import { mediaRoutes } from "./mediaRoutes.ts";
import { metricsRoutes } from "./metricsRoutes.ts";
import { moltbookRoutes } from "./moltbookRoutes.ts";
import { notificationRoutes } from "./notificationRoutes.ts";
import { openclawConfigRoutes } from "./openclawConfigRoutes.ts";
import { opsRoutes } from "./opsRoutes.ts";
import { pullRequestRoutes } from "./pullRequestRoutes.ts";
import { reportRoutes } from "./reportRoutes.ts";
import { sessionRoutes } from "./sessionRoutes.ts";
import { settingsRoutes } from "./settingsRoutes.ts";
import { sttRoutes } from "./sttRoutes.ts";
import { taskRoutes } from "./taskRoutes/handlers.ts";
import { terminalRoutes } from "./terminalRoutes.ts";
import { ttsRoutes } from "./ttsRoutes.ts";
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
