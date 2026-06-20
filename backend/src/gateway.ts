import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import Path from "node:path";

import WebSocket from "ws";

import { errorMessage } from "./lib/errors.ts";
import {
    type DeviceIdentity,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
} from "./lib/openclawGatewayClient.ts";
import { nonEmptyEnvironmentFallback, stringFallback } from "./lib/values.ts";

function validateOpenClawRoot(rootPath: string, environmentName: string): string {
    const resolved = Path.resolve(rootPath);
    if (!Path.isAbsolute(rootPath) || resolved === Path.parse(resolved).root) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    return resolved;
}

function defaultOpenClawHome(): string {
    const homeDirectory = os.homedir();
    return homeDirectory
        ? Path.join(homeDirectory, ".openclaw")
        : Path.join(process.cwd(), "data", "openclaw");
}

const DEFAULT_DASHBOARD_OPENCLAW_HOME = Path.join(
    process.cwd(),
    "data",
    "openclaw-client"
);
const DASHBOARD_OPENCLAW_HOME = validateOpenClawRoot(
    nonEmptyEnvironmentFallback(
        "MIRA_DASHBOARD_OPENCLAW_HOME",
        DEFAULT_DASHBOARD_OPENCLAW_HOME
    ).trim(),
    "MIRA_DASHBOARD_OPENCLAW_HOME"
);
const OPENCLAW_HOME = validateOpenClawRoot(
    nonEmptyEnvironmentFallback("OPENCLAW_HOME", defaultOpenClawHome()).trim(),
    "OPENCLAW_HOME"
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
} from "./routes/logs.ts";

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

