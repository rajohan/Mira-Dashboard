import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import { useDashboardRealtimeHub } from "../api/realtimeContextValue.ts";
import { refreshTaskQueries } from "./taskQueries.ts";

/** Coalesces bursts without delaying normal task interaction perceptibly. */
export const taskRealtimeRefreshDelayMs = 100;
/** Slow fallback used only after the reconnecting SSE transport terminates. */
export const taskRealtimeFallbackRefreshIntervalMs = 30_000;

/** Subscribes the mounted task surface to durable cache invalidations. */
export function useTaskRealtimeInvalidation(): void {
    const hub = useDashboardRealtimeHub();
    const queryClient = useQueryClient();

    useEffect(() => {
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setInterval> | undefined;
        const scheduleRefresh = () => {
            if (refreshTimer !== undefined) return;
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined;
                void refreshTaskQueries(queryClient);
            }, taskRealtimeRefreshDelayMs);
        };
        const startFallbackRefresh = () => {
            scheduleRefresh();
            fallbackTimer ??= setInterval(
                scheduleRefresh,
                taskRealtimeFallbackRefreshIntervalMs
            );
        };
        const subscription = hub.subscribe([taskRealtimeTopic], {
            onData(output) {
                if (output.data.kind === "resync-required") {
                    scheduleRefresh();
                    return;
                }
                if (output.data.event.topic === taskRealtimeTopic) {
                    scheduleRefresh();
                }
            },
            onError: startFallbackRefresh,
        });
        return () => {
            subscription.unsubscribe();
            if (refreshTimer !== undefined) clearTimeout(refreshTimer);
            if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
        };
    }, [hub, queryClient]);
}
