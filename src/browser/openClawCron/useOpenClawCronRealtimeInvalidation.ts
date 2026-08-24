import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshOpenClawCronQueries } from "./openClawCronQueries.ts";

/** Coalesces Gateway snapshot markers without delaying normal operator interaction. */
export const openClawCronRealtimeRefreshDelayMs = 100;
/** Fallback used only after terminal stream failure; query polling remains independent. */
export const openClawCronRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes one mounted OpenClaw cron surface to authoritative snapshot invalidation. */
export function useOpenClawCronRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: openClawCronRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: openClawCronRealtimeRefreshDelayMs,
        refreshQueries: refreshOpenClawCronQueries,
        topic: gatewayRealtimeTopics.cron,
    });
}
