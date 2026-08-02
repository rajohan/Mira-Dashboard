import os from "node:os";
import Path from "node:path";

import type { ChatRuntimeMetrics, GatewayMetrics } from "../../contracts/metrics.ts";
import type { Session } from "../../contracts/sessions.ts";
import type { DashboardSettingsResponse } from "../../contracts/settings.ts";
import { OpenClawChatBridge } from "./services/chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "./services/chat/openClawChatSnapshotStore.ts";
import type { DashboardSocket } from "./dashboardSocket.ts";
import {
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "./lib/dashboardPaths.ts";
import {
    type DeviceIdentity,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
    type OpenClawGatewayRequestOptions,
} from "./lib/openclawGatewayClient.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";
import { nonEmptyEnvironmentFallback } from "./lib/values.ts";
import { GatewayDashboardClientHub } from "./services/gateway/dashboardClientHub.ts";
import { GatewayRequestForwarder } from "./services/gateway/requestForwarder.ts";
import { normalizeGatewaySessionList } from "./services/gateway/sessionProjection.ts";
import { OpenClawTranscriptImageHydrator } from "./services/gateway/transcriptImageHydrator.ts";

export { normalizeGatewaySessionList } from "./services/gateway/sessionProjection.ts";

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

const gatewayState: {
    client: OpenClawGatewayClientInstance | undefined;
    sessions: Session[];
    isConnected: boolean;
    currentToken: string | undefined;
    connectError: string | undefined;
} = {
    client: undefined,
    sessions: [],
    isConnected: false,
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
function createChatReplayBridge(
    store?: SqliteOpenClawChatSnapshotStore,
    gatewayConnected = gatewayState.isConnected
) {
    const bridge = new OpenClawChatBridge(store, {
        gatewayConnected,
        onDeferredEnvelope: (envelope) => {
            if (chatReplayState.bridge === bridge) {
                broadcast(envelope);
            }
        },
    });
    return bridge;
}
const chatReplayState: {
    bridge: OpenClawChatBridge;
    generation: string;
    scope: string | undefined;
} = {
    bridge: createChatReplayBridge(),
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
const transcriptImageHydrator = new OpenClawTranscriptImageHydrator({
    resolveOpenClawHome: () => gatewayRuntime.openClawHome,
    resolveSessionId: (sessionKey) =>
        gatewayState.sessions.find((entry) => entry.key === sessionKey)?.id,
});
const requestForwarder = new GatewayRequestForwarder({
    broadcast,
    publishSessions: publishGatewaySessions,
    readActiveClient: () =>
        gatewayState.isConnected ? gatewayState.client : undefined,
    readChatBridge: () => chatReplayState.bridge,
    refreshSessionsAfterRequest,
    transcriptImageHydrator,
});
const dashboardClientHub = new GatewayDashboardClientHub({
    forwardRequest: (method, parameters, clientWs, clientId, timeoutMs) =>
        requestForwarder.forward(method, parameters, clientWs, clientId, timeoutMs),
    readRuntimeSnapshot: (sessionKey) => ({
        ...chatReplayState.bridge.snapshot(sessionKey),
        replayScope: chatReplayState.scope,
        runtimeGeneration: chatReplayState.generation,
    }),
    readState: () => ({
        gatewayConnected: gatewayState.isConnected,
        sessions: gatewayState.sessions,
    }),
    removePendingRequests: (client) => requestForwarder.removePendingRequests(client),
});

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
    if (!chatReplayState.bridge.clearMemory()) {
        return false;
    }
    const bridge = createChatReplayBridge(
        new SqliteOpenClawChatSnapshotStore(gatewayScope),
        false
    );
    chatReplayState.bridge = bridge;
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
 * Performs broadcast.
 * @param message Message to process.
 */
function broadcast(message: unknown): void {
    dashboardClientHub.broadcast(message);
}

/**
 * Returns whether a failed session index subscription should retry.
 * @param attempt Attempt value.
 * @returns Whether a failed session index subscription should retry.
 */
function shouldRetrySessionIndexSubscription(attempt: number): boolean {
    return attempt < 3;
}

function isCurrentGatewayClient(expectedClient: OpenClawGatewayClientInstance): boolean {
    return gatewayState.client === expectedClient;
}

/**
 * Installs and broadcasts a normalized session list for the active Gateway.
 * @param expectedClient Gateway client that produced the list.
 * @param sessions Normalized Dashboard sessions.
 */
function publishGatewaySessions(
    expectedClient: OpenClawGatewayClientInstance,
    sessions: Session[]
): void {
    if (!gatewayState.isConnected || !isCurrentGatewayClient(expectedClient)) {
        return;
    }
    gatewayState.sessions = sessions;
    chatReplayState.bridge.reconcileSessions(gatewayState.sessions);
    broadcast({ type: "sessions", sessions: gatewayState.sessions });
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
    publishGatewaySessions(expectedClient, normalizeGatewaySessionList(response));
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
    requestForwarder.failPendingRequests("Gateway disconnected");
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
        thisReplayBridge.markGatewayConnected();
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
        requestForwarder.failPendingRequests("Gateway disconnected");
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

/** Processes Gateway WebSocket client events. */
function handleDashboardClient(ws: DashboardSocket): void {
    dashboardClientHub.handle(ws);
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
            gatewayState.client?.pendingRequestCount?.() ??
            requestForwarder.pendingRequestCount,
    };
}

/**
 * Returns content-free chat replay, persistence, and shadow parity metrics.
 * @returns Current chat runtime metrics.
 */
function getChatMetrics(): ChatRuntimeMetrics {
    return chatReplayState.bridge.getMetrics();
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

    return requestForwarder.request(gatewayState.client, method, parameters, options);
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
    if (wasConnected) {
        chatReplayState.bridge.markGatewayDisconnected();
    }
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
    requestForwarder.failPendingRequests("Gateway disconnected");
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
    getChatMetrics,
    getGatewayWs,
    sendSessionMessage,
    abortSessionRun,
    deleteSession,
    request,
    shutdown,
};
