import fs from "node:fs";
import os from "node:os";
import Path from "node:path";

import type { GatewayMetrics } from "../../contracts/metrics.ts";
import type { Session } from "../../contracts/sessions.ts";
import type { DashboardSettingsResponse } from "../../contracts/settings.ts";
import { parseDashboardSocketRequest } from "../../contracts/socket.ts";
import { OpenClawChatBridge } from "./chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "./chat/openClawChatSnapshotStore.ts";
import type { DashboardSocket } from "./dashboardSocket.ts";
import {
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "./lib/dashboardPaths.ts";
import { errorMessage } from "./lib/errors.ts";
import { hashedLogCorrelation, runWithLogContext } from "./lib/logContext.ts";
import {
    type DeviceIdentity,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
    type OpenClawGatewayRequestOptions,
} from "./lib/openclawGatewayClient.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";
import {
    nonEmptyEnvironmentFallback,
    stringFallback,
    unknownArray,
} from "./lib/values.ts";
import {
    subscribeToDashboardLogs,
    unsubscribeFromDashboardLogs,
} from "./services/appLogStreams.ts";
import {
    subscribeToLogs as logsSubscribe,
    unsubscribeFromLogs as logsUnsubscribe,
} from "./services/logStreams.ts";

const logger = createStructuredLogger("gateway");

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

const DEFAULT_DASHBOARD_OPENCLAW_HOME =
    resolveDashboardProjectPathsForRuntime()?.productionOpenClawHome ??
    Path.join(process.cwd(), "data", "openclaw-client");

/**
 * Performs load or create dashboard device IDentity.
 * @param identityPath Identity path value.
 * @param loader Loader value.
 * @returns Load or create dashboard device IDentity result.
 */
function loadOrCreateDashboardDeviceIdentity(
    identityPath = Path.join(
        gatewayRuntime.dashboardOpenClawHome,
        ".openclaw",
        "identity",
        "device.json"
    ),
    loader = loadOrCreateDeviceIdentity
): DeviceIdentity | undefined {
    try {
        return loader(identityPath);
    } catch (error) {
        logger.warn("gateway.device_identity_load_failed", { error });
        return undefined;
    }
}

/** Represents gateway session. */
interface GatewaySession {
    sessionId?: string;
    key?: string;
    kind?: string;
    model?: string;
    modelProvider?: string;
    totalTokens?: number;
    contextTokens?: number;
    updatedAt?: number;
    displayName?: string;
    label?: string;
    channel?: string;
    status?: string;
    endedAt?: string | number | undefined;
    startedAt?: string | number | undefined;
    runId?: string | undefined;
    activeRunId?: string | undefined;
    currentRunId?: string | undefined;
    hasActiveRun?: boolean;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
    thinkingOptions?: string[];
    thinkingDefault?: string;
    fastMode?: boolean | "auto";
    effectiveFastMode?: boolean | "auto";
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    totalTokensFresh?: boolean;
}

/** Represents pending request. */
interface PendingRequest {
    clientWs: DashboardSocket;
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
    client: OpenClawGatewayClientInstance | undefined;
    sessions: Session[];
    isConnected: boolean;
    requestId: number;
    currentToken: string | undefined;
    connectError: string | undefined;
} = {
    client: undefined,
    sessions: [],
    isConnected: false,
    requestId: 1000,
    currentToken: undefined,
    connectError: undefined,
};
const gatewayMetricsState: Omit<GatewayMetrics, "connected" | "pendingRequests"> = {
    connectFailures: 0,
    connections: 0,
    disconnects: 0,
    reconnects: 0,
};
const DEFAULT_GATEWAY_CONNECTION_WAIT_MS = 45_000;
const subscribers = new Set<DashboardSocket>();
const pendingRequests = new Map<string, PendingRequest>();
const chatReplayState: {
    bridge: OpenClawChatBridge;
    generation: string;
    scope: string | undefined;
} = {
    bridge: new OpenClawChatBridge(),
    generation: Bun.randomUUIDv7(),
    scope: undefined,
};
type GatewayClientConstructor = new (
    options: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;
const gatewayRuntime = {
    clientConstructor: OpenClawGatewayClient as GatewayClientConstructor,
    dashboardOpenClawHome: validateOpenClawRoot(
        resolveDashboardRuntimePath(
            resolveDashboardProjectPathsForRuntime()?.productionOpenClawHome,
            process.env.MIRA_DASHBOARD_OPENCLAW_HOME
        ) ?? DEFAULT_DASHBOARD_OPENCLAW_HOME,
        "MIRA_DASHBOARD_OPENCLAW_HOME"
    ),
    openClawHome: validateOpenClawRoot(
        nonEmptyEnvironmentFallback("OPENCLAW_HOME", defaultOpenClawHome()).trim(),
        "OPENCLAW_HOME"
    ),
};

function chatReplayGatewayScope(endpoint: string, token: string): string {
    const credentialFingerprint = new Bun.CryptoHasher("sha256")
        .update(token)
        .digest("hex");
    return new Bun.CryptoHasher("sha256")
        .update("mira-dashboard:openclaw-chat-replay:v1\0")
        .update(endpoint.trim())
        .update("\0")
        .update(credentialFingerprint)
        .digest("hex");
}

function didSelectChatReplayScope(endpoint: string, token: string): boolean {
    const gatewayScope = chatReplayGatewayScope(endpoint, token);
    if (gatewayScope === chatReplayState.scope) {
        chatReplayState.bridge.hydratePersistedSessions();
        return true;
    }
    if (!chatReplayState.bridge.flush()) {
        return false;
    }
    chatReplayState.bridge = new OpenClawChatBridge(
        new SqliteOpenClawChatSnapshotStore(gatewayScope)
    );
    chatReplayState.scope = gatewayScope;
    chatReplayState.generation = Bun.randomUUIDv7();
    chatReplayState.bridge.hydratePersistedSessions();
    return true;
}

export function setGatewayClientConstructorForTests(
    constructor: GatewayClientConstructor
): () => void {
    const previousConstructor = gatewayRuntime.clientConstructor;
    gatewayRuntime.clientConstructor = constructor;
    return () => {
        gatewayRuntime.clientConstructor = previousConstructor;
    };
}

export function setGatewayRootsForTests(roots: {
    dashboardOpenClawHome: string;
    openClawHome: string;
}): () => void {
    const previousDashboardOpenClawHome = gatewayRuntime.dashboardOpenClawHome;
    const previousOpenClawHome = gatewayRuntime.openClawHome;
    gatewayRuntime.dashboardOpenClawHome = validateOpenClawRoot(
        roots.dashboardOpenClawHome,
        "MIRA_DASHBOARD_OPENCLAW_HOME"
    );
    gatewayRuntime.openClawHome = validateOpenClawRoot(
        roots.openClawHome,
        "OPENCLAW_HOME"
    );
    return () => {
        gatewayRuntime.dashboardOpenClawHome = previousDashboardOpenClawHome;
        gatewayRuntime.openClawHome = previousOpenClawHome;
    };
}

function sendPendingRequestError(pending: PendingRequest, error: string): void {
    try {
        if (pending.clientWs.isOpen()) {
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
        logger.warn("gateway.sessions_refresh_after_request_failed", { error });
    }
}

/**
 * Performs transform session.
 * @returns Transform session result.
 */
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
        session.updatedAt == undefined ? undefined : new Date(session.updatedAt);
    const createdAt = createdAtDate ? createdAtDate.toISOString() : undefined;

    return {
        id: session.sessionId || session.key || "unknown",
        ...(session.sessionId && { sessionId: session.sessionId }),
        key: session.key || "",
        type,
        agentType,
        hookName,
        kind: session.kind,
        model: session.model || "Unknown",
        modelProvider: session.modelProvider,
        tokenCount: session.totalTokens || 0,
        maxTokens: session.contextTokens || 0,
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
        hasActiveRun: session.hasActiveRun,
        isRunning: session.isRunning,
        running: session.running,
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: session.thinkingLevels,
        thinkingOptions: session.thinkingOptions,
        thinkingDefault: session.thinkingDefault,
        fastMode: session.fastMode,
        effectiveFastMode: session.effectiveFastMode,
        verboseLevel: session.verboseLevel,
        reasoningLevel: session.reasoningLevel,
        elevatedLevel: session.elevatedLevel,
        totalTokensFresh: session.totalTokensFresh,
    };
}

/**
 * Performs broadcast.
 * @param message Message to process.
 */
function broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const ws of subscribers) {
        try {
            if (ws.isOpen()) {
                ws.send(data);
            }
        } catch {
            // Ignore errors from closed connections
        }
    }
}

