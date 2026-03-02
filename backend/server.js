require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

// Route modules
const filesRoutes = require("./routes/files");
const logsRoutes = require("./routes/logs");
const execRoutes = require("./routes/exec");
const metricsRoutes = require("./routes/metrics");
const moltbookRoutes = require("./routes/moltbook");
const settingsRoutes = require("./routes/settings");
const gateway = require("./routes/gateway");
const staticRoutes = require("./routes/static");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const frontendPath = path.join(__dirname, "..", "dist");

// =====================
// API Routes
// =====================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        gatewayConnected: gateway.isConnected(),
        sessionCount: gateway.getSessions().length,
    });
});

app.get("/api/sessions", (req, res) => {
    res.json(gateway.getSessions());
});

// Route modules
filesRoutes(app, express);
logsRoutes(app);
execRoutes(app, express);
metricsRoutes(app);
moltbookRoutes(app);
settingsRoutes(app, express, gateway.getStatus);

// Static files & SPA (must be last)
staticRoutes(app, frontendPath);

// =====================
// WebSocket
// =====================
wss.on("connection", (ws) => {
    console.log("[Frontend] Client connected");
    gateway.handleClient(ws);

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === "subscribe" && msg.channel === "logs") {
                logsRoutes.subscribeToLogs(ws);
            }

            if (msg.type === "unsubscribe" && msg.channel === "logs") {
                logsRoutes.unsubscribeFromLogs(ws);
            }
        } catch (e) {
            console.error("[Frontend] Message error:", e.message);
        }
    });

    ws.on("close", () => {
        logsRoutes.unsubscribeFromLogs(ws);
    });
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
    console.log("[Backend] Server listening on port", PORT);

    const token = process.env.OPENCLAW_TOKEN;
    if (token) {
        gateway.init(token);
    } else {
        console.error("[Backend] OPENCLAW_TOKEN required");
        process.exit(1);
    }
});
