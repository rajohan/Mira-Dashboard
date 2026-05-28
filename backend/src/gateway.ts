import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import Path from "node:path";

import WebSocket from "ws";

import { errorMessage } from "./lib/errors.js";
import {
    type DeviceIdentity,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
} from "./lib/openclawGatewayClient.js";
import { nonEmptyEnvFallback, stringFallback } from "./lib/values.js";

const DASHBOARD_OPENCLAW_HOME = nonEmptyEnvFallback(
    "MIRA_DASHBOARD_OPENCLAW_HOME",
    Path.join(process.cwd(), "data", "openclaw-client")
);
const OPENCLAW_HOME = nonEmptyEnvFallback(
    "OPENCLAW_HOME",
    Path.join(os.homedir(), ".openclaw")
);

/** Performs load or create dashboard device IDentity. */
function loadOrCreateDashboardDeviceIdentity(
    identityPath = Path.join(
        DASHBOARD_OPENCLAW_HOME,
        ".openclaw",
        "identity",
        "device.json"
    ),
    loader = loadOrCreateDeviceIdentity
): DeviceIdentity | undefined {
    try {
        return loader(identityPath);
    } catch (error) {
        console.warn(
            "[Gateway] Failed to load dashboard device identity, continuing without explicit identity:",
            errorMessage(error, String(error))
        );
        return undefined;
    }
}

import {
    subscribeToLogs as logsSubscribe,
    unsubscribeFromLogs as logsUnsubscribe,
} from "./routes/logs.js";

/** Represents session. */
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

/** Represents gateway session. */
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

/** Represents pending request. */
interface PendingRequest {
    clientWs: WebSocket;
    clientId: string;
    method?: string;
}

/** Represents the chat history payload. */
interface ChatHistoryPayload {
    sessionKey?: string;
    sessionId?: string;
    messages?: unknown[];
}

/** Represents chat image block record. */
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

