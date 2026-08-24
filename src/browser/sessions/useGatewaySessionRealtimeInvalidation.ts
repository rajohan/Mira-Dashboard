import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshGatewaySessionQuery } from "./gatewaySessionQueries.ts";

/** Coalesces native Gateway session bursts without delaying operator interaction. */
export const gatewaySessionRealtimeRefreshDelayMs = 100;

/** Slow safety refresh enabled only after the resumable stream terminates. */
export const gatewaySessionRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes the mounted sessions surface to authoritative snapshot invalidations. */
export function useGatewaySessionRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: gatewaySessionRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: gatewaySessionRealtimeRefreshDelayMs,
        refreshQueries: refreshGatewaySessionQuery,
        topic: gatewayRealtimeTopics.sessions,
    });
}
