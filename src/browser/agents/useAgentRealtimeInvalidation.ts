import { agentRealtimeTopic } from "../../contracts/agentRealtime.ts";
import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshAgentQueries } from "./agentQueries.ts";

export const agentRealtimeRefreshDelayMs = 100;
export const agentRealtimeFallbackRefreshIntervalMs = 30_000;
const agentRealtimeTopics = Object.freeze([
    agentRealtimeTopic,
    gatewayRealtimeTopics.connection,
    gatewayRealtimeTopics.sessions,
] as const);

/** Subscribes the mounted agent surface to task and Gateway-session invalidations. */
export function useAgentRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: agentRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: agentRealtimeRefreshDelayMs,
        refreshQueries: refreshAgentQueries,
        topic: agentRealtimeTopics,
    });
}