/**
 * Performs as record.
 * @param value Value to process.
 * @returns As record result.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Performs image block has omitted data.
 * @returns Image block has omitted data result.
 */
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

/**
 * Normalizes one raw transcript image block.
 *
 * @param value - Raw content block.
 * @returns Canonical image block, or `undefined` when no image data is present.
 */
function normalizeTranscriptImageBlock(value: unknown): ChatImageBlockRecord | undefined {
    const block = asRecord(value);
    if (block?.type !== "image") {
        return undefined;
    }
    const source = asRecord(block.source);
    let data = typeof source?.data === "string" ? source.data : undefined;
    if (typeof block.data === "string" && block.data.trim().length > 0) {
        data = block.data;
    }
    if (!data?.trim()) {
        return undefined;
    }
    let mimeType =
        typeof source?.media_type === "string" ? source.media_type : "image/jpeg";
    if (typeof block.mimeType === "string") {
        mimeType = block.mimeType;
    }
    return { data, mimeType, type: "image" };
}

/**
 * Normalizes message text.
 * @param content Content value.
 * @returns Normalized message text.
 */
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

/**
 * Normalizes timestamp.
 * @param value Value to process.
 * @returns Normalized timestamp.
 */
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

/**
 * Returns transcript path.
 * @param root Root value.
 * @param candidate Candidate value.
 * @returns transcript path.
 */