const gatewayState: {
    client: OpenClawGatewayClientInstance | null;
    sessions: Session[];
    isConnected: boolean;
    requestId: number;
    currentToken: string | null;
} = {
    client: null,
    sessions: [],
    isConnected: false,
    requestId: 1000,
    currentToken: null,
};
const subscribers = new Set<WebSocket>();
const pendingRequests = new Map<string, PendingRequest>();
type GatewayClientConstructor = new (
    options: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;
const GatewayClientCtor: GatewayClientConstructor = OpenClawGatewayClient;

function sendPendingRequestError(pending: PendingRequest, error: string): void {
    try {
        if (pending.clientWs.readyState === WebSocket.OPEN) {
            pending.clientWs.send(
                JSON.stringify({
                    type: "response",
                    id: pending.clientId,
                    isOk: false,
                    error,
                })
            );
        }
    } catch {
        // Ignore reply write failures; the client is already gone.
    }
}

function failPendingRequests(error: string): void {
    for (const pending of pendingRequests.values()) {
        sendPendingRequestError(pending, error);
    }
    pendingRequests.clear();
}

async function refreshSessionsAfterRequest(
    activeGateway: OpenClawGatewayClientInstance
): Promise<void> {
    try {
        await refreshSessions(activeGateway);
    } catch (error) {
        console.warn(
            "[Gateway] Failed to refresh sessions after request:",
            errorMessage(error, String(error))
        );
    }
}

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
        const nextHookPart = keyParts.at(hookIndex + 1);
        if (hookIndex !== -1 && nextHookPart) {
            hookName = stringFallback(nextHookPart);
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

    const createdAtDate =
        session.updatedAt === null || session.updatedAt === undefined
            ? null
            : new Date(session.updatedAt);
    const createdAt = createdAtDate ? createdAtDate.toISOString() : null;

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
        createdAt,
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
function broadcast(message: unknown): void {
    const data = JSON.stringify(message);
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
function hasSessionRunIdentifier(session: Session, runId: string): boolean {
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

    const matchingSession = gatewayState.sessions.find((session) =>
        hasSessionRunIdentifier(session, runId)
    );

    return matchingSession?.key
        ? { ...record, sessionKey: matchingSession.key }
        : payload;
}

/** Performs image block has omitted data. */
function hasImageBlockOmittedData(block: Record<string, unknown>): boolean {
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
    if (parts[0]?.toLowerCase() !== "agent") {
        return null;
    }

    if (!sessionId) {
        const session = gatewayState.sessions.find((entry) => entry.key === sessionKey);
        sessionId = session?.id;
    }
    if (!sessionId || sessionId === "unknown") {
        return null;
    }

    const agentId = parts[1];
    const safeAgentPathSegment = /^[A-Za-z0-9_-]+$/u;
    const safeSessionPathSegment = /^[A-Za-z0-9:_-]+$/u;
    if (
        !agentId ||
        !safeAgentPathSegment.test(agentId) ||
        !safeSessionPathSegment.test(sessionId)
    ) {
        return null;
    }

    const openClawRoot = Path.resolve(OPENCLAW_HOME);
    const agentDirectory = Path.resolve(openClawRoot, "agents", agentId);
    const agentsSessionsRoot = Path.resolve(agentDirectory, "sessions");
    const transcriptPath = Path.resolve(agentsSessionsRoot, `${sessionId}.jsonl`);
    let realOpenClawRoot: string;
    let realAgentsSessionsRoot: string;
    let realTranscriptPath: string;
    try {
        realOpenClawRoot = fs.realpathSync(openClawRoot);
        const realAgentDirectory = fs.realpathSync(agentDirectory);
        if (realAgentDirectory !== Path.resolve(realOpenClawRoot, "agents", agentId)) {
            return null;
        }
        realAgentsSessionsRoot = fs.realpathSync(
            Path.resolve(realAgentDirectory, "sessions")
        );
        if (!realAgentsSessionsRoot.startsWith(`${realAgentDirectory}${Path.sep}`)) {
            return null;
        }
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
            .filter(({ block }) => block && hasImageBlockOmittedData(block));
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

            const isTimestampMatches =
                timestamp === undefined ||
                candidate.timestamp === undefined ||
                Math.abs(candidate.timestamp - timestamp) < 5000;
            const textMatches =
                !text ||
                !candidate.text ||
                candidate.text === text ||
                candidate.text.endsWith(text) ||
                candidate.text.includes(text);
            return isTimestampMatches && textMatches;
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
                if (!blockRecord || !hasImageBlockOmittedData(blockRecord)) {
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
    return gatewayState.client === expectedClient;
}

/** Performs refresh sessions. */
async function refreshSessions(
    expectedClient: OpenClawGatewayClientInstance | null = gatewayState.client
): Promise<void> {
    if (
        !expectedClient ||
        !gatewayState.isConnected ||
        !isCurrentGatewayClient(expectedClient)
    ) {
        return;
    }

    const response = await expectedClient.request("sessions.list", {});
    if (gatewayState.isConnected && isCurrentGatewayClient(expectedClient)) {
        const payload = asRecord(response);
        const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
        gatewayState.sessions = sessions
            .map((entry) => asRecord(entry))
            .filter(
                (entry): entry is Record<string, unknown> =>
                    entry !== null &&
                    (entry.sessionId === undefined ||
                        typeof entry.sessionId === "string") &&
                    (entry.key === undefined || typeof entry.key === "string") &&
                    (entry.updatedAt === undefined ||
                        entry.updatedAt === null ||
                        (typeof entry.updatedAt === "number" &&
                            Number.isFinite(entry.updatedAt)) ||
                        (typeof entry.updatedAt === "string" &&
                            !Number.isNaN(Date.parse(entry.updatedAt)))) &&
                    (stringFallback(entry.sessionId).trim() ||
                        stringFallback(entry.key).trim()) !== ""
            )
            .map((entry) => {
                const updatedAt =
                    typeof entry.updatedAt === "string"
                        ? Date.parse(entry.updatedAt)
                        : entry.updatedAt;
                return transformSession({
                    ...(entry as GatewaySession),
                    updatedAt:
                        typeof updatedAt === "number" && Number.isFinite(updatedAt)
                            ? updatedAt
                            : undefined,
                });
            });
        broadcast({ type: "sessions", sessions: gatewayState.sessions });
    }
}

/** Performs init. */
function init(token: string): void {
    if (gatewayState.currentToken === token && gatewayState.client) {
        return;
    }
    const previousGatewayClient = gatewayState.client;
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        console.error("[Gateway] Failed to stop wasPrevious client before init:", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== null,
        });
    }
    if (gatewayState.client === previousGatewayClient) {
        gatewayState.client = null;
    }
    gatewayState.isConnected = false;
    gatewayState.sessions = [];
    failPendingRequests("Gateway disconnected");
    broadcast({ type: "disconnected", gatewayConnected: false });
    gatewayState.currentToken = token;
    let thisGatewayClient: OpenClawGatewayClientInstance | null = null;
    /** Returns the active Gateway client when this callback belongs to it. */
    function getCurrentInitGatewayClient(): OpenClawGatewayClientInstance | null {
        return thisGatewayClient && isCurrentGatewayClient(thisGatewayClient)
            ? thisGatewayClient
            : null;
    }
    /** Handles successful Gateway hello negotiation and subscribes to live events. */
    function handleGatewayHelloOk(): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        gatewayState.isConnected = true;
        broadcast({ type: "connected", gatewayConnected: true });
        /** Subscribes to Gateway session index events for live session updates. */
        async function subscribeToSessionIndexEvents(attempt = 0): Promise<void> {
            const currentClient = getCurrentInitGatewayClient();
            if (!currentClient || !gatewayState.isConnected) {
                return;
            }
            try {
                await currentClient.request("sessions.subscribe", {});
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
        void refreshGatewaySessions(activeClient);
    }
    /** Broadcasts one Gateway runtime event and refreshes session metadata when needed. */
    function handleGatewayEvent(event: { event?: unknown; payload?: unknown }): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        broadcast({
            type: "event",
            event: event.event,
            payload: enrichRuntimeEventPayload(event.event, event.payload),
        });
        if (typeof event.event === "string" && event.event.startsWith("sessions.")) {
            void refreshGatewaySessions(activeClient);
        }
    }
    /** Refreshes Gateway sessions and logs failures from event callbacks. */
    async function refreshGatewaySessions(
        activeClient: OpenClawGatewayClientInstance
    ): Promise<void> {
        try {
            await refreshSessions(activeClient);
        } catch (error) {
            console.error(
                "[Gateway] Failed to refresh sessions:",
                errorMessage(error, String(error))
            );
        }
    }
    /** Logs Gateway connection failures. */
    function handleGatewayConnectError(error: Error): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        console.error("[Gateway] Connect failed:", error.message);
    }
    /** Marks Gateway state disconnected and informs dashboard clients. */
    function handleGatewayClose(): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        gatewayState.isConnected = false;
        gatewayState.sessions = [];
        failPendingRequests("Gateway disconnected");
        broadcast({ type: "disconnected", gatewayConnected: false });
    }
    thisGatewayClient = new GatewayClientCtor({
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
    gatewayState.client = thisGatewayClient;
    try {
        thisGatewayClient.start();
    } catch (error) {
        if (gatewayState.client === thisGatewayClient) {
            gatewayState.client = null;
            gatewayState.currentToken = null;
        }
        throw error;
    }
}

/** Performs forward request. */
async function forwardRequest(
    method: string,
    parameters: Record<string, unknown>,
    clientWs?: WebSocket,
    clientId?: string
): Promise<boolean> {
    if (!gatewayState.client || !gatewayState.isConnected) {
        return false;
    }
    const activeGateway = gatewayState.client;

    if (clientWs && clientId) {
        const id = String(++gatewayState.requestId);
        pendingRequests.set(id, { clientWs, clientId, method });

        try {
            let payload = await activeGateway.request(method, parameters);
            if (method === "chat.history") {
                payload = hydrateOmittedChatHistoryImages(
                    payload,
                    typeof parameters.sessionKey === "string"
                        ? parameters.sessionKey
                        : undefined
                );
            }
            const pending = pendingRequests.get(id);
            pendingRequests.delete(id);
            try {
                if (pending?.clientWs.readyState === WebSocket.OPEN) {
                    pending.clientWs.send(
                        JSON.stringify({
                            type: "response",
                            id: pending.clientId,
                            isOk: true,
                            payload,
                        })
                    );
                }
            } catch {
                // Ignore reply write failures; the Gateway call already succeeded.
            }
            if (method.startsWith("sessions.")) {
                await refreshSessionsAfterRequest(activeGateway);
            }
        } catch (error) {
            const pending = pendingRequests.get(id);
            pendingRequests.delete(id);
            if (pending) {
                sendPendingRequestError(pending, errorMessage(error, String(error)));
            }
        }
        return true;
    }

    try {
        await activeGateway.request(method, parameters);
        if (method.startsWith("sessions.")) {
            await refreshSessionsAfterRequest(activeGateway);
        }
        return true;
    } catch {
        return false;
    }
}

/** Processes Gateway WebSocket client events. */
function handleClient(ws: WebSocket): void {
    const cleanupClient = () => {
        subscribers.delete(ws);
        logsUnsubscribe(ws);
        for (const [id, pending] of pendingRequests) {
            if (pending.clientWs === ws) {
                pendingRequests.delete(id);
            }
        }
    };

    ws.on("error", (error) => {
        console.error(
            "[Gateway] Client socket error:",
            errorMessage(error, String(error))
        );
        cleanupClient();
    });

    subscribers.add(ws);
    try {
        ws.send(
            JSON.stringify({
                type: "state",
                gatewayConnected: gatewayState.isConnected,
                sessions: gatewayState.sessions,
            })
        );
    } catch (error) {
        console.error(
            "[Gateway] Failed to send initial client state:",
            errorMessage(error, String(error))
        );
        cleanupClient();
        ws.close();
        return;
    }

    ws.on("message", (data: Buffer) => {
        void (async () => {
            try {
                const message = JSON.parse(data.toString()) as {
                    type?: string;
                    channel?: string;
                    method?: string;
                    params?: Record<string, unknown>;
                    id?: string;
                };
                if (message.type === "subscribe" && message.channel === "logs") {
                    logsSubscribe(ws);
                    return;
                }
                if (message.type === "unsubscribe" && message.channel === "logs") {
                    logsUnsubscribe(ws);
                    return;
                }

                if (
                    (message.type === "request" || message.type === "req") &&
                    message.method === "subscribe" &&
                    message.params?.channel === "logs"
                ) {
                    logsSubscribe(ws);
                    if (message.id) {
                        ws.send(
                            JSON.stringify({
                                type: "response",
                                id: message.id,
                                isOk: true,
                            })
                        );
                    }
                    return;
                }

                if (
                    (message.type === "request" || message.type === "req") &&
                    message.method === "unsubscribe" &&
                    message.params?.channel === "logs"
                ) {
                    logsUnsubscribe(ws);
                    if (message.id) {
                        ws.send(
                            JSON.stringify({
                                type: "response",
                                id: message.id,
                                isOk: true,
                            })
                        );
                    }
                    return;
                }
                if (
                    (message.type === "request" || message.type === "req") &&
                    message.method
                ) {
                    const isOk = await forwardRequest(
                        message.method,
                        message.params || {},
                        ws,
                        message.id
                    );
                    if (!isOk && message.id && ws.readyState === WebSocket.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "response",
                                id: message.id,
                                isOk: false,
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
        cleanupClient();
    });
}

/** Returns status. */
function getStatus(): { gateway: string; sessions: number } {
    return {
        gateway: gatewayState.isConnected ? "connected" : "disconnected",
        sessions: gatewayState.sessions.length,
    };
}

/** Returns sessions. */
function getSessions(): Session[] {
    return gatewayState.sessions;
}

/** Returns whether connected. */
function isConnected(): boolean {
    return gatewayState.isConnected;
}

/** Returns gateway ws. */
function getGatewayWs(): null {
    return null;
}

/** Performs send request async. */
async function sendRequestAsync(
    method: string,
    parameters: Record<string, unknown>
): Promise<unknown> {
    if (!gatewayState.client || !gatewayState.isConnected) {
        throw new Error("Gateway not connected");
    }

    return gatewayState.client.request(method, parameters);
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
    parameters: Record<string, unknown>
): Promise<unknown> {
    return sendRequestAsync(method, parameters);
}

/** Stops the active Gateway client and clears connected state. */
function shutdown(): void {
    const previousGatewayClient = gatewayState.client;
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        console.error("[Gateway] Failed to stop wasPrevious client during shutdown:", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== null,
        });
    }
    if (gatewayState.client === previousGatewayClient) {
        gatewayState.client = null;
    }
    gatewayState.isConnected = false;
    gatewayState.sessions = [];
    gatewayState.currentToken = null;
    failPendingRequests("Gateway disconnected");
    broadcast({ type: "disconnected", gatewayConnected: false });
}

/** Defines testing. */

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
    shutdown,
};

export type { GatewaySession, Session };
