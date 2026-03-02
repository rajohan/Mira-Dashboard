require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const { getMetrics } = require("./metrics");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve frontend from local dist folder
const frontendPath = path.join(__dirname, "..", "dist");

// Gateway connection state
let gatewayWs = null;
let subscribers = new Set();
let sessionList = [];
let isGatewayConnected = false;
let reconnectTimer = null;
let connectionAttempts = 0;
let requestId = 1000;
let pendingRequests = new Map(); // id -> { clientWs, clientId, resolve }
let logSubscribers = new Set(); // Clients subscribed to logs

// Log file watcher for real-time updates
let logWatcher = null;
let lastLogSize = 0;
let lastLogFile = "";

function startLogWatcher(logsDir = "/tmp/openclaw") {
    if (logWatcher) {
        logWatcher.close();
    }

    const fs = require("fs");
    const path = require("path");

    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(logsDir, "openclaw-" + today + ".log");

    try {
        // Get initial file size
        if (fs.existsSync(logFile)) {
            lastLogSize = fs.statSync(logFile).size;
            lastLogFile = logFile;
        }

        // Watch the log file for changes
        logWatcher = fs.watch(logsDir, (eventType, filename) => {
            if (
                filename &&
                filename.startsWith("openclaw-") &&
                filename.endsWith(".log")
            ) {
                const changedFile = path.join(logsDir, filename);
                if (filename === "openclaw-" + today + ".log") {
                    try {
                        const stats = fs.statSync(changedFile);
                        if (stats.size > lastLogSize) {
                            // Read new content
                            const fd = fs.openSync(changedFile, "r");
                            const buffer = Buffer.alloc(stats.size - lastLogSize);
                            fs.readSync(fd, buffer, 0, buffer.length, lastLogSize);
                            fs.closeSync(fd);

                            const newLines = buffer
                                .toString("utf-8")
                                .split("\n")
                                .filter((l) => l.trim());

                            for (const line of newLines) {
                                const msg = JSON.stringify({ type: "log", line: line });
                                for (const client of logSubscribers) {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(msg);
                                    }
                                }
                            }

                            lastLogSize = stats.size;
                        }
                    } catch (e) {
                        // File might not exist yet
                    }
                }
            }
        });

        logWatcher.on("error", (err) => {
            console.error("[Backend] Log watcher error:", err.message);
        });
    } catch (e) {
        console.error("[Backend] Failed to start log watcher:", e.message);
    }
}

startLogWatcher();

// Transform OpenClaw session format to frontend format
function transformSession(session) {
    let type = "UNKNOWN";
    let agentType = "";
    const key = session.key || "";

    const keyParts = key.split(":");
    if (keyParts.length >= 2) {
        agentType = keyParts[1] || "";
    }

    let hookName = "";
    if (key.includes(":hook:")) {
        type = "HOOK";
        const hookIndex = keyParts.indexOf("hook");
        if (hookIndex !== -1 && keyParts[hookIndex + 1]) {
            hookName = keyParts[hookIndex + 1];
        }
    } else if (key.includes(":cron:")) {
        type = "CRON";
    } else if (key.includes(":subagent:")) {
        type = "SUBAGENT";
    } else if (key.startsWith("agent:main:")) {
        type = "MAIN";
    } else if (key.startsWith("agent:")) {
        type = "SUBAGENT";
    }

    let displayLabel = session.label || "";
    if (!displayLabel && type === "HOOK" && hookName) {
        displayLabel = hookName.charAt(0).toUpperCase() + hookName.slice(1);
    }
    if (!displayLabel && type === "SUBAGENT" && agentType) {
        displayLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);
    }

    return {
        id: session.sessionId || session.key || "unknown",
        key: session.key,
        type: type,
        agentType: agentType,
        hookName: hookName,
        kind: session.kind,
        model: session.model || "Unknown",
        tokenCount: session.totalTokens || 0,
        maxTokens: session.contextTokens || 200000,
        createdAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
        updatedAt: session.updatedAt,
        displayName: session.displayName || "",
        label: session.label || "",
        displayLabel: displayLabel,
        channel: session.channel || "unknown",
    };
}

