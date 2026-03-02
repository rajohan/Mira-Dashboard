const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const { getMetrics } = require("./metrics");

// Route modules
const filesRoutes = require("./routes/files");
const moltbookRoutes = require("./routes/moltbook");
const settingsRoutes = require("./routes/settings");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Frontend static files
const frontendPath = path.join(__dirname, "..", "dist");

// State
let gatewayWs = null;
let subscribers = new Set();
let sessionList = [];
let isGatewayConnected = false;
let reconnectTimer = null;
let connectionAttempts = 0;
let requestId = 1000;
let pendingRequests = new Map();
let logSubscribers = new Set();

// =====================
// Log Watcher
// =====================
let logWatcher = null;
let lastLogSize = 0;
let lastLogFile = "";

function startLogWatcher(logsDir = "/tmp/openclaw") {
    if (logWatcher) return;
    
    const fs = require("fs");
    
    logWatcher = setInterval(() => {
        try {
            const today = new Date().toISOString().split("T")[0];
            const logFile = path.join(logsDir, "openclaw-" + today + ".log");
            
            if (!fs.existsSync(logFile)) return;
            
            const stat = fs.statSync(logFile);
            
            if (logFile !== lastLogFile) {
                lastLogFile = logFile;
                lastLogSize = 0;
            }
            
            if (stat.size > lastLogSize) {
                const fd = fs.openSync(logFile, "r");
                const buffer = Buffer.alloc(stat.size - lastLogSize);
                fs.readSync(fd, buffer, 0, buffer.length, lastLogSize);
                fs.closeSync(fd);
                
                const lines = buffer.toString("utf-8").split("\n").filter(l => l.trim());
                lastLogSize = stat.size;
                
                for (const line of lines) {
                    const msg = JSON.stringify({ type: "log", line });
                    for (const ws of logSubscribers) {
                        try { ws.send(msg); } catch {}
                    }
                }
            }
        } catch (e) {
            console.error("[LogWatcher] Error:", e.message);
        }
    }, 1000);
}

// =====================
// Session Transform
// =====================
function transformSession(session) {
    const s = { ...session };
    
    if (s.createdAt) s.createdAt = new Date(s.createdAt).getTime();
    if (s.updatedAt) s.updatedAt = new Date(s.updatedAt).getTime();
    if (s.lastHeartbeat) s.lastHeartbeat = new Date(s.lastHeartbeat).getTime();
    if (s.lastMessage) s.lastMessage = new Date(s.lastMessage).getTime();
    
    if (s.usage) {
        let total = 0;
        for (const model of Object.keys(s.usage)) {
            total += (s.usage[model].input || 0) + (s.usage[model].output || 0);
        }
        s.totalTokens = total;
    }
    
    return s;
}

// =====================
// Gateway Connection
// =====================
function connectToGateway(token) {
    if (!token) {
        console.error("[Backend] No OpenClaw token provided");
        return;
    }
    
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    console.log("[Backend] Connecting to OpenClaw Gateway:", gatewayUrl);
    
    try {
        gatewayWs = new WebSocket(gatewayUrl, {
            headers: { "Authorization": "Bearer " + token }
        });
    } catch (e) {
        console.error("[Backend] Failed to create WebSocket:", e.message);
        scheduleReconnect(token);
        return;
    }
    
    gatewayWs.on("open", () => {
        console.log("[Backend] Connected to OpenClaw Gateway");
        isGatewayConnected = true;
        connectionAttempts = 0;
        
        broadcast({ type: "gateway", connected: true });
        
        gatewayWs.send(JSON.stringify({
            jsonrpc: "2.0",
            method: "sessions.list",
            params: { kinds: ["main", "subagent"] },
            id: requestId++
        }));
    });
    
    gatewayWs.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.result && Array.isArray(msg.result)) {
                sessionList = msg.result.map(transformSession);
                broadcast({ type: "sessions", sessions: sessionList });
                return;
            }
            
            if (msg.id && pendingRequests.has(msg.id)) {
                const pending = pendingRequests.get(msg.id);
                pendingRequests.delete(msg.id);
                
                if (pending.clientWs && pending.clientWs.readyState === WebSocket.OPEN) {
                    pending.clientWs.send(JSON.stringify({
                        id: pending.clientId,
                        result: msg.result || msg.error
                    }));
                }
                return;
            }
            
            broadcast({ type: "gateway", data: msg });
        } catch (e) {
            console.error("[Backend] Error parsing message:", e.message);
        }
    });
    
    gatewayWs.on("error", (e) => {
        console.error("[Backend] Gateway error:", e.message);
        isGatewayConnected = false;
        broadcast({ type: "gateway", connected: false });
    });
    
    gatewayWs.on("close", () => {
        console.log("[Backend] Gateway connection closed");
        isGatewayConnected = false;
        gatewayWs = null;
        broadcast({ type: "gateway", connected: false });
        scheduleReconnect(token);
    });
}

