import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshTaskQueries } from "./taskQueries.ts";

/** Coalesces bursts without delaying normal task interaction perceptibly. */
export const taskRealtimeRefreshDelayMs = 100;
/** Slow fallback used only after the reconnecting SSE transport terminates. */
export const taskRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes the mounted task surface to durable cache invalidations. */
export function useTaskRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: taskRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: taskRealtimeRefreshDelayMs,
        refreshQueries: refreshTaskQueries,
        topic: taskRealtimeTopic,
    });
}
