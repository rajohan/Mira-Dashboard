import type { GatewayMetrics } from "../../../../contracts/metrics.ts";
import type { Session } from "../../../../contracts/sessions.ts";
import type { OpenClawGatewayClientInstance } from "../../lib/openclawGatewayClient/client.ts";

export interface GatewayConnectionState {
    client: OpenClawGatewayClientInstance | undefined;
    connectError: string | undefined;
    currentToken: string | undefined;
    isConnected: boolean;
    sessions: Session[];
}

export type GatewayConnectionMetricsState = Omit<
    GatewayMetrics,
    "connected" | "pendingRequests"
>;

export function createGatewayConnectionState(): GatewayConnectionState {
    return {
        client: undefined,
        connectError: undefined,
        currentToken: undefined,
        isConnected: false,
        sessions: [],
    };
}

export function createGatewayConnectionMetricsState(): GatewayConnectionMetricsState {
    return {
        connectFailures: 0,
        connections: 0,
        disconnects: 0,
        reconnects: 0,
    };
}