function scheduleReconnect(token) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    connectionAttempts++;
    const delay = Math.min(1000 * connectionAttempts, 30000);
    console.log("[Backend] Reconnecting in", delay / 1000, "seconds");
    
    reconnectTimer = setTimeout(() => connectToGateway(token), delay);
}

function sendGatewayRequest(method, params, clientWs, clientId) {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
        return clientWs.send(JSON.stringify({ id: clientId, error: "Gateway not connected" }));
    }
    
    const id = requestId++;
    pendingRequests.set(id, { clientWs, clientId });
    
    gatewayWs.send(JSON.stringify({
        jsonrpc: "2.0",
        method: method,
        params: params,
        id: id
    }));
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of subscribers) {
        try { ws.send(data); } catch {}
    }
}

function getGatewayStatus() {
    return {
        gateway: isGatewayConnected ? "connected" : "disconnected",
        sessions: sessionList.length
    };
}

// =====================
// API Routes
// =====================

app.get("/health", (req, res) => {
    res.json({ status: "ok", gateway: isGatewayConnected ? "connected" : "disconnected" });
});

app.get("/api/sessions", (req, res) => {
    res.json(sessionList);
});

app.get("/api/metrics", (req, res) => {
    try {
        const metrics = getMetrics();
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/exec", express.json(), async (req, res) => {
    const { command, cwd } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: "Command required" });
    }
    
    try {
        const { spawn } = require("child_process");
        const child = spawn(command, { 
            shell: true, 
            cwd: cwd || process.cwd(),
            env: process.env 
        });
        
        let stdout = "";
        let stderr = "";
        
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        
        child.on("close", (code) => {
            res.json({ 
                code: code, 
                stdout: stdout.slice(-10000), 
                stderr: stderr.slice(-10000) 
            });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/logs/info", (req, res) => {
    const fs = require("fs");
    const logsDir = "/tmp/openclaw";
    
    try {
        if (!fs.existsSync(logsDir)) {
            return res.json({ logs: [] });
        }
        
        const files = fs.readdirSync(logsDir)
            .filter(f => f.startsWith("openclaw-") && f.endsWith(".log"))
            .map(f => {
                const stat = fs.statSync(path.join(logsDir, f));
                return {
                    name: f,
                    size: stat.size,
                    modified: stat.mtime
                };
            })
            .sort((a, b) => b.modified - a.modified);
        
        res.json({ logs: files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/logs/content", (req, res) => {
    const fs = require("fs");
    const logsDir = "/tmp/openclaw";
    const logFile = req.query.file;
    
    if (!logFile) {
        return res.status(400).json({ error: "File parameter required" });
    }
    
    try {
        const filePath = path.join(logsDir, logFile);
        
        if (!filePath.startsWith(logsDir)) {
            return res.status(403).json({ error: "Access denied" });
        }
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "File not found" });
        }
        
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").slice(-5000).join("\n");
        
        res.json({ content: lines });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/sessions/:key/history", async (req, res) => {
    sendGatewayRequest("sessions.history", { sessionKey: req.params.key }, res, "history-" + req.params.key);
});

app.post("/api/sessions/:key/action", express.json(), async (req, res) => {
    sendGatewayRequest(req.body.method || "sessions.send", {
        sessionKey: req.params.key,
        ...req.body.params
    }, res, "action-" + req.params.key);
});

// =====================
// Route Modules
// =====================
filesRoutes(app, express);
moltbookRoutes(app);
settingsRoutes(app, express, getGatewayStatus);

// =====================
// Static Files & SPA
// =====================
app.use(express.static(frontendPath));

app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// =====================
// WebSocket
// =====================
wss.on("connection", (ws) => {
    console.log("[Frontend] Client connected");
    subscribers.add(ws);

    ws.send(JSON.stringify({
        type: "state",
        gatewayConnected: isGatewayConnected,
        sessions: sessionList
    }));

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === "subscribe" && msg.channel === "logs") {
                console.log("[Frontend] Client subscribed to logs");
                logSubscribers.add(ws);
                startLogWatcher();
            }

            if (msg.type === "unsubscribe" && msg.channel === "logs") {
                logSubscribers.delete(ws);
            }

            if (msg.type === "request" && msg.method) {
                sendGatewayRequest(msg.method, msg.params || {}, ws, msg.id);
            }
        } catch (e) {
            console.error("[Frontend] Error handling message:", e.message);
        }
    });

    ws.on("close", () => {
        subscribers.delete(ws);
        logSubscribers.delete(ws);
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
        connectToGateway(token);
    }
});
