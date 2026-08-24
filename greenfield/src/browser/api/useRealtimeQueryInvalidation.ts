import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useDashboardRealtimeHub } from "./realtimeContextValue.ts";
import type { DashboardRealtimeTopic } from "./realtimeHub.ts";

interface RealtimeQueryInvalidationOptions {
    readonly fallbackRefreshIntervalMs: number;
    readonly refreshDelayMs: number;
    readonly refreshQueries: (queryClient: QueryClient) => Promise<void>;
    readonly topic: DashboardRealtimeTopic;
}

/**
 * Coalesces one feature topic into query invalidation with terminal-stream fallback.
 * @param options Stable feature topic, timing policy, and cache invalidator.
 */
export function useRealtimeQueryInvalidation({
    fallbackRefreshIntervalMs,
    refreshDelayMs,
    refreshQueries,
    topic,
}: RealtimeQueryInvalidationOptions): void {
    const hub = useDashboardRealtimeHub();
    const queryClient = useQueryClient();

    useEffect(() => {
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
                await refreshQueries(queryClient);
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
        const subscription = hub.subscribe([topic], {
            onData(output) {
                if (output.data.kind === "resync-required") {
                    startFallbackRefresh();
                    return;
                }
                if (output.data.event.topic === topic) scheduleRefresh();
            },
            onError: startFallbackRefresh,
        });
        return () => {
            disposed = true;
            subscription.unsubscribe();
            if (refreshTimer !== undefined) clearTimeout(refreshTimer);
            if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
        };
    }, [
        fallbackRefreshIntervalMs,
        hub,
        queryClient,
        refreshDelayMs,
        refreshQueries,
        topic,
    ]);
}