function isPathInsideRoot(root: string, candidate: string): boolean {
    const relativePath = Path.relative(root, candidate);
    return !relativePath.startsWith("..") && !Path.isAbsolute(relativePath);
}

/**
 * Returns candidate when it stays inside root.
 * @param root Root value.
 * @param candidate Candidate value.
 * @returns candidate when it stays inside root.
 */
function resolvePathInsideRoot(root: string, candidate: string): string | undefined {
    return isPathInsideRoot(root, candidate) ? candidate : undefined;
}

/**
 * Returns transcript path.
 * @param sessionKey Session key value.
 * @param sessionId Session identifier.
 * @returns transcript path.
 */
function getTranscriptPath(sessionKey: string, sessionId?: string): string | undefined {
    const parts = sessionKey.split(":");
    if (parts[0]?.toLowerCase() !== "agent") {
        return undefined;
    }

    if (!sessionId) {
        const session = gatewayState.sessions.find((entry) => entry.key === sessionKey);
        sessionId = session?.id;
    }
    if (!sessionId || sessionId === "unknown") {
        return undefined;
    }

    const agentId = parts[1];
    const safeAgentPathSegment = /^[A-Za-z0-9._-]+$/u;
    const safeSessionPathSegment = /^[A-Za-z0-9:._-]+$/u;
    if (
        !agentId ||
        agentId === "." ||
        agentId === ".." ||
        !safeAgentPathSegment.test(agentId) ||
        !safeSessionPathSegment.test(sessionId)
    ) {
        return undefined;
    }

    const openClawRoot = Path.resolve(gatewayRuntime.openClawHome);
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
            return undefined;
        }
        realAgentsSessionsRoot = fs.realpathSync(
            Path.resolve(realAgentDirectory, "sessions")
        );
        if (!realAgentsSessionsRoot.startsWith(`${realAgentDirectory}${Path.sep}`)) {
            return undefined;
        }
        realTranscriptPath = fs.realpathSync(transcriptPath);
    } catch {
        return undefined;
    }

    if (!realTranscriptPath.startsWith(`${realAgentsSessionsRoot}${Path.sep}`)) {
        return undefined;
    }

    return resolvePathInsideRoot(realOpenClawRoot, realTranscriptPath);
}

/**
 * Returns whether a failed session index subscription should retry.
 * @param attempt Attempt value.
 * @returns Whether a failed session index subscription should retry.
 */
function shouldRetrySessionIndexSubscription(attempt: number): boolean {
    return attempt < 3;
}

/**
 * Performs read raw transcript image messages.
 * @param sessionKey Session key value.
 * @param sessionId Session identifier.
 * @returns Read raw transcript image messages result.
 */
