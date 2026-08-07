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
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setInterval> | undefined;
        const scheduleRefresh = () => {
            if (refreshTimer !== undefined) return;
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined;
                void refreshQueries(queryClient).catch(() => {});
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
