import crypto from "node:crypto";
import fs from "node:fs";
import Path from "node:path";
import { createRequire } from "node:module";

import WebSocket from "ws";

const require = createRequire(import.meta.url);

type OpenClawGatewayClientOptions = {
    url?: string;
    token?: string;
    role?: string;
    scopes?: string[];
    caps?: string[];
    clientName?: string;
    clientDisplayName?: string;
    mode?: string;
    platform?: string;
    deviceFamily?: string;
    deviceIdentity?: unknown;
    onHelloOk?: () => void;
    onEvent?: (evt: { event?: string; payload?: unknown }) => void;
    onConnectError?: (err: Error) => void;
    onClose?: (code: number, reason: string) => void;
};

type OpenClawGatewayClientInstance = {
    start: () => void;
    stop: () => void;
    request: (method: string, params?: unknown) => Promise<unknown>;
};

type OpenClawGatewayClientCtor = new (
    opts: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;

function loadOpenClawGatewayRuntime(): {
    GatewayClient?: OpenClawGatewayClientCtor;
    loadOrCreateDeviceIdentity?: () => unknown;
    u?: OpenClawGatewayClientCtor;
    dn?: () => unknown;
    zs?: OpenClawGatewayClientCtor;
    Pl?: () => unknown;
} {
    const distDir = "/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist";
    const entries = fs.readdirSync(distDir);

    const candidates = [
        ...entries.filter((entry) => entry.startsWith("method-scopes-") && entry.endsWith(".js")),
        ...entries.filter((entry) => entry.startsWith("reply-") && entry.endsWith(".js")),
    ];

    for (const entry of candidates) {
        const runtime = require(Path.join(distDir, entry)) as {
            GatewayClient?: OpenClawGatewayClientCtor;
            loadOrCreateDeviceIdentity?: () => unknown;
            u?: OpenClawGatewayClientCtor;
            dn?: () => unknown;
            zs?: OpenClawGatewayClientCtor;
            Pl?: () => unknown;
        };

        if (
            (typeof runtime.u === "function" || typeof runtime.GatewayClient === "function" || typeof runtime.zs === "function") &&
            (typeof runtime.dn === "function" || typeof runtime.loadOrCreateDeviceIdentity === "function" || typeof runtime.Pl === "function")
        ) {
            return runtime;
        }
    }

    throw new Error("Could not locate compatible OpenClaw gateway runtime in dist/");
}

const openclawGatewayRuntime = loadOpenClawGatewayRuntime();
const resolvedGatewayClientCtor =
    openclawGatewayRuntime.GatewayClient ||
    openclawGatewayRuntime.u ||
    openclawGatewayRuntime.zs;
const resolvedLoadOrCreateDeviceIdentity =
    openclawGatewayRuntime.loadOrCreateDeviceIdentity ||
    openclawGatewayRuntime.dn ||
    openclawGatewayRuntime.Pl;

if (!resolvedGatewayClientCtor || !resolvedLoadOrCreateDeviceIdentity) {
    throw new Error("Failed to resolve OpenClaw gateway runtime exports");
}

const OpenClawGatewayClient: OpenClawGatewayClientCtor = resolvedGatewayClientCtor;
const loadOrCreateDeviceIdentity: () => unknown = resolvedLoadOrCreateDeviceIdentity;

const DASHBOARD_OPENCLAW_HOME =
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME ||
    Path.join(process.cwd(), "data", "openclaw-client");

function loadOrCreateDashboardDeviceIdentity(): unknown {
    const previousHome = process.env.HOME;

    fs.mkdirSync(Path.join(DASHBOARD_OPENCLAW_HOME, ".openclaw", "identity"), {
        recursive: true,
    });

    try {
        process.env.HOME = DASHBOARD_OPENCLAW_HOME;
        return loadOrCreateDeviceIdentity();
    } finally {
        if (typeof previousHome === "string") {
            process.env.HOME = previousHome;
        } else {
            delete process.env.HOME;
        }
    }
}

import {
    subscribeToLogs as logsSubscribe,
    unsubscribeFromLogs as logsUnsubscribe,
} from "./routes/logs.js";

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

interface HistoryMessage {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    timestamp?: string | number;
}

let gatewayClient: OpenClawGatewayClientInstance | null = null;
const subscribers = new Set<WebSocket>();
let sessionList: Session[] = [];
let isGatewayConnected = false;
let requestId = 1000;
const pendingRequests = new Map<string, PendingRequest>();
let currentToken: string | null = null;

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
        type,
        agentType,
        hookName,
        kind: session.kind,
        model: session.model || "Unknown",
        tokenCount: session.totalTokens || 0,
        maxTokens: session.contextTokens || 200000,
        createdAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
        updatedAt: session.updatedAt,
        displayName: session.displayName || "",
        label: session.label || "",
        displayLabel,
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

async function refreshSessions(): Promise<void> {
    if (!gatewayClient || !isGatewayConnected) {
        return;
    }

    const payload = (await gatewayClient.request("sessions.list", {})) as {
        sessions?: GatewaySession[];
    };

    sessionList = (payload.sessions || []).map(transformSession);
    broadcast({ type: "sessions", sessions: sessionList });
}

function init(token: string): void {
    if (currentToken === token && gatewayClient) {
        return;
    }

    currentToken = token;
    gatewayClient?.stop();
    gatewayClient = new OpenClawGatewayClient({
        url: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789",
        token,
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-events"],
        clientName: "gateway-client",
        clientDisplayName: "Mira Dashboard Backend",
        mode: "backend",
        platform: "node",
        deviceFamily: "server",
        deviceIdentity: loadOrCreateDashboardDeviceIdentity(),
        onHelloOk: () => {
            isGatewayConnected = true;
            broadcast({ type: "connected", gatewayConnected: true });
            void refreshSessions().catch((error) => {
                console.error("[Gateway] Failed to refresh sessions:", (error as Error).message);
            });
        },
        onEvent: (evt) => {
            broadcast({ type: "event", event: evt.event, payload: evt.payload });
            if (typeof evt.event === "string" && evt.event.startsWith("sessions.")) {
                void refreshSessions().catch((error) => {
                    console.error("[Gateway] Failed to refresh sessions:", (error as Error).message);
                });
            }
        },
        onConnectError: (err) => {
            console.error("[Gateway] Connect failed:", err.message);
        },
        onClose: () => {
            isGatewayConnected = false;
            broadcast({ type: "disconnected", gatewayConnected: false });
        },
    });

    gatewayClient.start();
}

async function forwardRequest(
    method: string,
    params: Record<string, unknown>,
    clientWs?: WebSocket,
    clientId?: string
): Promise<boolean> {
    if (!gatewayClient || !isGatewayConnected) {
        return false;
    }

    if (clientWs && clientId) {
        const id = String(++requestId);
        pendingRequests.set(id, { clientWs, clientId, method });

        try {
            const payload = await gatewayClient.request(method, params);
            const pending = pendingRequests.get(id);
            pendingRequests.delete(id);
            if (pending?.clientWs.readyState === WebSocket.OPEN) {
                pending.clientWs.send(
                    JSON.stringify({
                        type: "res",
                        id: pending.clientId,
                        ok: true,
                        payload,
                    })
                );
            }
            if (method.startsWith("sessions.")) {
                await refreshSessions();
            }
        } catch (error) {
            const pending = pendingRequests.get(id);
            pendingRequests.delete(id);
            if (pending?.clientWs.readyState === WebSocket.OPEN) {
                pending.clientWs.send(
                    JSON.stringify({
                        type: "res",
                        id: pending.clientId,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    })
                );
            }
        }
        return true;
    }

    try {
        await gatewayClient.request(method, params);
        if (method.startsWith("sessions.")) {
            await refreshSessions();
        }
        return true;
    } catch {
        return false;
    }
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
        void (async () => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === "subscribe" && msg.channel === "logs") {
                    logsSubscribe(ws);
                    return;
                }

                if (msg.type === "unsubscribe" && msg.channel === "logs") {
                    logsUnsubscribe(ws);
                    return;
                }

                if (
                    (msg.type === "request" || msg.type === "req") &&
                    msg.method === "subscribe" &&
                    msg.params?.channel === "logs"
                ) {
                    logsSubscribe(ws);
                    if (msg.id) {
                        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true }));
                    }
                    return;
                }

                if (
                    (msg.type === "request" || msg.type === "req") &&
                    msg.method === "unsubscribe" &&
                    msg.params?.channel === "logs"
                ) {
                    logsUnsubscribe(ws);
                    if (msg.id) {
                        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true }));
                    }
                    return;
                }

                if ((msg.type === "request" || msg.type === "req") && msg.method) {
                    const ok = await forwardRequest(msg.method, msg.params || {}, ws, msg.id);
                    if (!ok && msg.id && ws.readyState === WebSocket.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "res",
                                id: msg.id,
                                ok: false,
                                error: "Gateway not connected",
                            })
                        );
                    }
                }
            } catch (error) {
                console.error("[Gateway] Client message error:", (error as Error).message);
            }
        })();
    });

    ws.on("close", () => {
        subscribers.delete(ws);
        logsUnsubscribe(ws);
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

function getGatewayWs(): null {
    return null;
}

async function sendRequestAsync(
    method: string,
    params: Record<string, unknown>
): Promise<unknown> {
    if (!gatewayClient || !isGatewayConnected) {
        throw new Error("Gateway not connected");
    }

    return gatewayClient.request(method, params);
}

async function sendSessionMessage(sessionKey: string, message: string): Promise<void> {
    await sendRequestAsync("chat.send", {
        sessionKey,
        message,
        idempotencyKey: `tasks-notify-${crypto.randomUUID()}`,
        timeoutMs: 10_000,
    });
}

async function abortSessionRun(sessionKey: string): Promise<void> {
    await sendRequestAsync("chat.abort", {
        sessionKey,
    });
}

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return sendRequestAsync(method, params);
}

async function getSessionHistory(
    sessionKey: string,
    limit: number = 50,
    offset: number = 0
): Promise<{
    messages: Array<{ role: string; content: string; timestamp?: string }>;
    total: number;
}> {
    const result = (await sendRequestAsync("chat.history", {
        sessionKey,
        limit: Math.max(limit + offset, 200),
    })) as {
        messages?: HistoryMessage[];
    };

    const allMessages = (result.messages || []).map((msg) => ({
        role: msg.role || "unknown",
        content: Array.isArray(msg.content)
            ? msg.content.map((block) => block?.text || "").join("")
            : String(msg.content || ""),
        timestamp:
            typeof msg.timestamp === "number"
                ? new Date(msg.timestamp).toISOString()
                : msg.timestamp,
    }));

    return {
        messages: allMessages.slice(offset, offset + limit),
        total: allMessages.length,
    };
}

export default {
    init,
    handleClient,
    getStatus,
    getSessions,
    isConnected,
    getGatewayWs,
    getSessionHistory,
    sendSessionMessage,
    abortSessionRun,
    request,
};

export type { GatewaySession, Session };
