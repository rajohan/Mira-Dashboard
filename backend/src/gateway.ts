import fs from "node:fs";
import os from "node:os";
import Path from "node:path";

import type { DashboardSocket } from "./dashboardSocket.ts";
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

/** Performs load or create dashboard device IDentity. */
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
} from "./services/logStreams.ts";

/** Represents session. */
interface Session {
    id: string;
    key: string;
    type: string;
    agentType: string;
    hookName: string;
    kind?: string;
    model: string;
    modelProvider?: string;
    tokenCount: number;
    maxTokens: number;
    createdAt: string | undefined;
    updatedAt?: number;
    displayName: string;
    label: string;
    displayLabel: string;
    channel: string;
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
const DEFAULT_GATEWAY_CONNECTION_WAIT_MS = 45_000;
const subscribers = new Set<DashboardSocket>();
const pendingRequests = new Map<string, PendingRequest>();
interface RuntimeEventEnvelope {
    type: "event";
    event: unknown;
    payload: unknown;
    runtimeSequence: number;
}

interface RuntimeRunSnapshot {
    completed: boolean;
    eventBytes: number[];
    events: RuntimeEventEnvelope[];
    runId: string;
    totalBytes: number;
    updatedAt: number;
}

const RUNTIME_SNAPSHOT_TTL_MS = 15 * 60_000;
const ACTIVE_RUNTIME_SNAPSHOT_TTL_MS = 6 * 60 * 60_000;
const RUNTIME_SNAPSHOT_MAX_EVENTS_PER_RUN = 500;
const RUNTIME_SNAPSHOT_MAX_BYTES_PER_RUN = 1_000_000;
const RUNTIME_SNAPSHOT_MAX_RUNS_PER_SESSION = 4;
const RUNTIME_SNAPSHOT_MAX_SESSIONS = 50;
const RUNTIME_SNAPSHOT_EVENTS = new Set([
    "agent",
    "chat",
    "model.completed",
    "session.ended",
    "session.message",
    "session.tool",
]);
const runtimeSnapshots = new Map<string, Map<string, RuntimeRunSnapshot>>();
const runtimeSessionKeysByRun = new Map<string, string | undefined>();
const runtimeJournal = { sequence: 0 };

/** Clears all ephemeral runtime replay state. */
function clearRuntimeSnapshots(): void {
    runtimeSnapshots.clear();
    runtimeSessionKeysByRun.clear();
    runtimeJournal.sequence = 0;
}
type GatewayClientConstructor = new (
    options: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;
const gatewayRuntime = {
    clientConstructor: OpenClawGatewayClient as GatewayClientConstructor,
    dashboardOpenClawHome: validateOpenClawRoot(
        nonEmptyEnvironmentFallback(
            "MIRA_DASHBOARD_OPENCLAW_HOME",
            DEFAULT_DASHBOARD_OPENCLAW_HOME
        ).trim(),
        "MIRA_DASHBOARD_OPENCLAW_HOME"
    ),
    openClawHome: validateOpenClawRoot(
        nonEmptyEnvironmentFallback("OPENCLAW_HOME", defaultOpenClawHome()).trim(),
        "OPENCLAW_HOME"
    ),
};

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
        session.updatedAt == undefined ? undefined : new Date(session.updatedAt);
    const createdAt = createdAtDate ? createdAtDate.toISOString() : undefined;

    return {
        id: session.sessionId || session.key || "unknown",
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

/** Performs broadcast. */
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

/** Performs as record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
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
    if (
        event !== "agent" &&
        event !== "chat" &&
        event !== "model.completed" &&
        event !== "session.ended" &&
        event !== "session.tool" &&
        event !== "session.message"
    ) {
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

    const hasRememberedRun = runtimeSessionKeysByRun.has(runId);
    const rememberedSessionKey = runtimeSessionKeysByRun.get(runId);
    const matchingSessionKey =
        hasRememberedRun && !rememberedSessionKey
            ? undefined
            : rememberedSessionKey ||
              gatewayState.sessions.find((session) =>
                  hasSessionRunIdentifier(session, runId)
              )?.key;

    return matchingSessionKey ? { ...record, sessionKey: matchingSessionKey } : payload;
}

/** Remembers a bounded run-to-session association for early runtime enrichment. */
function rememberRuntimeSessionKey(runId: string, sessionKey: string): void {
    const previousSessionKey = runtimeSessionKeysByRun.get(runId);
    const isAmbiguous =
        runtimeSessionKeysByRun.has(runId) && previousSessionKey !== sessionKey;
    runtimeSessionKeysByRun.delete(runId);
    runtimeSessionKeysByRun.set(runId, isAmbiguous ? undefined : sessionKey);
    if (runtimeSessionKeysByRun.size > 200) {
        const oldestRunId = runtimeSessionKeysByRun.keys().next().value;
        if (oldestRunId) {
            runtimeSessionKeysByRun.delete(oldestRunId);
        }
    }
}

/** Clears replay data and run associations for one reset session. */
function clearRuntimeSnapshotsForSession(sessionKey: string): void {
    runtimeSnapshots.delete(sessionKey);
    for (const [runId, mappedSessionKey] of runtimeSessionKeysByRun) {
        if (mappedSessionKey === sessionKey) {
            runtimeSessionKeysByRun.delete(runId);
        }
    }
}

/** Updates ephemeral replay state after a successful Gateway request. */
function handleSuccessfulGatewayRequest(
    method: string,
    parameters: Record<string, unknown>,
    payload: unknown
): void {
    if (method === "chat.abort") {
        const sessionKey = stringField(parameters, "sessionKey");
        if (sessionKey) {
            clearRuntimeSnapshotsForSession(sessionKey);
        }
        return;
    }
    if (method === "sessions.delete") {
        const sessionKey = stringField(parameters, "key");
        if (sessionKey) {
            clearRuntimeSnapshotsForSession(sessionKey);
        }
        return;
    }
    if (method !== "chat.send") {
        return;
    }
    const sessionKey = stringField(parameters, "sessionKey");
    const message = stringField(parameters, "message");
    if (sessionKey && message && /^\/(?:new|reset)(?:\s|$)/i.test(message)) {
        clearRuntimeSnapshotsForSession(sessionKey);
        return;
    }
    const response = asRecord(payload);
    const runId = response ? stringField(response, "runId") : undefined;
    if (runId && sessionKey) {
        rememberRuntimeSessionKey(runId, sessionKey);
    }
}

/** Returns whether an event completes a whole chat run. */
function isTerminalRuntimeRunEvent(event: unknown, payload: unknown): boolean {
    if (event === "model.completed" || event === "session.ended") {
        return true;
    }
    const record = asRecord(payload);
    return (
        event === "chat" &&
        typeof record?.state === "string" &&
        ["aborted", "error", "final"].includes(record.state)
    );
}

/** Removes expired runtime replay data. */
function pruneRuntimeSnapshots(now = Date.now()): void {
    for (const [sessionKey, runs] of runtimeSnapshots) {
        for (const [runId, snapshot] of runs) {
            const timeToLive = snapshot.completed
                ? RUNTIME_SNAPSHOT_TTL_MS
                : ACTIVE_RUNTIME_SNAPSHOT_TTL_MS;
            if (now - snapshot.updatedAt > timeToLive) {
                runs.delete(runId);
            }
        }
        if (runs.size === 0) {
            runtimeSnapshots.delete(sessionKey);
        }
    }
}

/** Returns whether a run key is provisional and safe to reconcile to one concrete run. */
function isProvisionalRuntimeRunId(runId: string): boolean {
    return (
        runId === "runless" ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-")
    );
}

/** Retains a bounded replay buffer for active or just-completed chat runtime work. */
function rememberRuntimeEvent(envelope: RuntimeEventEnvelope): void {
    if (
        typeof envelope.event !== "string" ||
        !RUNTIME_SNAPSHOT_EVENTS.has(envelope.event)
    ) {
        return;
    }
    const payload = asRecord(envelope.payload);
    const sessionKey = payload ? stringField(payload, "sessionKey") : undefined;
    if (!sessionKey) {
        return;
    }
    const isTerminal = isTerminalRuntimeRunEvent(envelope.event, envelope.payload);
    const explicitRunId = payload ? stringField(payload, "runId") : undefined;
    const serializedEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
    const retainedEnvelope =
        serializedEnvelopeBytes <= RUNTIME_SNAPSHOT_MAX_BYTES_PER_RUN
            ? envelope
            : isTerminal
              ? {
                    ...envelope,
                    payload: {
                        runId: explicitRunId,
                        sessionKey,
                        state: payload?.state,
                    },
                }
              : undefined;
    if (!retainedEnvelope) {
        return;
    }
    const retainedEnvelopeBytes =
        retainedEnvelope === envelope
            ? serializedEnvelopeBytes
            : Buffer.byteLength(JSON.stringify(retainedEnvelope));

    pruneRuntimeSnapshots();
    const runs = runtimeSnapshots.get(sessionKey) || new Map();
    const activeRuns = runs
        .values()
        .filter((snapshot) => !snapshot.completed)
        .toArray();
    const runId =
        explicitRunId ||
        (activeRuns.length === 1 ? activeRuns[0]?.runId : undefined) ||
        "runless";
    let snapshot = runs.get(runId);

    if (!snapshot && explicitRunId) {
        const provisionalCandidates = activeRuns.filter((entry) =>
            isProvisionalRuntimeRunId(entry.runId)
        );
        const provisionalSnapshot =
            activeRuns.length === 1 && provisionalCandidates.length === 1
                ? provisionalCandidates[0]
                : undefined;
        if (provisionalSnapshot) {
            runs.delete(provisionalSnapshot.runId);
            provisionalSnapshot.runId = explicitRunId;
            runs.set(explicitRunId, provisionalSnapshot);
            snapshot = provisionalSnapshot;
        }
    }

    if (!snapshot) {
        snapshot = {
            completed: false,
            eventBytes: [],
            events: [],
            runId,
            totalBytes: 2,
            updatedAt: Date.now(),
        };
        runs.set(runId, snapshot);
    }

    snapshot.events.push(retainedEnvelope);
    snapshot.eventBytes.push(retainedEnvelopeBytes);
    snapshot.totalBytes += retainedEnvelopeBytes + (snapshot.events.length > 1 ? 1 : 0);
    while (
        snapshot.events.length > 1 &&
        (snapshot.events.length > RUNTIME_SNAPSHOT_MAX_EVENTS_PER_RUN ||
            snapshot.totalBytes > RUNTIME_SNAPSHOT_MAX_BYTES_PER_RUN)
    ) {
        snapshot.events.shift();
        snapshot.totalBytes -=
            (snapshot.eventBytes.shift() || 0) + (snapshot.events.length > 0 ? 1 : 0);
    }
    snapshot.completed ||= isTerminal;
    snapshot.updatedAt = Date.now();
    while (runs.size > RUNTIME_SNAPSHOT_MAX_RUNS_PER_SESSION) {
        const oldestRunId = runs
            .values()
            .toArray()
            .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
        if (!oldestRunId) {
            break;
        }
        runs.delete(oldestRunId);
    }
    runtimeSnapshots.set(sessionKey, runs);
    if (runtimeSnapshots.size > RUNTIME_SNAPSHOT_MAX_SESSIONS) {
        const oldestSessionKey = runtimeSnapshots
            .keys()
            .map((key) => ({
                key,
                updatedAt: Math.max(
                    ...runtimeSnapshots
                        .get(key)!
                        .values()
                        .map((entry) => entry.updatedAt)
                ),
            }))
            .toArray()
            .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.key;
        if (oldestSessionKey) {
            runtimeSnapshots.delete(oldestSessionKey);
        }
    }
}

/** Returns whether a runtime snapshot carries a final assistant chat event. */
function hasRuntimeSnapshotChatFinal(snapshot: RuntimeRunSnapshot): boolean {
    return snapshot.events.some((envelope) => {
        const payload = asRecord(envelope.payload);
        return envelope.event === "chat" && payload?.state === "final";
    });
}

/** Returns active runtime events, or the most recently completed run during grace. */
function runtimeSnapshotForSession(sessionKey: string): {
    completed: boolean;
    events: RuntimeEventEnvelope[];
} {
    pruneRuntimeSnapshots();
    const snapshots = [...(runtimeSnapshots.get(sessionKey)?.values() || [])];
    const active = snapshots.filter((snapshot) => !snapshot.completed);
    const completed = snapshots
        .filter((snapshot) => snapshot.completed)
        .toSorted((left, right) => right.updatedAt - left.updatedAt);
    const latestCompleted = completed[0];
    const completedWithoutRunlessTerminal =
        latestCompleted?.runId === "runless" &&
        !hasRuntimeSnapshotChatFinal(latestCompleted)
            ? completed.find((snapshot) => snapshot.runId !== "runless") ||
              latestCompleted
            : latestCompleted;
    const selected =
        active.length > 0
            ? active
            : completedWithoutRunlessTerminal
              ? [completedWithoutRunlessTerminal]
              : [];
    return {
        completed: active.length === 0 && selected.length > 0,
        events: selected
            .flatMap((snapshot) => snapshot.events)
            .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence),
    };
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
function resolvePathInsideRoot(root: string, candidate: string): string | undefined {
    return isPathInsideRoot(root, candidate) ? candidate : undefined;
}

/** Returns transcript path. */
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
    const history = asRecord(payload) as ChatHistoryPayload | undefined;
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
                    thinkingLevels: session.thinkingLevels?.length
                        ? session.thinkingLevels
                        : hasSessionThinkingChoices
                          ? undefined
                          : matchingDefaults?.thinkingLevels,
                    thinkingOptions: session.thinkingOptions?.length
                        ? session.thinkingOptions
                        : hasSessionThinkingChoices
                          ? undefined
                          : matchingDefaults?.thinkingOptions,
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
        console.error(
            "[Gateway] Failed to refresh sessions:",
            errorMessage(error, String(error))
        );
    }
}

/** Performs init. */
function init(token: string): void {
    if (gatewayState.currentToken === token && gatewayState.client) {
        return;
    }
    const previousGatewayClient = gatewayState.client;
    if (gatewayState.currentToken && gatewayState.currentToken !== token) {
        clearRuntimeSnapshots();
    }
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        console.error("[Gateway] Failed to stop wasPrevious client before init:", {
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
    /** Returns the active Gateway client when this callback belongs to it. */
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
        const envelope: RuntimeEventEnvelope = {
            type: "event",
            event: event.event,
            payload: enrichRuntimeEventPayload(event.event, event.payload),
            runtimeSequence: ++runtimeJournal.sequence,
        };
        rememberRuntimeEvent(envelope);
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
    const thisGatewayClient = new gatewayRuntime.clientConstructor({
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

/** Performs forward request. */
async function forwardRequest(
    method: string,
    parameters: Record<string, unknown>,
    clientWs?: DashboardSocket,
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
            handleSuccessfulGatewayRequest(method, parameters, payload);
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
function handleDashboardClient(ws: DashboardSocket): void {
    const cleanupClient = () => {
        subscribers.delete(ws);
        logsUnsubscribe(ws);
        for (const [id, pending] of pendingRequests) {
            if (pending.clientWs === ws) {
                pendingRequests.delete(id);
            }
        }
    };

    ws.onError((error) => {
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

    ws.onMessage((data) => {
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
                                        ...(sessionKey
                                            ? runtimeSnapshotForSession(sessionKey)
                                            : { completed: false, events: [] }),
                                        throughSequence: runtimeJournal.sequence,
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
                        message.id
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
                console.error(
                    "[Gateway] Client message error:",
                    errorMessage(error, String(error))
                );
            }
        })();
    });

    ws.onClose(() => {
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
function getGatewayWs(): undefined {
    return;
}

/** Performs send request async. */
async function sendRequestAsync(
    method: string,
    parameters: Record<string, unknown>
): Promise<unknown> {
    if (!gatewayState.client || !gatewayState.isConnected) {
        throw new Error("Gateway not connected");
    }

    const payload = await gatewayState.client.request(method, parameters);
    handleSuccessfulGatewayRequest(method, parameters, payload);
    return payload;
}

/** Performs send session message. */
async function sendSessionMessage(sessionKey: string, message: string): Promise<void> {
    await sendRequestAsync("chat.send", {
        sessionKey,
        message,
        idempotencyKey: `tasks-notify-${Bun.randomUUIDv7()}`,
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
            hadPreviousGatewayClient: previousGatewayClient !== undefined,
        });
    }
    if (gatewayState.client === previousGatewayClient) {
        gatewayState.client = undefined;
    }
    gatewayState.isConnected = false;
    gatewayState.sessions = [];
    gatewayState.currentToken = undefined;
    clearRuntimeSnapshots();
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
    getGatewayWs,
    sendSessionMessage,
    abortSessionRun,
    deleteSession,
    request,
    shutdown,
};

export type { GatewaySession, Session };