function connectToGateway(token) {
    if (
        gatewayWs &&
        (gatewayWs.readyState === WebSocket.OPEN ||
            gatewayWs.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    console.log("[Backend] Connecting to Gateway:", gatewayUrl);

    try {
        const ws = new WebSocket(gatewayUrl + "?token=" + encodeURIComponent(token));
        gatewayWs = ws;
        connectionAttempts++;

        ws.on("open", () => {
            console.log("[Backend] WS open, sending connect...");
            const connectReq = {
                type: "req",
                id: "connect-1",
                method: "connect",
                params: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: {
                        id: "cli",
                        version: "1.0.0",
                        platform: "node",
                        mode: "backend",
                    },
                    role: "operator",
                    scopes: ["operator.read", "operator.write", "operator.admin"],
                    caps: ["tool-events"],
                    auth: { token },
                },
            };
            ws.send(JSON.stringify(connectReq));
        });

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === "res" && msg.id === "connect-1") {
                    if (msg.ok) {
                        console.log("[Backend] Gateway connected!");
                        isGatewayConnected = true;
                        connectionAttempts = 0;
                        broadcast({ type: "connected", gatewayConnected: true });
                        const sessionsReq = {
                            type: "req",
                            id: "sessions-init",
                            method: "sessions.list",
                            params: {},
                        };
                        ws.send(JSON.stringify(sessionsReq));
                    } else {
                        console.error("[Backend] Connect failed:", msg.error);
                    }
                    return;
                }

                if (
                    msg.type === "res" &&
                    (msg.id === "sessions-init" || msg.id === "sessions-refresh")
                ) {
                    if (msg.ok && msg.payload?.sessions) {
                        sessionList = msg.payload.sessions.map(transformSession);
                        console.log(
                            "[Backend] Sessions updated:",
                            sessionList.length,
                            "sessions",
                        );
                        broadcast({ type: "sessions", sessions: sessionList });
                    }
                    return;
                }

                if (
                    msg.type === "res" &&
                    msg.method === "sessions.list" &&
                    msg.ok &&
                    msg.payload?.sessions
                ) {
                    sessionList = msg.payload.sessions.map(transformSession);
                    console.log(
                        "[Backend] Sessions updated via method match:",
                        sessionList.length,
                        "sessions",
                    );
                    broadcast({ type: "sessions", sessions: sessionList });
                    return;
                }

                if (msg.type === "res" && pendingRequests.has(msg.id)) {
                    const pending = pendingRequests.get(msg.id);
                    pendingRequests.delete(msg.id);

                    if (
                        pending.clientWs &&
                        pending.clientWs.readyState === WebSocket.OPEN
                    ) {
                        pending.clientWs.send(
                            JSON.stringify({
                                type: "res",
                                id: pending.clientId,
                                ok: msg.ok,
                                payload: msg.payload,
                                error: msg.error,
                            }),
                        );
                    }

                    if (pending.method && pending.method.startsWith("sessions.")) {
                        const refreshReq = {
                            type: "req",
                            id: "sessions-refresh",
                            method: "sessions.list",
                            params: {},
                        };
                        ws.send(JSON.stringify(refreshReq));
                    }
                    return;
                }

                // Handle events
                if (msg.type === "event") {
                    // Broadcast to all clients
                    broadcast({ type: "event", event: msg.event, payload: msg.payload });
                }
            } catch (e) {
                console.error("[Backend] Parse error:", e.message);
            }
        });

        ws.on("close", (code, reason) => {
            console.log("[Backend] Gateway closed:", code);
            gatewayWs = null;
            isGatewayConnected = false;
            broadcast({ type: "disconnected" });
            scheduleReconnect(token);
        });

        ws.on("error", (err) => {
            console.error("[Backend] WS error:", err.message);
        });
    } catch (e) {
        console.error("[Backend] Connect error:", e.message);
        scheduleReconnect(token);
    }
}

