import type { OpenClawGatewayClientInstance } from "../../lib/openclawGatewayClient/client.ts";
import type { StructuredLogger } from "../../lib/structuredLogger.ts";
import type { GatewayChatReplayRuntime } from "./chatReplayRuntime.ts";
import type { GatewayRequestForwarder } from "./requestForwarder.ts";
import type { GatewayRuntimeConfiguration } from "./runtimeConfiguration.ts";
import type {
    GatewayConnectionMetricsState,
    GatewayConnectionState,
} from "./runtimeState.ts";
import {
    refreshGatewaySessions,
    type GatewaySessionRuntimeContext,
} from "./sessionRuntime.ts";

const DEFAULT_GATEWAY_CONNECTION_WAIT_MS = 45_000;

export interface GatewayConnectionLifecycleContext {
    broadcast: (message: unknown) => void;
    chatReplay: GatewayChatReplayRuntime;
    configuration: GatewayRuntimeConfiguration;
    logger: StructuredLogger;
    metrics: GatewayConnectionMetricsState;
    requestForwarder: GatewayRequestForwarder;
    sessions: GatewaySessionRuntimeContext;
    state: GatewayConnectionState;
}

function isCurrentGatewayClient(
    context: GatewayConnectionLifecycleContext,
    expectedClient: OpenClawGatewayClientInstance
): boolean {
    return context.state.client === expectedClient;
}

function shouldRetrySessionIndexSubscription(attempt: number): boolean {
    return attempt < 3;
}

/**
 * Starts a Gateway client for a token and installs its guarded lifecycle
 * callbacks.
 * @param context Gateway lifecycle dependencies.
 * @param token Gateway bearer token.
 */
export function initializeGatewayConnection(
    context: GatewayConnectionLifecycleContext,
    token: string
): void {
    if (context.state.currentToken === token && context.state.client) {
        return;
    }
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    const previousGatewayClient = context.state.client;
    if (previousGatewayClient) {
        context.chatReplay.bridge.markGatewayDisconnected();
    }
    if (!context.chatReplay.selectScope(gatewayUrl, token)) {
        throw new Error(
            "Gateway credentials were not changed because pending chat replay could not be persisted"
        );
    }
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        context.logger.error("gateway.previous_client_stop_failed", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== undefined,
        });
    }
    if (context.state.client === previousGatewayClient) {
        context.state.client = undefined;
    }
    context.state.isConnected = false;
    context.state.sessions = [];
    context.state.connectError = undefined;
    context.requestForwarder.failPendingRequests("Gateway disconnected");
    context.broadcast({ type: "disconnected", gatewayConnected: false });
    context.state.currentToken = token;
    const thisReplayBridge = context.chatReplay.bridge;

    function getCurrentInitGatewayClient(): OpenClawGatewayClientInstance | undefined {
        return thisGatewayClient && isCurrentGatewayClient(context, thisGatewayClient)
            ? thisGatewayClient
            : undefined;
    }

    function handleGatewayHelloOk(): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        if (context.metrics.connections > 0) {
            context.metrics.reconnects += 1;
        }
        context.metrics.connections += 1;
        context.metrics.lastConnectedAt = new Date().toISOString();
        context.state.isConnected = true;
        thisReplayBridge.markGatewayConnected();
        context.logger.info("gateway.connected", {
            connections: context.metrics.connections,
            reconnects: context.metrics.reconnects,
        });
        context.broadcast({ type: "connected", gatewayConnected: true });

        async function subscribeToSessionIndexEvents(attempt = 0): Promise<void> {
            const currentClient = getCurrentInitGatewayClient();
            if (!currentClient || !context.state.isConnected) {
                return;
            }
            try {
                await currentClient.request("sessions.subscribe", {});
            } catch (error) {
                if (shouldRetrySessionIndexSubscription(attempt)) {
                    const delayMs = 500 * 2 ** attempt;
                    function retrySessionIndexSubscription(): void {
                        void subscribeToSessionIndexEvents(attempt + 1);
                    }
                    setTimeout(retrySessionIndexSubscription, delayMs);
                    return;
                }
                context.logger.warn("gateway.session_index_subscription_failed", {
                    error,
                });
            }
        }
        void subscribeToSessionIndexEvents();
        void refreshGatewaySessions(context.sessions, activeClient);
    }

    function handleGatewayEvent(event: { event?: unknown; payload?: unknown }): void {
        const activeClient = getCurrentInitGatewayClient();
        if (!activeClient) {
            return;
        }
        const envelope = thisReplayBridge.recordEvent(
            event.event,
            event.payload,
            context.state.sessions
        );
        context.broadcast(envelope);
        if (typeof event.event === "string" && event.event.startsWith("sessions.")) {
            void refreshGatewaySessions(context.sessions, activeClient);
        }
    }

    function handleGatewayConnectError(error: Error): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        context.state.connectError = error.message;
        context.metrics.connectFailures += 1;
        context.logger.error("gateway.connect_failed", { error });
    }

    function handleGatewayClose(): void {
        if (!getCurrentInitGatewayClient()) {
            return;
        }
        if (context.state.isConnected) {
            context.metrics.disconnects += 1;
            context.metrics.lastDisconnectedAt = new Date().toISOString();
            context.logger.warn("gateway.disconnected", {
                disconnects: context.metrics.disconnects,
            });
        }
        context.state.isConnected = false;
        context.state.sessions = [];
        thisReplayBridge.markGatewayDisconnected();
        thisReplayBridge.flush();
        context.requestForwarder.failPendingRequests("Gateway disconnected");
        context.broadcast({ type: "disconnected", gatewayConnected: false });
    }

    const thisGatewayClient = new context.configuration.clientConstructor({
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
        deviceIdentity: context.configuration.loadDashboardDeviceIdentity((error) => {
            context.logger.warn("gateway.device_identity_load_failed", { error });
        }),
        onHelloOk: handleGatewayHelloOk,
        onEvent: handleGatewayEvent,
        onConnectError: handleGatewayConnectError,
        onClose: handleGatewayClose,
    });
    context.state.client = thisGatewayClient;
    try {
        thisGatewayClient.start();
    } catch (error) {
        if (context.state.client === thisGatewayClient) {
            context.state.client = undefined;
            context.state.currentToken = undefined;
        }
        throw error;
    }
}

function isGatewayAuthFailureMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("unauthorized") || normalized.includes("token mismatch");
}

/**
 * Waits until the client for the expected token connects or fails.
 * @param context Gateway lifecycle dependencies.
 * @param expectedToken Token whose connection is expected.
 * @param timeoutMs Maximum connection wait.
 * @returns Promise resolved after connection.
 */
export function waitForGatewayConnection(
    context: GatewayConnectionLifecycleContext,
    expectedToken: string,
    timeoutMs = DEFAULT_GATEWAY_CONNECTION_WAIT_MS
): Promise<void> {
    if (context.state.currentToken === expectedToken && context.state.isConnected) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const interval = setInterval(() => {
            if (context.state.currentToken !== expectedToken) {
                clearInterval(interval);
                reject(new Error("Gateway token changed before connection completed"));
                return;
            }
            if (context.state.isConnected) {
                clearInterval(interval);
                resolve();
                return;
            }
            if (
                context.state.connectError &&
                isGatewayAuthFailureMessage(context.state.connectError)
            ) {
                clearInterval(interval);
                reject(new Error(context.state.connectError));
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(interval);
                reject(
                    new Error(
                        context.state.connectError ||
                            "Gateway connection was not established"
                    )
                );
            }
        }, 50);
    });
}

/**
 * Initializes a Gateway connection and waits for its handshake.
 * @param context Gateway lifecycle dependencies.
 * @param token Gateway bearer token.
 */
export async function initializeAndWaitForGatewayConnection(
    context: GatewayConnectionLifecycleContext,
    token: string
): Promise<void> {
    initializeGatewayConnection(context, token);
    await waitForGatewayConnection(context, token);
}

/**
 * Stops the active Gateway and clears connected and replay state.
 * @param context Gateway lifecycle dependencies.
 */
export function shutdownGatewayConnection(
    context: GatewayConnectionLifecycleContext
): void {
    const previousGatewayClient = context.state.client;
    const wasConnected = context.state.isConnected;
    if (wasConnected) {
        context.chatReplay.bridge.markGatewayDisconnected();
    }
    try {
        previousGatewayClient?.stop();
    } catch (error) {
        context.logger.error("gateway.previous_client_shutdown_failed", {
            error,
            hadPreviousGatewayClient: previousGatewayClient !== undefined,
        });
    }
    if (wasConnected && context.state.isConnected) {
        context.metrics.disconnects += 1;
        context.metrics.lastDisconnectedAt = new Date().toISOString();
    }
    if (context.state.client === previousGatewayClient) {
        context.state.client = undefined;
    }
    context.state.isConnected = false;
    context.state.sessions = [];
    context.state.currentToken = undefined;
    context.chatReplay.bridge.clearMemory();
    context.requestForwarder.failPendingRequests("Gateway disconnected");
    context.broadcast({ type: "disconnected", gatewayConnected: false });
}
