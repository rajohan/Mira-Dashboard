import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshNotificationRealtimeQueries } from "./notificationQueries.ts";

export const notificationRealtimeRefreshDelayMs = 100;
export const notificationRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes the authenticated notification center to durable invalidations. */
export function useNotificationRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: notificationRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: notificationRealtimeRefreshDelayMs,
        refreshQueries: refreshNotificationRealtimeQueries,
        topic: monitoringRealtimeTopics.notifications,
    });
}
