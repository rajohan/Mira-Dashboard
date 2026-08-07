import { agentRealtimeTopic } from "../../contracts/agentRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshAgentQueries } from "./agentQueries.ts";

export const agentRealtimeRefreshDelayMs = 100;
export const agentRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes the mounted agent surface to durable status invalidations. */
export function useAgentRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: agentRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: agentRealtimeRefreshDelayMs,
        refreshQueries: refreshAgentQueries,
        topic: agentRealtimeTopic,
    });
}
