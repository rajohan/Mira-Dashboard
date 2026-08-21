import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { refreshIncidentQueries, refreshReportQueries } from "./monitoringQueries.ts";

export const monitoringRealtimeRefreshDelayMs = 100;
export const monitoringRealtimeFallbackRefreshIntervalMs = 30_000;

function useMonitoringTopic(
    topic: (typeof monitoringRealtimeTopics)[keyof typeof monitoringRealtimeTopics],
    refreshQueries: typeof refreshIncidentQueries
): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: monitoringRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: monitoringRealtimeRefreshDelayMs,
        refreshQueries,
        topic,
    });
}

/** Subscribes the mounted reports route to durable report invalidations. */
export function useReportRealtimeInvalidation(): void {
    useMonitoringTopic(monitoringRealtimeTopics.reports, refreshReportQueries);
}

/** Subscribes the mounted incident reader to durable incident invalidations. */
export function useIncidentRealtimeInvalidation(): void {
    useMonitoringTopic(monitoringRealtimeTopics.incidents, refreshIncidentQueries);
}