/** Represents raw transcript image message. */
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
type GatewayClientConstructor = new (
    options: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;
let GatewayClientCtor: GatewayClientConstructor = OpenClawGatewayClient;

/** Performs transform session. */
function transformSession(session: GatewaySession): Session {
    let type = "UNKNOWN";
    let agentType = "";
    const key = session.key || "";
    const keyParts = key.split(":");

    if (keyParts.length >= 2) {
        agentType = stringFallback(keyParts[1]);
    }

    let hookName = "";
    if (key.includes(":hook:")) {
        type = "HOOK";
        const hookIndex = keyParts.indexOf("hook");
        if (hookIndex !== -1 && keyParts[hookIndex + 1]) {
            hookName = stringFallback(keyParts[hookIndex + 1]);
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

/** Performs broadcast. */
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

/** Performs as record. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Performs string field. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}

/** Performs session has run IDentifier. */
function sessionHasRunIdentifier(session: Session, runId: string): boolean {
    return [
        session.id,
        session.key,
        session.runId,
        session.activeRunId,
        session.currentRunId,
    ].includes(runId);
}

/** Performs enrich runtime event payload. */
function enrichRuntimeEventPayload(event: unknown, payload: unknown): unknown {
    if (event !== "agent" && event !== "session.tool" && event !== "session.message") {
        return payload;
    }

    const record = asRecord(payload);
    if (!record || stringField(record, "sessionKey")) {
        return payload;
    }

    const runId = stringField(record, "runId");
    if (!runId) {
        return payload;
    }

    const matchingSession = sessionList.find((session) =>
        sessionHasRunIdentifier(session, runId)
    );

    return matchingSession?.key
        ? { ...record, sessionKey: matchingSession.key }
        : payload;
}

/** Performs image block has omitted data. */
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

/** Normalizes message text. */
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

/** Normalizes timestamp. */
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

/** Returns transcript path. */
function isPathInsideRoot(root: string, candidate: string): boolean {
    const relativePath = Path.relative(root, candidate);
    return !relativePath.startsWith("..") && !Path.isAbsolute(relativePath);
}

/** Returns candidate when it stays inside root. */
function resolvePathInsideRoot(root: string, candidate: string): string | null {
    return isPathInsideRoot(root, candidate) ? candidate : null;
}

/** Returns transcript path. */
function getTranscriptPath(sessionKey: string, sessionId?: string): string | null {
    const parts = sessionKey.split(":");
    if (parts[0] !== "agent") {
        return null;
    }

    if (!sessionId) {
        const session = sessionList.find((entry) => entry.key === sessionKey);
        sessionId = session?.id;
    }
    if (!sessionId || sessionId === "unknown") {
        return null;
    }

    const agentId = parts[1];
    const safeAgentPathSegment = /^[A-Za-z0-9._-]+$/u;
    const safeSessionPathSegment = /^[A-Za-z0-9:._-]+$/u;
    if (
        !agentId ||
        !safeAgentPathSegment.test(agentId) ||
        !safeSessionPathSegment.test(sessionId)
    ) {
        return null;
    }

    const openClawRoot = Path.resolve(OPENCLAW_HOME);
    const agentsSessionsRoot = Path.resolve(openClawRoot, "agents", agentId, "sessions");
    const transcriptPath = Path.resolve(agentsSessionsRoot, `${sessionId}.jsonl`);
    let realOpenClawRoot: string;
    let realAgentsSessionsRoot: string;
    let realTranscriptPath: string;
    try {
        realOpenClawRoot = fs.realpathSync(openClawRoot);
        realAgentsSessionsRoot = fs.realpathSync(agentsSessionsRoot);
        realTranscriptPath = fs.realpathSync(transcriptPath);
    } catch {
        return null;
    }

    if (!realTranscriptPath.startsWith(`${realAgentsSessionsRoot}${Path.sep}`)) {
        return null;
    }

    return resolvePathInsideRoot(realOpenClawRoot, realTranscriptPath);
}

/** Returns whether a failed session index subscription should retry. */
function shouldRetrySessionIndexSubscription(attempt: number): boolean {
    return attempt < 3;
}

/** Performs read raw transcript image messages. */
function readRawTranscriptImageMessages(
    sessionKey: string,
    sessionId?: string
): RawTranscriptImageMessage[] {
    const transcriptPath = getTranscriptPath(sessionKey, sessionId);
    if (!transcriptPath) {
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
                .filter((block): block is Record<string, unknown> => {
                    const source = asRecord(block?.source);
                    const data =
                        typeof block?.data === "string" && block.data.trim().length > 0
                            ? block.data
                            : typeof source?.data === "string"
                              ? source.data
                              : "";
                    return block?.type === "image" && data.trim().length > 0;
                })
                .map((block) => ({
                    type: "image",
                    data:
                        typeof block.data === "string" && block.data.trim().length > 0
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

/** Performs hydrate omitted chat history images. */
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
        const rawImages = rawImageMessages[rawMatchIndex]!.images;
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

function isCurrentGatewayClient(expectedClient: OpenClawGatewayClientInstance): boolean {
    return gatewayClient === expectedClient;
}

/** Performs refresh sessions. */
async function refreshSessions(
    expectedClient: OpenClawGatewayClientInstance | null = gatewayClient
): Promise<void> {
    if (
        !expectedClient ||
        !isGatewayConnected ||
        !isCurrentGatewayClient(expectedClient)
    ) {
        return;
    }

    const payload = (await expectedClient.request("sessions.list", {})) as {
        sessions?: GatewaySession[];
    };
    if (!isGatewayConnected || !isCurrentGatewayClient(expectedClient)) {
        return;
    }
    sessionList = (payload.sessions || []).map(transformSession);
    broadcast({ type: "sessions", sessions: sessionList });
}

/** Performs init. */
function init(token: string): void {
    if (currentToken === token && gatewayClient) {
        return;
    }
    const previousGatewayClient = gatewayClient;
    gatewayClient = null;
    isGatewayConnected = false;
    broadcast({ type: "disconnected", gatewayConnected: false });
    currentToken = token;
    previousGatewayClient?.stop();
    /** Returns whether this callback belongs to the active Gateway client. */
    function isCurrentInitGatewayClient(): boolean {
        return isCurrentGatewayClient(thisGatewayClient);
    }
    /** Handles successful Gateway hello negotiation and subscribes to live events. */
    function handleGatewayHelloOk(): void {
        if (!isCurrentInitGatewayClient()) {
            return;
        }
        isGatewayConnected = true;
        broadcast({ type: "connected", gatewayConnected: true });
        /** Subscribes to Gateway session index events for live session updates. */
        async function subscribeToSessionIndexEvents(attempt = 0): Promise<void> {
            if (!isCurrentInitGatewayClient() || !isGatewayConnected) {
                return;
            }
            try {
                await thisGatewayClient.request("sessions.subscribe", {});
            } catch (error) {
                if (shouldRetrySessionIndexSubscription(attempt)) {
                    const delayMs = 500 * 2 ** attempt;
                    /** Retries the session index subscription after backoff. */
                    function retrySessionIndexSubscription(): void {
                        void subscribeToSessionIndexEvents(attempt + 1);
                    }
                    setTimeout(retrySessionIndexSubscription, delayMs);
                    return;
                }
                console.warn(
                    "[Gateway] Failed to subscribe to session index events:",
                    errorMessage(error, String(error))
                );
            }
        }
        void subscribeToSessionIndexEvents();
        void refreshSessions(thisGatewayClient).catch((error) => {
            console.error(
                "[Gateway] Failed to refresh sessions:",
                errorMessage(error, String(error))
            );
        });
    }
    /** Broadcasts one Gateway runtime event and refreshes session metadata when needed. */
    function handleGatewayEvent(evt: { event?: unknown; payload?: unknown }): void {
        if (!isCurrentInitGatewayClient()) {
            return;
        }
        broadcast({
            type: "event",
            event: evt.event,
            payload: enrichRuntimeEventPayload(evt.event, evt.payload),
        });
        if (typeof evt.event === "string" && evt.event.startsWith("sessions.")) {
            void refreshSessions(thisGatewayClient).catch((error) => {
                console.error(
                    "[Gateway] Failed to refresh sessions:",
                    errorMessage(error, String(error))
                );
            });
        }
    }
    /** Logs Gateway connection failures. */
    function handleGatewayConnectError(err: Error): void {
        if (!isCurrentInitGatewayClient()) {
            return;
        }
        console.error("[Gateway] Connect failed:", err.message);
    }
    /** Marks Gateway state disconnected and informs dashboard clients. */
    function handleGatewayClose(): void {
        if (!isCurrentInitGatewayClient()) {
            return;
        }
        isGatewayConnected = false;
        broadcast({ type: "disconnected", gatewayConnected: false });
    }
    const thisGatewayClient = new GatewayClientCtor({
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
        onHelloOk: handleGatewayHelloOk,
        onEvent: handleGatewayEvent,
        onConnectError: handleGatewayConnectError,
        onClose: handleGatewayClose,
    });
    gatewayClient = thisGatewayClient;
    try {
        thisGatewayClient.start();
    } catch (error) {
        if (gatewayClient === thisGatewayClient) {
            gatewayClient = null;
            currentToken = null;
        }
        throw error;
    }
}

/** Performs forward request. */
async function forwardRequest(
    method: string,
    params: Record<string, unknown>,
    clientWs?: WebSocket,
    clientId?: string
): Promise<boolean> {
    if (!gatewayClient || !isGatewayConnected) {
        return false;
    }
    const activeGateway = gatewayClient;

    if (clientWs && clientId) {
        const id = String(++requestId);
        pendingRequests.set(id, { clientWs, clientId, method });

        try {
            let payload = await activeGateway.request(method, params);
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
                await refreshSessions(activeGateway);
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
                        error: errorMessage(error, String(error)),
                    })
                );
            }
        }
        return true;
    }

    try {
        await activeGateway.request(method, params);
        if (method.startsWith("sessions.")) {
            await refreshSessions(activeGateway);
        }
        return true;
    } catch {
        return false;
    }
}

/** Processes Gateway WebSocket client events. */
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
                    errorMessage(error, String(error))
                );
            }
        })();
    });

    ws.on("close", () => {
        subscribers.delete(ws);
        logsUnsubscribe(ws);
    });
}