async function readRawTranscriptImageMessages(
    sessionKey: string,
    sessionId?: string
): Promise<RawTranscriptImageMessage[]> {
    const transcriptPath = getTranscriptPath(sessionKey, sessionId);
    if (!transcriptPath) {
        return [];
    }

    let raw: string;
    try {
        raw = await Bun.file(transcriptPath).text();
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

            const content = unknownArray(message.content);
            if (content.length === 0) {
                continue;
            }

            const images = content
                .map((block) => normalizeTranscriptImageBlock(block))
                .filter((block): block is ChatImageBlockRecord => block !== undefined);
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

/**
 * Performs hydrate omitted chat history images.
 * @param payload Request or event payload.
 * @param requestedSessionKey Requested session key value.
 * @returns Hydrate omitted chat history images result.
 */
async function hydrateOmittedChatHistoryImages(
    payload: unknown,
    requestedSessionKey?: string
): Promise<unknown> {
    const history = asRecord(payload) as ChatHistoryPayload | undefined;
    const sessionKey = history?.sessionKey || requestedSessionKey;

    if (!history || !sessionKey || !Array.isArray(history.messages)) {
        return payload;
    }

    const rawImageMessages = await readRawTranscriptImageMessages(
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
            content: unknownArray(record.content).map((block) => {
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

/**
 * Performs refresh sessions.
 * @param expectedClient Expected client value.
 */
async function refreshSessions(
    expectedClient: OpenClawGatewayClientInstance | undefined = gatewayState.client
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
        const defaults = asRecord(payload?.defaults) as GatewaySession | undefined;
        gatewayState.sessions = sessions
            .map((entry) => asRecord(entry))
            .filter(
                (entry): entry is Record<string, unknown> =>
                    entry !== undefined &&
                    (entry.sessionId === undefined ||
                        typeof entry.sessionId === "string") &&
                    (entry.key === undefined || typeof entry.key === "string") &&
                    (entry.updatedAt === undefined ||
                        (typeof entry.updatedAt === "number" &&
                            Number.isFinite(entry.updatedAt)) ||
                        (typeof entry.updatedAt === "string" &&
                            !Number.isNaN(Date.parse(entry.updatedAt)))) &&
                    (stringFallback(entry.sessionId).trim() ||
                        stringFallback(entry.key).trim()) !== ""
            )
            .map((entry) => {
                const session = entry as GatewaySession & {
                    activeRunId?: string | null | undefined;
                    currentRunId?: string | null | undefined;
                    endedAt?: string | number | null | undefined;
                    runId?: string | null | undefined;
                    startedAt?: string | number | null | undefined;
                };
                const updatedAt =
                    typeof entry.updatedAt === "string"
                        ? Date.parse(entry.updatedAt)
                        : entry.updatedAt;
                const shouldApplyDefaults =
                    (!session.model || session.model === defaults?.model) &&
                    (!session.modelProvider ||
                        !defaults?.modelProvider ||
                        session.modelProvider === defaults.modelProvider);
                const matchingDefaults = shouldApplyDefaults ? defaults : undefined;
                const hasSessionThinkingChoices = Boolean(
                    session.thinkingLevels?.length || session.thinkingOptions?.length
                );
                let thinkingLevels = hasSessionThinkingChoices
                    ? undefined
                    : matchingDefaults?.thinkingLevels;
                if (session.thinkingLevels?.length) {
                    thinkingLevels = session.thinkingLevels;
                }
                let thinkingOptions = hasSessionThinkingChoices
                    ? undefined
                    : matchingDefaults?.thinkingOptions;
                if (session.thinkingOptions?.length) {
                    thinkingOptions = session.thinkingOptions;
                }
                return transformSession({
                    ...matchingDefaults,
                    ...session,
                    model: session.model?.trim()
                        ? session.model
                        : matchingDefaults?.model,
                    modelProvider: session.modelProvider?.trim()
                        ? session.modelProvider
                        : matchingDefaults?.modelProvider,
                    contextTokens:
                        session.contextTokens ?? matchingDefaults?.contextTokens,
                    thinkingDefault:
                        session.thinkingDefault ?? matchingDefaults?.thinkingDefault,
                    thinkingLevels,
                    thinkingOptions,
                    fastMode: session.fastMode,
                    effectiveFastMode:
                        session.effectiveFastMode ??
                        matchingDefaults?.effectiveFastMode ??
                        matchingDefaults?.fastMode,
                    activeRunId:
                        session.activeRunId === null ? undefined : session.activeRunId,
                    currentRunId:
                        session.currentRunId === null ? undefined : session.currentRunId,
                    endedAt: session.endedAt === null ? undefined : session.endedAt,
                    runId: session.runId === null ? undefined : session.runId,
                    startedAt: session.startedAt === null ? undefined : session.startedAt,
                    updatedAt:
                        typeof updatedAt === "number" && Number.isFinite(updatedAt)
                            ? updatedAt
                            : undefined,
                });
            });
        chatReplayState.bridge.reconcileSessions(gatewayState.sessions);
        broadcast({ type: "sessions", sessions: gatewayState.sessions });
    }
}

/** Refreshes Gateway sessions and logs failures from event callbacks. */
async function refreshGatewaySessions(
    activeClient: OpenClawGatewayClientInstance
): Promise<void> {
    try {
        await refreshSessions(activeClient);
    } catch (error) {
        logger.error("gateway.sessions_refresh_failed", { error });
    }
}

/**
 * Performs init.
 * @param token Token value.
 */
function init(token: string): void {
    if (gatewayState.currentToken === token && gatewayState.client) {
        return;
    }
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    const previousGatewayClient = gatewayState.client;
    if (previousGatewayClient) {
        chatReplayState.bridge.markGatewayDisconnected();
    }
    if (!didSelectChatReplayScope(gatewayUrl, token)) {
        throw new Error(
            "Gateway credentials were not changed because pending chat replay could not be persisted"
        );
    }
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        logger.error("gateway.previous_client_stop_failed", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== undefined,
        });
    }
    if (gatewayState.client === previousGatewayClient) {
        gatewayState.client = undefined;
    }
    gatewayState.isConnected = false;
    gatewayState.sessions = [];
    gatewayState.connectError = undefined;
    failPendingRequests("Gateway disconnected");
    broadcast({ type: "disconnected", gatewayConnected: false });
    gatewayState.currentToken = token;
    const thisReplayBridge = chatReplayState.bridge;
    /**
     * Returns the active Gateway client when this callback belongs to it.
     * @returns the active Gateway client when this callback belongs to it.
     */
    function getCurrentInitGatewayClient(): OpenClawGatewayClientInstance | undefined {
        return thisGatewayClient && isCurrentGatewayClient(thisGatewayClient)
            ? thisGatewayClient
            : undefined;
    }
    /** Handles successful Gateway hello negotiation and subscribes to live events. */
    function handleGatewayHelloOk(): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        if (gatewayMetricsState.connections > 0) {
            gatewayMetricsState.reconnects += 1;
        }
        gatewayMetricsState.connections += 1;
        gatewayMetricsState.lastConnectedAt = new Date().toISOString();
        gatewayState.isConnected = true;
        logger.info("gateway.connected", {
            connections: gatewayMetricsState.connections,
            reconnects: gatewayMetricsState.reconnects,
        });
        broadcast({ type: "connected", gatewayConnected: true });
        /**
         * Subscribes to Gateway session index events for live session updates.
         * @param attempt Attempt value.
         */
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
                logger.warn("gateway.session_index_subscription_failed", { error });
            }
        }
        void subscribeToSessionIndexEvents();
        void refreshGatewaySessions(activeClient);
    }
    /**
     * Broadcasts one Gateway runtime event and refreshes session metadata when needed.
     * @param event Event to handle.
     */
    function handleGatewayEvent(event: { event?: unknown; payload?: unknown }): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        const envelope = thisReplayBridge.recordEvent(
            event.event,
            event.payload,
            gatewayState.sessions
        );
        broadcast(envelope);
        if (typeof event.event === "string" && event.event.startsWith("sessions.")) {
            void refreshGatewaySessions(activeClient);
        }
    }
    /** Logs Gateway connection failures. */
    function handleGatewayConnectError(error: Error): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        gatewayState.connectError = error.message;
        gatewayMetricsState.connectFailures += 1;
        logger.error("gateway.connect_failed", { error });
    }
    /** Marks Gateway state disconnected and informs dashboard clients. */
    function handleGatewayClose(): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        if (gatewayState.isConnected) {
            gatewayMetricsState.disconnects += 1;
            gatewayMetricsState.lastDisconnectedAt = new Date().toISOString();
            logger.warn("gateway.disconnected", {
                disconnects: gatewayMetricsState.disconnects,
            });
        }
        gatewayState.isConnected = false;
        gatewayState.sessions = [];
        thisReplayBridge.markGatewayDisconnected();
        thisReplayBridge.flush();
        failPendingRequests("Gateway disconnected");
        broadcast({ type: "disconnected", gatewayConnected: false });
    }
    const thisGatewayClient = new gatewayRuntime.clientConstructor({
        url: gatewayUrl,
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
            gatewayState.client = undefined;
            gatewayState.currentToken = undefined;
        }
        throw error;
    }
}

function isGatewayAuthFailureMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("unauthorized") || normalized.includes("token mismatch");
}

function waitForConnection(
    expectedToken: string,
    timeoutMs = DEFAULT_GATEWAY_CONNECTION_WAIT_MS
): Promise<void> {
    if (gatewayState.currentToken === expectedToken && gatewayState.isConnected) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const interval = setInterval(() => {
            if (gatewayState.currentToken !== expectedToken) {
                clearInterval(interval);
                reject(new Error("Gateway token changed before connection completed"));
                return;
            }
            if (gatewayState.isConnected) {
                clearInterval(interval);
                resolve();
                return;
            }
            if (
                gatewayState.connectError &&
                isGatewayAuthFailureMessage(gatewayState.connectError)
            ) {
                clearInterval(interval);
                reject(new Error(gatewayState.connectError));
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(interval);
                reject(
                    new Error(
                        gatewayState.connectError ||
                            "Gateway connection was not established"
                    )
                );
            }
        }, 50);
    });
}

async function initAndWait(token: string): Promise<void> {
    init(token);
    await waitForConnection(token);
}

function captureChatSendRequestBoundary(
    method: string,
    parameters: Record<string, unknown>
): number | undefined {
    if (method !== "chat.send") {
        return undefined;
    }
    return chatReplayState.bridge.captureRequestBoundary(
        typeof parameters.sessionKey === "string" ? parameters.sessionKey : undefined,
        typeof parameters.idempotencyKey === "string"
            ? parameters.idempotencyKey
            : undefined
    );
}

