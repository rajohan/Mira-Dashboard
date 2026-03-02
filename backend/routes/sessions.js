// Sessions API routes
const WebSocket = require("ws");

let gatewayWs = null;
let subscribers = new Set();
let sessionList = [];
let isGatewayConnected = false;
let reconnectTimer = null;
let connectionAttempts = 0;
let requestId = 1000;
let pendingRequests = new Map();
let logSubscribers = new Set();
let logWatcher = null;
let lastLogSize = 0;
let lastLogFile = "";

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

function startLogWatcher(logsDir = "/tmp/openclaw") {
    if (logWatcher) return;
    
    const fs = require("fs");
    const path = require("path");
    
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

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of subscribers) {
        try { ws.send(data); } catch {}
    }
}

function sendGatewayRequest(method, params, clientWs, clientId) {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
        return false;
    }

    const id = String(++requestId);
    const req = { type: "req", id, method, params };

    if (clientWs && clientId) {
        pendingRequests.set(id, { clientWs, clientId, method });
    }

    gatewayWs.send(JSON.stringify(req));
    return true;
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
                        ws.send(JSON.stringify({
                            type: "req",
                            id: "sessions-init",
                            method: "sessions.list",
                            params: {},
                        }));
                    } else {
                        console.error("[Backend] Connect failed:", msg.error);
                    }
                    return;
                }

                if (msg.type === "res" && (msg.id === "sessions-init" || msg.id === "sessions-refresh")) {
                    if (msg.ok && msg.payload?.sessions) {
                        sessionList = msg.payload.sessions.map(transformSession);
                        broadcast({ type: "sessions", sessions: sessionList });
                    }
                    return;
                }

                if (msg.type === "res" && msg.method === "sessions.list" && msg.ok && msg.payload?.sessions) {
                    sessionList = msg.payload.sessions.map(transformSession);
                    broadcast({ type: "sessions", sessions: sessionList });
                    return;
                }

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

                    if (pending.method && pending.method.startsWith("sessions.")) {
                        ws.send(JSON.stringify({
                            type: "req",
                            id: "sessions-refresh",
                            method: "sessions.list",
                            params: {},
                        }));
                    }
                    return;
                }

                if (msg.type === "event") {
                    broadcast({ type: "event", event: msg.event, payload: msg.payload });
                }
            } catch (e) {
                console.error("[Backend] Parse error:", e.message);
            }
        });

        ws.on("close", (code) => {
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

function getGatewayStatus() {
    return {
        gateway: isGatewayConnected ? "connected" : "disconnected",
        sessions: sessionList.length
    };
}

function handleClientConnection(ws) {
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
}

module.exports = {
    init: (token) => connectToGateway(token),
    getStatus: getGatewayStatus,
    handleClient: handleClientConnection,
    getSessions: () => sessionList,
    isConnected: () => isGatewayConnected,
};