/** Returns status. */
function getStatus(): { gateway: string; sessions: number } {
    return {
        gateway: isGatewayConnected ? "connected" : "disconnected",
        sessions: sessionList.length,
    };
}

/** Returns sessions. */
function getSessions(): Session[] {
    return sessionList;
}

/** Returns whether connected. */
function isConnected(): boolean {
    return isGatewayConnected;
}

/** Returns gateway ws. */
function getGatewayWs(): null {
    return null;
}

/** Performs send request async. */
async function sendRequestAsync(
    method: string,
    params: Record<string, unknown>
): Promise<unknown> {
    if (!gatewayClient || !isGatewayConnected) {
        throw new Error("Gateway not connected");
    }

    return gatewayClient.request(method, params);
}

/** Performs send session message. */
async function sendSessionMessage(sessionKey: string, message: string): Promise<void> {
    await sendRequestAsync("chat.send", {
        sessionKey,
        message,
        idempotencyKey: `tasks-notify-${crypto.randomUUID()}`,
        timeoutMs: 10_000,
    });
}

/** Performs abort session run. */
async function abortSessionRun(sessionKey: string): Promise<void> {
    await sendRequestAsync("chat.abort", {
        sessionKey,
    });
}

/** Performs delete session. */
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
            errorMessage(error, String(error))
        );
    }

    return result;
}