function scheduleReconnect(token) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(5000 * Math.pow(1.5, connectionAttempts), 60000);
    console.log("[Backend] Reconnecting in " + delay + "ms...");
    reconnectTimer = setTimeout(() => connectToGateway(token), delay);
}

function sendGatewayRequest(method, params, clientWs, clientId) {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
        console.log("[Backend] Cannot send request - gateway not connected");
        return false;
    }

    const id = String(++requestId);
    const req = { type: "req", id, method, params };

    if (clientWs && clientId) {
        pendingRequests.set(id, { clientWs, clientId, method });
    }

    console.log("[Backend] Sending request:", method, "id:", id);
    gatewayWs.send(JSON.stringify(req));
    return true;
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of subscribers) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}

// API
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        gatewayConnected: isGatewayConnected,
        sessionCount: sessionList.length,
    });
});

app.get("/api/sessions", (req, res) => {
    res.json({ sessions: sessionList });
});

app.get("/api/metrics", (req, res) => {
    try {
        const metrics = getMetrics();

        // Calculate token usage from sessions
        if (sessionList && sessionList.length > 0) {
            let totalTokens = 0;
            const byModel = {};

            for (const session of sessionList) {
                const tokens = session.tokenCount || 0;
                totalTokens += tokens;

                const model = session.model || "unknown";
                byModel[model] = (byModel[model] || 0) + tokens;
            }

            // Calculate sessions per model and tokens per agent
            const sessionsByModel = {};
            const tokensByAgent = [];

            for (const session of sessionList) {
                const model = session.model || "unknown";
                sessionsByModel[model] = (sessionsByModel[model] || 0) + 1;

                const agentType = (session.type || "unknown").toUpperCase();
                const tokens = session.tokenCount || 0;
                const label =
                    session.displayLabel ||
                    session.label ||
                    session.id?.slice(0, 8) ||
                    "unknown";
                tokensByAgent.push({
                    type: agentType,
                    label: label,
                    model: model,
                    tokens: tokens,
                });
            }

            // Sort by tokens descending
            tokensByAgent.sort((a, b) => b.tokens - a.tokens);

            metrics.tokens = {
                total: totalTokens,
                byModel: byModel,
                sessionsByModel: sessionsByModel,
                byAgent: tokensByAgent,
            };
        }

        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Execute shell command
app.post("/api/exec", express.json(), async (req, res) => {
    const { command, args } = req.body;

    if (!command) {
        return res.status(400).json({ error: "Command required" });
    }

    try {
        const { spawn } = require("child_process");
        const child = spawn(command, args || [], { shell: false });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data;
        });
        child.stderr.on("data", (data) => {
            stderr += data;
        });

        child.on("close", (code) => {
            res.json({ stdout, stderr, code });
        });

        child.on("error", (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Log files info
app.get("/api/logs/info", (req, res) => {
    try {
        const logsDir = "/tmp/openclaw";
        const fs = require("fs");
        const path = require("path");
        const files = fs
            .readdirSync(logsDir)
            .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
            .map((f) => {
                const stat = fs.statSync(path.join(logsDir, f));
                return { name: f, size: stat.size, modified: stat.mtime };
            })
            .sort((a, b) => b.modified - a.modified);
        res.json({ files, logsDir });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Log file content
app.get("/api/logs/content", (req, res) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const logsDir = "/tmp/openclaw";
        const file = req.query.file;
        const lines = parseInt(req.query.lines) || 100;

        if (!file) {
            const today = new Date().toISOString().split("T")[0];
            const defaultFile = "openclaw-" + today + ".log";
            const filePath = path.join(logsDir, defaultFile);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf-8");
                const contentLines = content
                    .split("\n")
                    .filter((l) => l.trim())
                    .slice(-lines)
                    .join("\n");
                return res.json({ content: contentLines, file: defaultFile });
            }
            return res.json({ content: "", file: defaultFile });
        }

        const filePath = path.join(logsDir, file);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "File not found" });
        }
        const content = fs.readFileSync(filePath, "utf-8");
        const contentLines = content
            .split("\n")
            .filter((l) => l.trim())
            .slice(-lines)
            .join("\n");
        res.json({ content: contentLines, file });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Session history endpoint
app.get("/api/sessions/:key/history", async (req, res) => {
    const sessionKey = req.params.key;
    if (!isGatewayConnected || !gatewayWs) {
        return res.status(503).json({ error: "Gateway not connected" });
    }
    // TODO: Implement Gateway API call for session history
    res.json({ messages: [], sessionKey });
});

// Session action endpoint (pause, resume, kill)
app.post("/api/sessions/:key/action", express.json(), async (req, res) => {
    const sessionKey = req.params.key;
    const { action } = req.body;

    if (!isGatewayConnected || !gatewayWs) {
        return res.status(503).json({ error: "Gateway not connected" });
    }

    // Send action to Gateway
    try {
        const requestId = Date.now().toString();
        gatewayWs.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                method: "sessions." + action,
                params: { sessionKey: sessionKey },
            }),
        );
        res.json({ success: true, sessionKey, action });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =====================
// Files API
// =====================
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/home/ubuntu/.openclaw/workspace";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for preview

function isBinaryFile(content) {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.charCodeAt(i) === 0) return true;
    }
    return false;
}

function shouldHideFile(name) {
    return name.startsWith(".");
}

function listDirectory(dirPath, basePath) {
    const fs = require("fs");
    const path = require("path");

    basePath = basePath || "";
    const fullPath = path.resolve(WORKSPACE_ROOT, basePath, dirPath);

    if (!fullPath.startsWith(WORKSPACE_ROOT)) {
        throw new Error("Access denied: path outside workspace");
    }

    if (!fs.existsSync(fullPath)) {
        return [];
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
        return [];
    }

    const entries = fs.readdirSync(fullPath);
    return entries
        .filter((name) => !shouldHideFile(name))
        .map((name) => {
            const entryPath = path.join(fullPath, name);
            const relativePath = path.join(basePath, dirPath, name).replace(/^\//, "");
            const entryStat = fs.statSync(entryPath);
            const isDir = entryStat.isDirectory();

            return {
                name: name,
                path: relativePath,
                type: isDir ? "directory" : "file",
                size: isDir ? undefined : entryStat.size,
                modified: entryStat.mtime.toISOString(),
            };
        })
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}

// List files in directory
app.get("/api/files", (req, res) => {
    try {
        const dirPath = req.query.path || "";
        const files = listDirectory(dirPath);
        res.json({ files, root: WORKSPACE_ROOT });
    } catch (e) {
        console.error("[Backend] Files list error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Read file content
app.get("/api/files/*", (req, res) => {
    const fs = require("fs");
    const path = require("path");

    try {
        const filePath = decodeURIComponent(req.params[0] || "");
        const fullPath = path.resolve(WORKSPACE_ROOT, filePath);

        if (!fullPath.startsWith(WORKSPACE_ROOT)) {
            return res
                .status(403)
                .json({ error: "Access denied: path outside workspace" });
        }

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: "File not found" });
        }

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            return res.status(400).json({ error: "Path is a directory, not a file" });
        }

        if (stat.size > MAX_FILE_SIZE) {
            const fd = fs.openSync(fullPath, "r");
            const buffer = Buffer.alloc(MAX_FILE_SIZE);
            const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
            fs.closeSync(fd);

            const content = buffer.toString("utf-8", 0, bytesRead);
            const isBinary = isBinaryFile(content);

            return res.json({
                path: filePath,
                content: isBinary ? "[Binary file]" : content,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                isBinary: isBinary,
                truncated: true,
            });
        }

        const content = fs.readFileSync(fullPath, "utf-8");
        const isBinary = isBinaryFile(content);

        res.json({
            path: filePath,
            content: isBinary ? "[Binary file]" : content,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            isBinary: isBinary,
        });
    } catch (e) {
        console.error("[Backend] File read error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Write file content
app.put("/api/files/*", express.json(), (req, res) => {
    const fs = require("fs");
    const path = require("path");

    try {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body;

        if (content === undefined) {
            return res.status(400).json({ error: "Content required" });
        }

        const fullPath = path.resolve(WORKSPACE_ROOT, filePath);

        if (!fullPath.startsWith(WORKSPACE_ROOT)) {
            return res
                .status(403)
                .json({ error: "Access denied: path outside workspace" });
        }

        if (fs.existsSync(fullPath)) {
            const backupPath = fullPath + ".bak";
            fs.copyFileSync(fullPath, backupPath);
        } else {
            const parentDir = path.dirname(fullPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
        }

        fs.writeFileSync(fullPath, content, "utf-8");

        const stat = fs.statSync(fullPath);

        res.json({
            success: true,
            path: filePath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
        });
    } catch (e) {
        console.error("[Backend] File write error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// =====================
// Moltbook API Proxy
// =====================
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

// Helper for Moltbook API requests
function moltbookGet(endpoint, res) {
    const https = require("https");
    https
        .get(
            MOLTBOOK_API + endpoint,
            {
                headers: { Authorization: "Bearer " + process.env.MOLTBOOK_API_KEY },
            },
            (moltRes) => {
                let data = "";
                moltRes.on("data", (chunk) => (data += chunk));
                moltRes.on("end", () => {
                    try {
                        res.json(JSON.parse(data));
                    } catch (e) {
                        res.status(500).json({ error: "Invalid JSON from Moltbook" });
                    }
                });
            },
        )
        .on("error", (e) => res.status(500).json({ error: e.message }));
}

app.get("/api/moltbook/home", async (req, res) => moltbookGet("/home", res));
app.get("/api/moltbook/feed", async (req, res) => {
    const sort = req.query.sort || "hot";
    const limit = req.query.limit || 25;
    moltbookGet("/feed?sort=" + sort + "&limit=" + limit, res);
});
app.get("/api/moltbook/profile", async (req, res) =>
    moltbookGet("/agents/profile?name=mira_2026", res),
);
app.get("/api/moltbook/my-posts", async (req, res) => {
    const https = require("https");
    https
        .get(
            MOLTBOOK_API + "/agents/profile?name=mira_2026",
            {
                headers: { Authorization: "Bearer " + process.env.MOLTBOOK_API_KEY },
            },
            (moltRes) => {
                let data = "";
                moltRes.on("data", (chunk) => (data += chunk));
                moltRes.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        res.json({
                            posts: json.recentPosts || [],
                            comments: json.recentComments || [],
                        });
                    } catch (e) {
                        res.status(500).json({ error: "Invalid JSON" });
                    }
                });
            },
        )
        .on("error", (e) => res.status(500).json({ error: e.message }));
});

// Settings API
// =====================
app.get("/api/config", async (req, res) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");

        if (!fs.existsSync(configPath)) {
            return res.status(404).json({ error: "Config not found" });
        }

        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

        // Remove secrets
        const sanitized = JSON.parse(JSON.stringify(config));
        if (sanitized.discord?.token) sanitized.discord.token = "***";
        if (sanitized.openai?.apiKey) sanitized.openai.apiKey = "***";
        if (sanitized.anthropic?.apiKey) sanitized.anthropic.apiKey = "***";
        if (sanitized.channels?.discord?.token) sanitized.channels.discord.token = "***";
        delete sanitized.webhooks;
        delete sanitized.secrets;

        res.json(sanitized);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/api/config", express.json(), async (req, res) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");

        const allowedFields = [
            "session.reset.idleMinutes",
            "heartbeat.every",
            "heartbeat.target",
        ];
        const updates = req.body;

        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

        for (const [key, value] of Object.entries(updates)) {
            if (!allowedFields.includes(key)) {
                return res.status(400).json({ error: "Field not allowed: " + key });
            }
            const parts = key.split(".");
            let obj = config;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!obj[parts[i]]) obj[parts[i]] = {};
                obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/skills", async (req, res) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const skillsDir = path.join(process.env.HOME, ".openclaw", "workspace", "skills");

        if (!fs.existsSync(skillsDir)) {
            return res.json({ skills: [] });
        }

        const skills = fs
            .readdirSync(skillsDir)
            .filter((name) => fs.statSync(path.join(skillsDir, name)).isDirectory())
            .map((name) => ({
                name: name,
                enabled: true, // TODO: Check if enabled
                path: path.join(skillsDir, name),
            }));

        res.json({ skills });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/skills/:name/enable", async (req, res) => {
    res.json({ success: true, name: req.params.name, enabled: true });
});

app.post("/api/skills/:name/disable", async (req, res) => {
    res.json({ success: true, name: req.params.name, enabled: false });
});

app.post("/api/operations/restart", async (req, res) => {
    try {
        const { spawn } = require("child_process");
        spawn("sudo", ["systemctl", "restart", "openclaw"], { detached: true });
        res.json({ success: true, message: "Gateway restart initiated" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/operations/backup", async (req, res) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const spawn = require("child_process").spawn;

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = "/tmp/openclaw-backup-" + timestamp + ".tar.gz";
        const workspacePath = path.join(process.env.HOME, ".openclaw");

        spawn("tar", [
            "-czf",
            backupFile,
            "-C",
            path.dirname(workspacePath),
            path.basename(workspacePath),
        ]);

        res.json({ success: true, file: backupFile });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/operations/status", async (req, res) => {
    res.json({
        gateway: isGatewayConnected ? "connected" : "disconnected",
        sessions: sessionList.length,
    });
});

// SPA fallback
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// Frontend WebSocket
wss.on("connection", (ws) => {
    console.log("[Frontend] Client connected");
    subscribers.add(ws);

    ws.send(
        JSON.stringify({
            type: "state",
            gatewayConnected: isGatewayConnected,
            sessions: sessionList,
        }),
    );

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // Handle log subscription
            if (msg.type === "subscribe" && msg.channel === "logs") {
                console.log("[Frontend] Client subscribed to logs");
                logSubscribers.add(ws);

                // Send log history
                try {
                    const fs = require("fs");
                    const path = require("path");
                    const logsDir = "/tmp/openclaw";
                    const today = new Date().toISOString().split("T")[0];
                    const logFile = path.join(logsDir, "openclaw-" + today + ".log");

                    if (fs.existsSync(logFile)) {
                        ws.send(
                            JSON.stringify({
                                type: "log_file",
                                file: "openclaw-" + today + ".log",
                            }),
                        );

                        const content = fs.readFileSync(logFile, "utf-8");
                        const lines = content
                            .split("\n")
                            .filter((l) => l.trim())
                            .slice(-100);

                        for (const line of lines) {
                            ws.send(JSON.stringify({ type: "log", line: line }));
                        }

                        ws.send(
                            JSON.stringify({
                                type: "log_history_complete",
                                count: lines.length,
                            }),
                        );
                    }
                } catch (e) {
                    console.error("[Backend] Error sending log history:", e.message);
                }
                return;
            }

            // Handle log unsubscription
            if (msg.type === "unsubscribe" && msg.channel === "logs") {
                console.log("[Frontend] Client unsubscribed from logs");
                logSubscribers.delete(ws);
                return;
            }

            // Handle request forwarding to Gateway
            if (msg.type === "req" && msg.method) {
                if (!isGatewayConnected) {
                    ws.send(
                        JSON.stringify({
                            type: "res",
                            id: msg.id,
                            ok: false,
                            error: { message: "Gateway not connected" },
                        }),
                    );
                    return;
                }

                sendGatewayRequest(msg.method, msg.params || {}, ws, msg.id);
            }
        } catch (e) {
            console.error("[Frontend] Parse error:", e.message);
        }
    });

    ws.on("close", () => {
        subscribers.delete(ws);
        logSubscribers.delete(ws);
        console.log("[Frontend] Client disconnected");
    });
});

const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
    console.log("[Backend] Running on port " + PORT);
    console.log("[Backend] Frontend: " + frontendPath);

    const token = process.env.OPENCLAW_TOKEN;
    if (token) {
        connectToGateway(token);
    } else {
        console.error("[Backend] OPENCLAW_TOKEN required");
        process.exit(1);
    }
});
