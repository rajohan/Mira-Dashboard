import type {
    ChatRuntimeMetrics,
    GatewayMetrics,
} from "../../../../contracts/metrics.ts";
import type { Session } from "../../../../contracts/sessions.ts";
import type { DashboardSettingsResponse } from "../../../../contracts/settings.ts";
import type { OpenClawGatewayRequestOptions } from "../../lib/openclawGatewayClient/client.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { GatewayChatReplayRuntime } from "./chatReplayRuntime.ts";
import {
    initializeAndWaitForGatewayConnection,
    initializeGatewayConnection,
    shutdownGatewayConnection,
    type GatewayConnectionLifecycleContext,
} from "./connectionLifecycle.ts";
import { GatewayDashboardClientHub } from "./dashboardClientHub.ts";
import type { DashboardSocket } from "./dashboardSocket.ts";
import { GatewayRequestForwarder } from "./requestForwarder.ts";
import {
    type GatewayClientConstructor,
    GatewayRuntimeConfiguration,
} from "./runtimeConfiguration.ts";
import {
    createGatewayConnectionMetricsState,
    createGatewayConnectionState,
} from "./runtimeState.ts";
import {
    publishGatewaySessions,
    refreshSessions,
    refreshSessionsAfterRequest,
    type GatewaySessionRuntimeContext,
} from "./sessionRuntime.ts";
import { OpenClawTranscriptImageHydrator } from "./transcriptImageHydrator.ts";

const logger = createStructuredLogger("gateway");
const gatewayState = createGatewayConnectionState();
const gatewayMetricsState = createGatewayConnectionMetricsState();
const gatewayConfiguration = new GatewayRuntimeConfiguration();

function broadcast(message: unknown): void {
    dashboardClientHub.broadcast(message);
}

const chatReplayRuntime = new GatewayChatReplayRuntime({
    broadcast,
    readGatewayConnected: () => gatewayState.isConnected,
});

const sessionRuntimeContext: GatewaySessionRuntimeContext = {
    broadcast,
    chatReplay: chatReplayRuntime,
    logger,
    state: gatewayState,
};

const transcriptImageHydrator = new OpenClawTranscriptImageHydrator({
    resolveOpenClawHome: () => gatewayConfiguration.openClawHome,
    resolveSessionId: (sessionKey) =>
        gatewayState.sessions.find((entry) => entry.key === sessionKey)?.id,
});

const requestForwarder = new GatewayRequestForwarder({
    broadcast,
    publishSessions: (client, sessions) =>
        publishGatewaySessions(sessionRuntimeContext, client, sessions),
    readActiveClient: () => (gatewayState.isConnected ? gatewayState.client : undefined),
    readChatBridge: () => chatReplayRuntime.bridge,
    refreshSessionsAfterRequest: (client) =>
        refreshSessionsAfterRequest(sessionRuntimeContext, client),
    transcriptImageHydrator,
});

const dashboardClientHub = new GatewayDashboardClientHub({
    forwardRequest: (method, parameters, clientWs, clientId, timeoutMs) =>
        requestForwarder.forward(method, parameters, clientWs, clientId, timeoutMs),
    readRuntimeSnapshot: (sessionKey) => chatReplayRuntime.snapshot(sessionKey),
    readState: () => ({
        gatewayConnected: gatewayState.isConnected,
        sessions: gatewayState.sessions,
    }),
    removePendingRequests: (client) => requestForwarder.removePendingRequests(client),
});

const connectionLifecycleContext: GatewayConnectionLifecycleContext = {
    broadcast,
    chatReplay: chatReplayRuntime,
    configuration: gatewayConfiguration,
    logger,
    metrics: gatewayMetricsState,
    requestForwarder,
    sessions: sessionRuntimeContext,
    state: gatewayState,
};

export function setGatewayClientConstructorForTests(
    constructor: GatewayClientConstructor
): () => void {
    return gatewayConfiguration.setClientConstructorForTests(constructor);
}

export function setGatewayRootsForTests(roots: {
    dashboardOpenClawHome: string;
    openClawHome: string;
}): () => void {
    return gatewayConfiguration.setRootsForTests(roots);
}

function init(token: string): void {
    initializeGatewayConnection(connectionLifecycleContext, token);
}

async function initAndWait(token: string): Promise<void> {
    await initializeAndWaitForGatewayConnection(connectionLifecycleContext, token);
}

/** Processes Gateway WebSocket client events. */
function handleDashboardClient(ws: DashboardSocket): void {
    dashboardClientHub.handle(ws);
}

function getStatus(): DashboardSettingsResponse["gateway"] {
    return {
        gateway: gatewayState.isConnected ? "connected" : "disconnected",
        sessions: gatewayState.sessions.length,
    };
}

function getSessions(): Session[] {
    return gatewayState.sessions;
}

function isConnected(): boolean {
    return gatewayState.isConnected;
}

function getMetrics(): GatewayMetrics {
    return {
        ...gatewayMetricsState,
        connected: gatewayState.isConnected,
        pendingRequests:
            gatewayState.client?.pendingRequestCount?.() ??
            requestForwarder.pendingRequestCount,
    };
}

function getChatMetrics(): ChatRuntimeMetrics {
    return chatReplayRuntime.metrics();
}

function getGatewayWs(): undefined {
    return;
}

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

async function sendSessionMessage(sessionKey: string, message: string): Promise<void> {
    await sendRequestAsync(
        "chat.send",
        {
            sessionKey,
            message,
            idempotencyKey: `tasks-notify-${Bun.randomUUIDv7()}`,
        },
        { timeoutMs: 10_000 }
    );
}

async function abortSessionRun(sessionKey: string): Promise<void> {
    await sendRequestAsync("chat.abort", { sessionKey });
}

async function deleteSession(sessionKey: string): Promise<unknown> {
    const result = await sendRequestAsync("sessions.delete", {
        key: sessionKey,
        deleteTranscript: true,
    });
    try {
        await refreshSessions(sessionRuntimeContext);
    } catch (error) {
        logger.warn("gateway.sessions_refresh_after_delete_failed", { error });
    }
    return result;
}

async function request(
    method: string,
    parameters: Record<string, unknown>
): Promise<unknown> {
    return sendRequestAsync(method, parameters);
}

function shutdown(): void {
    shutdownGatewayConnection(connectionLifecycleContext);
}

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
