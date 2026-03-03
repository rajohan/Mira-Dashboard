import WebSocket from "ws";

interface Session {
    id: string;
    key: string;
    type: string;
    agentType: string;
    hookName: string;
    kind?: string;
    model: string;
    tokenCount: number;
    maxTokens: number;
    createdAt: string | null;
    updatedAt?: number;
    displayName: string;
    label: string;
    displayLabel: string;
    channel: string;
}

interface GatewaySession {
    sessionId?: string;
    key?: string;
    kind?: string;
    model?: string;
    totalTokens?: number;
    contextTokens?: number;
    updatedAt?: number;
    displayName?: string;
    label?: string;
    channel?: string;
}

interface PendingRequest {
    clientWs: WebSocket;
    clientId: string;
    method?: string;
}

interface GatewayMessage {
    type: string;
    id: string;
    method?: string;
    ok?: boolean;
    payload?: { sessions?: GatewaySession[] };
    error?: string;
    event?: string;
    params?: Record<string, unknown>;
}

let gatewayWs: WebSocket | null = null;
const subscribers = new Set<WebSocket>();
let sessionList: Session[] = [];
let isGatewayConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let connectionAttempts = 0;
let requestId = 1000;
const pendingRequests = new Map<string, PendingRequest>();

function transformSession(session: GatewaySession): Session {
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
            hookName = keyParts[hookIndex + 1] || "";
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
        key: session.key || "",
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

function broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of subscribers) {
        try {
            ws.send(data);
        } catch {
            // Ignore errors from closed connections
        }
    }
}

function connect(token: string): void {
    if (
        gatewayWs &&
        (gatewayWs.readyState === WebSocket.OPEN ||
            gatewayWs.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    console.log("[Gateway] Connecting to:", gatewayUrl);

    try {
        const ws = new WebSocket(gatewayUrl + "?token=" + encodeURIComponent(token));
        gatewayWs = ws;
        connectionAttempts++;

        ws.on("open", () => {
            console.log("[Gateway] WS open, sending connect...");
            ws.send(
                JSON.stringify({
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
                })
            );
        });

        ws.on("message", (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString()) as GatewayMessage;

                if (msg.type === "res" && msg.id === "connect-1") {
                    if (msg.ok) {
                        console.log("[Gateway] Connected!");
                        isGatewayConnected = true;
                        connectionAttempts = 0;
                        broadcast({ type: "connected", gatewayConnected: true });
                        ws.send(
                            JSON.stringify({
                                type: "req",
                                id: "sessions-init",
                                method: "sessions.list",
                                params: {},
                            })
                        );
                    } else {
                        console.error("[Gateway] Connect failed:", msg.error);
                    }
                    return;
                }

                if (
                    msg.type === "res" &&
                    (msg.id === "sessions-init" || msg.id === "sessions-refresh")
                ) {
                    if (msg.ok && msg.payload?.sessions) {
                        sessionList = msg.payload.sessions.map(transformSession);
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
                    broadcast({ type: "sessions", sessions: sessionList });
                    return;
                }

                if (msg.type === "res" && pendingRequests.has(msg.id)) {
                    const pending = pendingRequests.get(msg.id);
                    pendingRequests.delete(msg.id);

                    if (
                        pending?.clientWs &&
                        pending.clientWs.readyState === WebSocket.OPEN
                    ) {
                        pending.clientWs.send(
                            JSON.stringify({
                                type: "res",
                                id: pending.clientId,
                                ok: msg.ok,
                                payload: msg.payload,
                                error: msg.error,
                            })
                        );
                    }

                    if (pending?.method && pending.method.startsWith("sessions.")) {
                        ws.send(
                            JSON.stringify({
                                type: "req",
                                id: "sessions-refresh",
                                method: "sessions.list",
                                params: {},
                            })
                        );
                    }
                    return;
                }

                if (msg.type === "event") {
                    broadcast({ type: "event", event: msg.event, payload: msg.payload });
                }
            } catch (error) {
                console.error("[Gateway] Parse error:", (error as Error).message);
            }
        });

        ws.on("close", (code: number) => {
            console.log("[Gateway] Closed:", code);
            gatewayWs = null;
            isGatewayConnected = false;
            broadcast({ type: "disconnected" });
            scheduleReconnect(token);
        });

        ws.on("error", (err: Error) => {
            console.error("[Gateway] Error:", err.message);
        });
    } catch (error) {
        console.error("[Gateway] Connect error:", (error as Error).message);
        scheduleReconnect(token);
    }
}

function scheduleReconnect(token: string): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(5000 * Math.pow(1.5, connectionAttempts), 60000);
    console.log("[Gateway] Reconnecting in " + delay + "ms...");
    reconnectTimer = setTimeout(() => connect(token), delay);
}

function sendRequest(
    method: string,
    params: Record<string, unknown>,
    clientWs?: WebSocket,
    clientId?: string
): boolean {
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

function handleClient(ws: WebSocket): void {
    subscribers.add(ws);
    ws.send(
        JSON.stringify({
            type: "state",
            gatewayConnected: isGatewayConnected,
            sessions: sessionList,
        })
    );

    ws.on("message", (data: Buffer) => {
        try {
            const msg = JSON.parse(data.toString());

            if ((msg.type === "request" || msg.type === "req") && msg.method) {
                sendRequest(msg.method, msg.params || {}, ws, msg.id);
            }
        } catch (error) {
            console.error("[Gateway] Client message error:", (error as Error).message);
        }
    });

    ws.on("close", () => {
        subscribers.delete(ws);
    });
}

function getStatus(): { gateway: string; sessions: number } {
    return {
        gateway: isGatewayConnected ? "connected" : "disconnected",
        sessions: sessionList.length,
    };
}

function getSessions(): Session[] {
    return sessionList;
}

function isConnected(): boolean {
    return isGatewayConnected;
}

function getGatewayWs(): WebSocket | null {
    return gatewayWs;
}

export default {
    init: connect,
    handleClient,
    getStatus,
    getSessions,
    isConnected,
    getGatewayWs,
};

export type { GatewaySession, Session };