/** Performs request. */
async function request(
    method: string,
    params: Record<string, unknown>
): Promise<unknown> {
    return sendRequestAsync(method, params);
}

/** Defines testing. */
export const __testing = {
    transformSession,
    enrichRuntimeEventPayload,
    hydrateOmittedChatHistoryImages,
    loadOrCreateDashboardDeviceIdentity,
    readRawTranscriptImageMessages,
    getTranscriptPath,
    isPathInsideRoot,
    resolvePathInsideRoot,
    normalizeMessageText,
    normalizeTimestamp,
    imageBlockHasOmittedData,
    shouldRetrySessionIndexSubscription,
    sessionHasRunIdentifier,
    refreshSessions,
    forwardRequest,
    /** Replaces the in-memory session list for focused gateway tests. */
    setSessionListForTest(sessions: Session[]): void {
        sessionList = sessions;
    },
    /** Replaces the Gateway client for focused connected-state tests. */
    setGatewayClientForTest(client: OpenClawGatewayClientInstance | null): void {
        gatewayClient = client;
    },
    /** Replaces the Gateway connected flag for focused connected-state tests. */
    setGatewayConnectedForTest(connected: boolean): void {
        isGatewayConnected = connected;
    },
    /** Replaces the Gateway client constructor for deterministic init tests. */
    setGatewayClientConstructorForTest(
        constructor_: new (
            options: OpenClawGatewayClientOptions
        ) => OpenClawGatewayClientInstance
    ): void {
        GatewayClientCtor = constructor_;
    },
    /** Clears mutable gateway state between tests. */
    resetGatewayStateForTest(): void {
        gatewayClient?.stop();
        subscribers.clear();
        sessionList = [];
        isGatewayConnected = false;
        pendingRequests.clear();
        gatewayClient = null;
        GatewayClientCtor = OpenClawGatewayClient;
        currentToken = null;
        requestId = 1000;
    },
};

export default {
    init,
    handleClient,
    getStatus,
    getSessions,
    isConnected,
    getGatewayWs,
    sendSessionMessage,
    abortSessionRun,
    deleteSession,
    request,
};

export type { GatewaySession, Session };