async function requestWithReplayBoundaryInContext(
    client: OpenClawGatewayClientInstance,
    method: string,
    parameters: Record<string, unknown>,
    options?: OpenClawGatewayRequestOptions
): Promise<unknown> {
    let requestBoundary: number | undefined;
    let didCaptureRequestBoundary = false;
    try {
        requestBoundary = captureChatSendRequestBoundary(method, parameters);
        didCaptureRequestBoundary = method === "chat.send";
        const payload = await client.request(method, parameters, options);
        const identityEnvelope = chatReplayState.bridge.handleSuccessfulRequest(
            method,
            parameters,
            payload,
            requestBoundary
        );
        if (identityEnvelope) {
            broadcast(identityEnvelope);
        }
        return payload;
    } catch (error) {
        if (didCaptureRequestBoundary) {
            chatReplayState.bridge.handleFailedRequest(
                method,
                parameters,
                requestBoundary
            );
        }
        throw error;
    }
}

/**
 * Extracts a session identifier suitable for request correlation.
 *
 * @param method - OpenClaw Gateway method name.
 * @param parameters - Gateway request parameters.
 * @returns Session identifier, when the request carries one.
 */
function gatewaySessionIdentifier(
    method: string,
    parameters: Record<string, unknown>
): string | undefined {
    if (typeof parameters.sessionKey === "string") {
        return parameters.sessionKey;
    }
    if (typeof parameters.sessionId === "string") {
        return parameters.sessionId;
    }
    if (typeof parameters.key === "string" && method.startsWith("sessions.")) {
        return parameters.key;
    }
    return undefined;
}

async function requestWithReplayBoundary(
    client: OpenClawGatewayClientInstance,
    method: string,
    parameters: Record<string, unknown>,
    options?: OpenClawGatewayRequestOptions
): Promise<unknown> {
    const sessionIdentifier = gatewaySessionIdentifier(method, parameters);
    return runWithLogContext(
        {
            ...(sessionIdentifier && {
                sessionId: hashedLogCorrelation("openclaw-session", sessionIdentifier),
            }),
        },
        () => requestWithReplayBoundaryInContext(client, method, parameters, options)
    );
}

