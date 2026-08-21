import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshJobAndScheduleQueries, refreshScheduleQueries } from "./jobQueries.ts";

export const jobRealtimeRefreshDelayMs = 100;
export const jobRealtimeFallbackRefreshIntervalMs = 30_000;

/**
 * Subscribes the jobs browser to durable run, queue, and schedule invalidations.
 * Run changes refresh embedded schedule projections as well as the queue/history.
 */
export function useJobRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: jobRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: jobRealtimeRefreshDelayMs,
        refreshQueries: refreshJobAndScheduleQueries,
        topic: jobRealtimeTopics.runs,
    });
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: jobRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: jobRealtimeRefreshDelayMs,
        refreshQueries: refreshScheduleQueries,
        topic: jobRealtimeTopics.schedules,
    });
}
