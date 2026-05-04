import { execSync } from "node:child_process";

import dotenv from "dotenv";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

import { getAuthUserFromRequest, getPersistedGatewayToken, requireAuth } from "./auth.js";
import gateway from "./gateway.js";
import agentsRoutes from "./routes/agents.js";
import authRoutes from "./routes/auth.js";
import backupRoutes from "./routes/backups.js";
import cacheRoutes from "./routes/cache.js";
import configFilesRoutes from "./routes/configFiles.js";
import execRoutes from "./routes/exec.js";
import cronRoutes from "./routes/cron.js";
import databaseRoutes from "./routes/database.js";
import dockerRoutes from "./routes/docker.js";
import filesRoutes from "./routes/files.js";
import logsRoutes from "./routes/logs.js";
import metricsRoutes from "./routes/metrics.js";
import moltbookRoutes from "./routes/moltbook.js";
import notificationsRoutes from "./routes/notifications.js";
import openClawConfigRoutes from "./routes/openclawConfig.js";
import opsRoutes from "./routes/ops.js";
import sessionsRoutes from "./routes/sessions.js";
import settingsRoutes from "./routes/settings.js";
import staticRoutes from "./routes/static.js";
import tasksRoutes from "./routes/tasks.js";
import terminalRoutes from "./routes/terminal.js";
import { startOpenClawNotificationMonitor } from "./services/openclawNotifications.js";
import { startQuotaNotificationMonitor } from "./services/quotaNotifications.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const frontendPath = path.join(__dirname, "..", "..", "dist");

const backendCommit = (() => {
    try {
        return execSync("git rev-parse --short HEAD", {
            cwd: path.join(__dirname, "..", ".."),
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "unknown";
    }
})();

// =====================
// API Routes
// =====================

const healthHandler: express.RequestHandler = (_req, res) => {
    res.json({
        status: "ok",
        gatewayConnected: gateway.isConnected(),
        sessionCount: gateway.getSessions().length,
        backendCommit,
    });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.get("/api/sessions", (request, response) => {
    const user = getAuthUserFromRequest(request);
    if (!user) {
        response.status(401).json({ error: "Unauthorized" });
        return;
    }

    response.json(gateway.getSessions());
});

authRoutes(app);
app.use("/api", (request, response, next) => {
    if (request.path.startsWith("/auth")) {
        next();
        return;
    }

    requireAuth(request, response, next);
});

// Route modules
filesRoutes(app, express);
configFilesRoutes(app, express);
cacheRoutes(app);
backupRoutes(app, express);
agentsRoutes(app);
logsRoutes(app);
cronRoutes(app);
databaseRoutes(app);
dockerRoutes(app);
execRoutes(app, express);
openClawConfigRoutes(app);
metricsRoutes(app);
moltbookRoutes(app);
settingsRoutes(app, express, gateway.getStatus);
sessionsRoutes(app);
tasksRoutes(app, express);
notificationsRoutes(app);
opsRoutes(app);
terminalRoutes(app);

// Static files & SPA (must be last)
staticRoutes(app, frontendPath);

// =====================
// WebSocket
// =====================
wss.on("connection", (ws: WebSocket, request) => {
    const user = getAuthUserFromRequest(request);
    if (!user) {
        ws.close(4401, "Unauthorized");
        return;
    }

    gateway.handleClient(ws);
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
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
});
