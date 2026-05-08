import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import Path from "node:path";

import WebSocket from "ws";

import {
    OpenClawGatewayClient,
    type DeviceIdentity,
    type OpenClawGatewayClientInstance,
    loadOrCreateDeviceIdentity,
} from "./lib/openclawGatewayClient.js";

const DASHBOARD_OPENCLAW_HOME =
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME ||
    Path.join(process.cwd(), "data", "openclaw-client");

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || Path.join(os.homedir(), ".openclaw");

function loadOrCreateDashboardDeviceIdentity(): DeviceIdentity | undefined {
    const identityPath = Path.join(
        DASHBOARD_OPENCLAW_HOME,
        ".openclaw",
        "identity",
        "device.json"
    );

    try {
        return loadOrCreateDeviceIdentity(identityPath);
    } catch (error) {
        console.warn(
            "[Gateway] Failed to load dashboard device identity, continuing without explicit identity:",
            error instanceof Error ? error.message : String(error)
        );
        return undefined;
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
    status?: string;
    endedAt?: string | number | null;
    startedAt?: string | number | null;
    runId?: string | null;
    activeRunId?: string | null;
    currentRunId?: string | null;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
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
    status?: string;
    endedAt?: string | number | null;
    startedAt?: string | number | null;
    runId?: string | null;
    activeRunId?: string | null;
    currentRunId?: string | null;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
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

interface ChatHistoryPayload {
    sessionKey?: string;
    sessionId?: string;
    messages?: unknown[];
}

interface ChatImageBlockRecord {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    source?: {
        media_type?: string;
        data?: string;
        omitted?: boolean;
    };
    omitted?: boolean;
}

interface RawTranscriptImageMessage {
    role: string;
    text: string;
    timestamp?: number;
    images: ChatImageBlockRecord[];
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
        status: session.status,
        endedAt: session.endedAt,
        startedAt: session.startedAt,
        runId: session.runId,
        activeRunId: session.activeRunId,
        currentRunId: session.currentRunId,
        isRunning: session.isRunning,
        running: session.running,
        thinkingLevel: session.thinkingLevel,
        fastMode: session.fastMode,
        verboseLevel: session.verboseLevel,
        reasoningLevel: session.reasoningLevel,
        elevatedLevel: session.elevatedLevel,
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

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function imageBlockHasOmittedData(block: Record<string, unknown>): boolean {
    if (block.type !== "image") {
        return false;
    }

    if (typeof block.data === "string" && block.data.trim()) {
        return false;
    }

    const source = asRecord(block.source);
    return block.omitted === true || source?.omitted === true || !source?.data;
}

function normalizeMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }

            const record = asRecord(block);
            return typeof record?.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function getTranscriptPath(sessionKey: string, sessionId?: string): string | null {
    if (!sessionId) {
        const session = sessionList.find((entry) => entry.key === sessionKey);
        sessionId = session?.id;
    }

    if (!sessionId || sessionId === "unknown") {
        return null;
    }

    const agentId = sessionKey.split(":")[1] || "main";
    return Path.join(OPENCLAW_HOME, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

function readRawTranscriptImageMessages(
    sessionKey: string,
    sessionId?: string
): RawTranscriptImageMessage[] {
    const transcriptPath = getTranscriptPath(sessionKey, sessionId);

    if (!transcriptPath || !transcriptPath.startsWith(OPENCLAW_HOME)) {
        return [];
    }

    let raw: string;
    try {
        raw = fs.readFileSync(transcriptPath, "utf8");
    } catch {
        return [];
    }

    const messages: RawTranscriptImageMessage[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim() || !line.includes('"type":"image"')) {
            continue;
        }

        try {
            const parsed = JSON.parse(line) as { timestamp?: unknown; message?: unknown };
            const message = asRecord(parsed.message);
            if (!message) {
                continue;
            }

            const content = message.content;

            if (!Array.isArray(content)) {
                continue;
            }

            const images = content
                .map((block) => asRecord(block))
                .filter(
                    (block): block is Record<string, unknown> =>
                        block?.type === "image" &&
                        (typeof block.data === "string" ||
                            typeof asRecord(block.source)?.data === "string")
                )
                .map((block) => ({
                    type: "image",
                    data:
                        typeof block.data === "string"
                            ? block.data
                            : (asRecord(block.source)?.data as string | undefined),
                    mimeType:
                        typeof block.mimeType === "string"
                            ? block.mimeType
                            : typeof asRecord(block.source)?.media_type === "string"
                              ? (asRecord(block.source)?.media_type as string)
                              : "image/jpeg",
                }));

            if (images.length === 0) {
                continue;
            }

            messages.push({
                role: typeof message.role === "string" ? message.role : "unknown",
                text: normalizeMessageText(content),
                timestamp:
                    normalizeTimestamp(message.timestamp) ??
                    normalizeTimestamp(parsed.timestamp),
                images,
            });
        } catch {
            // Ignore malformed transcript lines.
        }
    }

    return messages;
}

function hydrateOmittedChatHistoryImages(
    payload: unknown,
    requestedSessionKey?: string
): unknown {
    const history = asRecord(payload) as ChatHistoryPayload | null;
    const sessionKey = history?.sessionKey || requestedSessionKey;

    if (!history || !sessionKey || !Array.isArray(history.messages)) {
        return payload;
    }

    const rawImageMessages = readRawTranscriptImageMessages(
        sessionKey,
        history.sessionId
    );
    if (rawImageMessages.length === 0) {
        return payload;
    }

    let rawCursor = 0;
    history.messages = history.messages.map((message) => {
        const record = asRecord(message);
        if (!record || !Array.isArray(record.content)) {
            return message;
        }

        const omittedImageIndexes = record.content
            .map((block, index) => ({ block: asRecord(block), index }))
            .filter(({ block }) => block && imageBlockHasOmittedData(block));

        if (omittedImageIndexes.length === 0) {
            return message;
        }

        const role = typeof record.role === "string" ? record.role : "unknown";
        const text = normalizeMessageText(record.content);
        const timestamp = normalizeTimestamp(record.timestamp);
        const rawMatchIndex = rawImageMessages.findIndex((candidate, index) => {
            if (index < rawCursor || candidate.role !== role) {
                return false;
            }

            const timestampMatches =
                timestamp === undefined ||
                candidate.timestamp === undefined ||
                Math.abs(candidate.timestamp - timestamp) < 5000;
            const textMatches =
                !text ||
                !candidate.text ||
                candidate.text === text ||
                candidate.text.endsWith(text) ||
                candidate.text.includes(text);
            return timestampMatches && textMatches;
        });

        if (rawMatchIndex === -1) {
            return message;
        }

        rawCursor = rawMatchIndex + 1;
        const rawImages = rawImageMessages[rawMatchIndex]?.images || [];
        let imageCursor = 0;
        return {
            ...record,
            content: record.content.map((block) => {
                const blockRecord = asRecord(block);
                if (!blockRecord || !imageBlockHasOmittedData(blockRecord)) {
                    return block;
                }

                const rawImage = rawImages[imageCursor++];
                return rawImage || block;
            }),
        };
    });

    return history;
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
                console.error(
                    "[Gateway] Failed to refresh sessions:",
                    (error as Error).message
                );
            });
        },
        onEvent: (evt) => {
            broadcast({ type: "event", event: evt.event, payload: evt.payload });
            if (typeof evt.event === "string" && evt.event.startsWith("sessions.")) {
                void refreshSessions().catch((error) => {
                    console.error(
                        "[Gateway] Failed to refresh sessions:",
                        (error as Error).message
                    );
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
            let payload = await gatewayClient.request(method, params);
            if (method === "chat.history") {
                payload = hydrateOmittedChatHistoryImages(
                    payload,
                    typeof params.sessionKey === "string" ? params.sessionKey : undefined
                );
            }
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
                const msg = JSON.parse(data.toString()) as {
                    type?: string;
                    channel?: string;
                    method?: string;
                    params?: Record<string, unknown>;
                    id?: string;
                };

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
                    const ok = await forwardRequest(
                        msg.method,
                        msg.params || {},
                        ws,
                        msg.id
                    );
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
                console.error(
                    "[Gateway] Client message error:",
                    (error as Error).message
                );
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

async function deleteSession(sessionKey: string): Promise<unknown> {
    const result = await sendRequestAsync("sessions.delete", {
        key: sessionKey,
        deleteTranscript: true,
    });

    try {
        await refreshSessions();
    } catch (error) {
        console.warn(
            "[Gateway] Failed to refresh sessions after delete:",
            error instanceof Error ? error.message : String(error)
        );
    }

    return result;
}

async function request(
    method: string,
    params: Record<string, unknown>
): Promise<unknown> {
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

    const total = allMessages.length;
    const end = Math.max(total - offset, 0);
    const start = Math.max(end - limit, 0);
    const messages = allMessages.slice(start, end).reverse();

    return {
        messages,
        total,
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
    deleteSession,
    request,
};

export type { GatewaySession, Session };