/**
 * Performs forward request.
 * @param method Method value.
 * @param parameters Parameters value.
 * @param clientWs Client ws value.
 * @param clientId Client identifier.
 * @param timeoutMs Timeout duration in milliseconds.
 * @returns Forward request result.
 */
async function forwardRequest(
    method: string,
    parameters: Record<string, unknown>,
    clientWs?: DashboardSocket,
    clientId?: string,
    timeoutMs?: number
): Promise<boolean> {
    if (!gatewayState.client || !gatewayState.isConnected) {
        return false;
    }
    const activeGateway = gatewayState.client;
    const requestOptions = {
        timeoutMs,
        shouldWaitIndefinitely: method === "sessions.compact",
    };

    if (clientWs && clientId) {
        const id = String(++gatewayState.requestId);
        pendingRequests.set(id, { clientWs, clientId, method });

        try {
            let payload = await requestWithReplayBoundary(
                activeGateway,
                method,
                parameters,
                requestOptions
            );
            if (method === "chat.history") {
                payload = await hydrateOmittedChatHistoryImages(
                    payload,
                    typeof parameters.sessionKey === "string"
                        ? parameters.sessionKey
                        : undefined
                );
            }
            const pending = pendingRequests.get(id);
            pendingRequests.delete(id);
            try {
                if (pending?.clientWs.isOpen()) {
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
                sendPendingRequestError(
                    pending,
                    errorMessage(error, "Gateway request failed")
                );
            }
        }
        return true;
    }

    try {
        await requestWithReplayBoundary(
            activeGateway,
            method,
            parameters,
            requestOptions
        );
        if (method.startsWith("sessions.")) {
            await refreshSessionsAfterRequest(activeGateway);
        }
        return true;
    } catch {
        return false;
    }
}

/** Processes Gateway WebSocket client events. */
function handleDashboardClient(ws: DashboardSocket): void {
    const cleanupClient = () => {
        subscribers.delete(ws);
        unsubscribeFromDashboardLogs(ws);
        logsUnsubscribe(ws);
        for (const [id, pending] of pendingRequests) {
            if (pending.clientWs === ws) {
                pendingRequests.delete(id);
            }
        }
    };

    ws.onError((error) => {
        logger.error("gateway.client_socket_failed", { error });
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
        logger.error("gateway.initial_client_state_send_failed", { error });
        cleanupClient();
        ws.close();
        return;
    }

    ws.onMessage((data) => {
        void (async () => {
            try {
                const message = parseDashboardSocketRequest(JSON.parse(data.toString()));
                if (message.type === "subscribe" && message.channel === "logs") {
                    logsSubscribe(ws);
                    return;
                }
                if (message.type === "unsubscribe" && message.channel === "logs") {
                    logsUnsubscribe(ws);
                    return;
                }
                if (
                    message.type === "subscribe" &&
                    message.channel === "dashboard-logs"
                ) {
                    subscribeToDashboardLogs(ws);
                    return;
                }
                if (
                    message.type === "unsubscribe" &&
                    message.channel === "dashboard-logs"
                ) {
                    unsubscribeFromDashboardLogs(ws);
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
                    message.method === "subscribe" &&
                    message.params?.channel === "dashboard-logs"
                ) {
                    subscribeToDashboardLogs(ws);
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
                    message.params?.channel === "dashboard-logs"
                ) {
                    unsubscribeFromDashboardLogs(ws);
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
                    if (message.method === "chat.runtimeSnapshot") {
                        if (message.id && ws.isOpen()) {
                            const sessionKey =
                                typeof message.params?.sessionKey === "string"
                                    ? message.params.sessionKey
                                    : "";
                            ws.send(
                                JSON.stringify({
                                    type: "response",
                                    id: message.id,
                                    isOk: true,
                                    payload: {
                                        ...chatReplayState.bridge.snapshot(sessionKey),
                                        replayScope: chatReplayState.scope,
                                        runtimeGeneration: chatReplayState.generation,
                                    },
                                })
                            );
                        }
                        return;
                    }
                    const isOk = await forwardRequest(
                        message.method,
                        message.params || {},
                        ws,
                        message.id,
                        message.timeoutMs
                    );
                    if (!isOk && message.id && ws.isOpen()) {
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
                logger.error("gateway.client_message_failed", { error });
            }
        })();
    });

    ws.onClose(() => {
        cleanupClient();
    });
}

/**
 * Returns status.
 * @returns status.
 */
function getStatus(): DashboardSettingsResponse["gateway"] {
    return {
        gateway: gatewayState.isConnected ? "connected" : "disconnected",
        sessions: gatewayState.sessions.length,
    };
}

/**
 * Returns sessions.
 * @returns sessions.
 */
function getSessions(): Session[] {
    return gatewayState.sessions;
}

/**
 * Returns whether connected.
 * @returns Whether connected.
 */
function isConnected(): boolean {
    return gatewayState.isConnected;
}

/**
 * Returns connection counters and pending volume without request payloads.
 * @returns connection counters and pending volume without request payloads.
 */
function getMetrics(): GatewayMetrics {
    return {
        ...gatewayMetricsState,
        connected: gatewayState.isConnected,
        pendingRequests:
            gatewayState.client?.pendingRequestCount?.() ?? pendingRequests.size,
    };
}

/** Returns gateway ws. */
function getGatewayWs(): undefined {
    return;
}

/**
 * Performs send request async.
 * @param method Method value.
 * @param parameters Parameters value.
 * @param options Operation options.
 * @returns Send request async result.
 */
async function sendRequestAsync(
    method: string,
    parameters: Record<string, unknown>,
    options?: OpenClawGatewayRequestOptions
): Promise<unknown> {
    if (!gatewayState.client || !gatewayState.isConnected) {
        throw new Error("Gateway not connected");
    }

    return requestWithReplayBoundary(gatewayState.client, method, parameters, options);
}

/**
 * Performs send session message.
 * @param sessionKey Session key value.
 * @param message Message to process.
 */
async function sendSessionMessage(sessionKey: string, message: string): Promise<void> {
    await sendRequestAsync(
        "chat.send",
        {
            sessionKey,
            message,
            idempotencyKey: `tasks-notify-${Bun.randomUUIDv7()}`,
        },
        // Limit only the Gateway acknowledgement wait; chat.send timeoutMs caps the run.
        { timeoutMs: 10_000 }
    );
}

/**
 * Performs abort session run.
 * @param sessionKey Session key value.
 */
async function abortSessionRun(sessionKey: string): Promise<void> {
    await sendRequestAsync("chat.abort", {
        sessionKey,
    });
}

/**
 * Performs delete session.
 * @param sessionKey Session key value.
 * @returns Delete session result.
 */
async function deleteSession(sessionKey: string): Promise<unknown> {
    const result = await sendRequestAsync("sessions.delete", {
        key: sessionKey,
        deleteTranscript: true,
    });

    try {
        await refreshSessions();
    } catch (error) {
        logger.warn("gateway.sessions_refresh_after_delete_failed", { error });
    }

    return result;
}

/**
 * Performs request.
 * @param method Method value.
 * @param parameters Parameters value.
 * @returns Request result.
 */
async function request(
    method: string,
    parameters: Record<string, unknown>
): Promise<unknown> {
    return sendRequestAsync(method, parameters);
}

/** Stops the active Gateway client and clears connected state. */
function shutdown(): void {
    const previousGatewayClient = gatewayState.client;
    const wasConnected = gatewayState.isConnected;
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        logger.error("gateway.previous_client_shutdown_failed", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== undefined,
        });
    }
    if (wasConnected && gatewayState.isConnected) {
        gatewayMetricsState.disconnects += 1;
        gatewayMetricsState.lastDisconnectedAt = new Date().toISOString();
    }
    if (gatewayState.client === previousGatewayClient) {
        gatewayState.client = undefined;
    }
    gatewayState.isConnected = false;
    gatewayState.sessions = [];
    gatewayState.currentToken = undefined;
    chatReplayState.bridge.clearMemory();
    failPendingRequests("Gateway disconnected");
    broadcast({ type: "disconnected", gatewayConnected: false });
}

/** Defines testing. */

export default {
    init,
    initAndWait,
    handleDashboardClient,
    getStatus,
    getSessions,
    isConnected,
    getMetrics,
    getGatewayWs,
    sendSessionMessage,
    abortSessionRun,
    deleteSession,
    request,
    shutdown,
};
