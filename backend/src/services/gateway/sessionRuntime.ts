import type { Session } from "../../../../contracts/sessions.ts";
import type { OpenClawGatewayClientInstance } from "../../lib/openclawGatewayClient/client.ts";
import type { StructuredLogger } from "../../lib/structuredLogger.ts";
import type { GatewayChatReplayRuntime } from "./chatReplayRuntime.ts";
import type { GatewayConnectionState } from "./runtimeState.ts";
import { normalizeGatewaySessionList } from "./sessionProjection.ts";

export interface GatewaySessionRuntimeContext {
    broadcast: (message: unknown) => void;
    chatReplay: GatewayChatReplayRuntime;
    logger: StructuredLogger;
    state: GatewayConnectionState;
}

function isCurrentGatewayClient(
    context: GatewaySessionRuntimeContext,
    expectedClient: OpenClawGatewayClientInstance
): boolean {
    return context.state.client === expectedClient;
}

/**
 * Installs and broadcasts a normalized session list for the active Gateway.
 * @param context Gateway session runtime dependencies.
 * @param expectedClient Gateway client that produced the list.
 * @param sessions Normalized Dashboard sessions.
 */
export function publishGatewaySessions(
    context: GatewaySessionRuntimeContext,
    expectedClient: OpenClawGatewayClientInstance,
    sessions: Session[]
): void {
    if (!context.state.isConnected || !isCurrentGatewayClient(context, expectedClient)) {
        return;
    }
    context.state.sessions = sessions;
    context.chatReplay.bridge.reconcileSessions(context.state.sessions);
    context.broadcast({ type: "sessions", sessions: context.state.sessions });
}

/**
 * Refreshes the active Gateway session list.
 * @param context Gateway session runtime dependencies.
 * @param expectedClient Expected active Gateway client.
 */
export async function refreshSessions(
    context: GatewaySessionRuntimeContext,
    expectedClient: OpenClawGatewayClientInstance | undefined = context.state.client
): Promise<void> {
    if (
        !expectedClient ||
        !context.state.isConnected ||
        !isCurrentGatewayClient(context, expectedClient)
    ) {
        return;
    }

    const response = await expectedClient.request("sessions.list", {});
    publishGatewaySessions(
        context,
        expectedClient,
        normalizeGatewaySessionList(response)
    );
}

/** Refreshes sessions after a forwarded request without failing the request. */
export async function refreshSessionsAfterRequest(
    context: GatewaySessionRuntimeContext,
    activeGateway: OpenClawGatewayClientInstance
): Promise<void> {
    try {
        await refreshSessions(context, activeGateway);
    } catch (error) {
        context.logger.warn("gateway.sessions_refresh_after_request_failed", { error });
    }
}

/** Refreshes Gateway sessions and logs failures from event callbacks. */
export async function refreshGatewaySessions(
    context: GatewaySessionRuntimeContext,
    activeClient: OpenClawGatewayClientInstance
): Promise<void> {
    try {
        await refreshSessions(context, activeClient);
    } catch (error) {
        context.logger.error("gateway.sessions_refresh_failed", { error });
    }
}
