import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useDashboardRealtimeHub } from "./realtimeContextValue.ts";
import type { DashboardRealtimeTopic } from "./realtimeHub.ts";

interface RealtimeQueryInvalidationOptions {
    readonly fallbackRefreshIntervalMs: number;
    readonly refreshDelayMs: number;
    readonly refreshQueries: (queryClient: QueryClient) => Promise<void>;
    readonly topic: DashboardRealtimeTopic | readonly DashboardRealtimeTopic[];
}

/**
 * Coalesces one stable feature topic set into query invalidation with terminal fallback.
 * @param options Stable feature topic or topic array, timing policy, and cache invalidator.
 */
export function useRealtimeQueryInvalidation({
    fallbackRefreshIntervalMs,
    refreshDelayMs,
    refreshQueries,
    topic,
}: RealtimeQueryInvalidationOptions): void {
    const hub = useDashboardRealtimeHub();
    const queryClient = useQueryClient();
    const refreshQueriesReference = useRef(refreshQueries);

    useEffect(() => {
        refreshQueriesReference.current = refreshQueries;
    }, [refreshQueries]);

    useEffect(() => {
        const topics = typeof topic === "string" ? [topic] : topic;
        let disposed = false;
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setInterval> | undefined;
        let refreshInFlight = false;
        let trailingRefreshRequested = false;
        const runRefresh = async () => {
            refreshTimer = undefined;
            if (disposed) return;
            refreshInFlight = true;
            try {
                await refreshQueriesReference.current(queryClient);
            } catch {
                // Realtime refresh is best-effort; cached data remains available.
            } finally {
                refreshInFlight = false;
                if (!disposed && trailingRefreshRequested) {
                    trailingRefreshRequested = false;
                    scheduleRefresh();
                }
            }
        };
        const scheduleRefresh = () => {
            if (refreshInFlight) {
                trailingRefreshRequested = true;
                return;
            }
            if (refreshTimer !== undefined) return;
            refreshTimer = setTimeout(() => {
                void runRefresh();
            }, refreshDelayMs);
        };
        const startFallbackRefresh = () => {
            scheduleRefresh();
            fallbackTimer ??= setInterval(scheduleRefresh, fallbackRefreshIntervalMs);
        };
        const subscription = hub.subscribe(topics, {
            onData(output) {
                if (output.data.kind === "resync-required") {
                    startFallbackRefresh();
                    return;
                }
                if (topics.includes(output.data.event.topic)) scheduleRefresh();
            },
            onError: startFallbackRefresh,
        });
        return () => {
            disposed = true;
            subscription.unsubscribe();
            if (refreshTimer !== undefined) clearTimeout(refreshTimer);
            if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
        };
    }, [fallbackRefreshIntervalMs, hub, queryClient, refreshDelayMs, topic]);
}
