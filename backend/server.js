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

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Static files
app.use(express.static(frontendPath));

// Transform OpenClaw session format to frontend format
function transformSession(session) {
    // Determine type from key
    // Keys like: "agent:main:main", "agent:main:cron:xxx", "agent:main:hook:agentmail", "agent:coder:subagent:xxx"
    let type = "UNKNOWN";
    let agentType = "";
    const key = session.key || "";
    
    // Extract agent type from key (coder, researcher, etc.)
    const keyParts = key.split(":");
    if (keyParts.length >= 2) {
        agentType = keyParts[1] || ""; // coder, researcher, main
    }
    
    // Extract hook/cron name from key
    let hookName = "";
    if (key.includes(":hook:")) {
        type = "HOOK";
        // agent:main:hook:agentmail -> agentmail
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
    
    // Build display label
    let displayLabel = session.label || "";
    
    // For HOOK without label, use hook name
    if (!displayLabel && type === "HOOK" && hookName) {
        displayLabel = hookName.charAt(0).toUpperCase() + hookName.slice(1);
    }
    
    // For SUBAGENT without label, show agent type
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
    if (gatewayWs && (gatewayWs.readyState === WebSocket.OPEN || gatewayWs.readyState === WebSocket.CONNECTING)) {
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
                    client: { id: "cli", version: "1.0.0", platform: "node", mode: "backend" },
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
                
                // Handle connect response
                if (msg.type === "res" && msg.id === "connect-1") {
                    if (msg.ok) {
                        console.log("[Backend] Gateway connected!");
                        isGatewayConnected = true;
                        connectionAttempts = 0;
                        broadcast({ type: "connected", gatewayConnected: true });
                        // Request initial session list
                        const sessionsReq = { type: "req", id: "sessions-init", method: "sessions.list", params: {} };
                        ws.send(JSON.stringify(sessionsReq));
                    } else {
                        console.error("[Backend] Connect failed:", msg.error);
                    }
                    return;
                }
                
                // Handle sessions.list response (initial or refresh)
                if (msg.type === "res" && (msg.id === "sessions-init" || msg.id === "sessions-refresh")) {
                    if (msg.ok && msg.payload?.sessions) {
                        sessionList = msg.payload.sessions.map(transformSession);
                        console.log("[Backend] Sessions updated:", sessionList.length, "sessions");
                        broadcast({ type: "sessions", sessions: sessionList });
                    }
                    return;
                }
                
                // Handle any sessions.list response by method
                if (msg.type === "res" && msg.method === "sessions.list" && msg.ok && msg.payload?.sessions) {
                    sessionList = msg.payload.sessions.map(transformSession);
                    console.log("[Backend] Sessions updated via method match:", sessionList.length, "sessions");
                    broadcast({ type: "sessions", sessions: sessionList });
                    return;
                }
                
                // Handle forwarded request responses
                if (msg.type === "res" && pendingRequests.has(msg.id)) {
                    const pending = pendingRequests.get(msg.id);
                    pendingRequests.delete(msg.id);
                    
                    if (pending.clientWs && pending.clientWs.readyState === WebSocket.OPEN) {
                        pending.clientWs.send(JSON.stringify({
                            type: "res",
                            id: pending.clientId,
                            ok: msg.ok,
                            payload: msg.payload,
                            error: msg.error,
                        }));
                    }
                    
                    // Refresh session list after mutations
                    if (pending.method && pending.method.startsWith("sessions.")) {
                        const refreshReq = { type: "req", id: "sessions-refresh", method: "sessions.list", params: {} };
                        ws.send(JSON.stringify(refreshReq));
                    }
                    return;
                }
                
                // Broadcast events to all clients
                if (msg.type === "event") {
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
    res.json({ status: "ok", gatewayConnected: isGatewayConnected, sessionCount: sessionList.length });
});

app.get("/api/sessions", (req, res) => {
    res.json({ sessions: sessionList });
});

app.get("/api/metrics", (req, res) => {
    try {
        const metrics = getMetrics();
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SPA fallback
app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// Frontend WebSocket
wss.on("connection", (ws) => {
    console.log("[Frontend] Client connected");
    subscribers.add(ws);
    
    ws.send(JSON.stringify({
        type: "state",
        gatewayConnected: isGatewayConnected,
        sessions: sessionList,
    }));
    
    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            // Handle request forwarding to Gateway
            if (msg.type === "req" && msg.method) {
                if (!isGatewayConnected) {
                    ws.send(JSON.stringify({
                        type: "res",
                        id: msg.id,
                        ok: false,
                        error: { message: "Gateway not connected" },
                    }));
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
