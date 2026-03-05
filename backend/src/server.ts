import { execSync } from "node:child_process";

import dotenv from "dotenv";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

import gateway from "./gateway.js";
import configFilesRoutes from "./routes/configFiles.js";
import execRoutes from "./routes/exec.js";
import cronRoutes from "./routes/cron.js";
import filesRoutes from "./routes/files.js";
import logsRoutes from "./routes/logs.js";
import metricsRoutes from "./routes/metrics.js";
import moltbookRoutes from "./routes/moltbook.js";
import notificationsRoutes from "./routes/notifications.js";
import openclawRoutes from "./routes/openclaw.js";
import quotasRoutes from "./routes/quotas.js";
import sessionsRoutes from "./routes/sessions.js";
import settingsRoutes from "./routes/settings.js";
import staticRoutes from "./routes/static.js";
import tasksRoutes from "./routes/tasks.js";
import weatherRoutes, { startWeatherMonitor } from "./routes/weather.js";
import { startOpenClawNotificationMonitor } from "./services/openclawNotifications.js";
import { startQuotaNotificationMonitor } from "./services/quotaNotifications.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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

app.get("/api/sessions", (_req, res) => {
    res.json(gateway.getSessions());
});

// Route modules
filesRoutes(app, express);
configFilesRoutes(app, express);
logsRoutes(app);
cronRoutes(app);
execRoutes(app, express);
metricsRoutes(app);
moltbookRoutes(app);
settingsRoutes(app, express, gateway.getStatus);
sessionsRoutes(app);
tasksRoutes(app, express);
weatherRoutes(app);
quotasRoutes(app);
notificationsRoutes(app);
openclawRoutes(app, express);

// Static files & SPA (must be last)
staticRoutes(app, frontendPath);

// =====================
// WebSocket
// =====================
wss.on("connection", (ws: WebSocket) => {
    gateway.handleClient(ws);
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
    const token = process.env.OPENCLAW_TOKEN;
    if (token) {
        gateway.init(token);
    } else {
        console.error("[Backend] OPENCLAW_TOKEN required");
        throw new Error("OPENCLAW_TOKEN required");
    }

    startQuotaNotificationMonitor();
    startOpenClawNotificationMonitor();
    startWeatherMonitor();
});
