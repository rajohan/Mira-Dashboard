import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
    cacheRealtimeIdentityMatches,
    cacheRealtimeTopic,
} from "../../contracts/cacheRealtime.ts";
import { useDashboardRealtimeHub } from "../api/realtimeContextValue.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import {
    refreshAllCacheQueries,
    refreshCacheEntryQuery,
    refreshCacheStatusQueries,
} from "./cacheQueries.ts";

export const cacheRealtimeRefreshDelayMs = 100;
export const cacheRealtimeFallbackRefreshIntervalMs = 30_000;

/**
 * Subscribes the cache browser to precise provider invalidations. The shared
 * invalidation hook owns coalescing and terminal fallback; a companion listener
 * retains the provider identities represented inside each coalesced window.
 */
export function useCacheRealtimeInvalidation(): void {
    const hub = useDashboardRealtimeHub();
    const pendingKeys = useRef(new Set<string>());
    const preciseEventsUnavailable = useRef(false);

    useEffect(() => {
        const keys = pendingKeys.current;
        const subscription = hub.subscribe([cacheRealtimeTopic], {
            onData(output) {
                if (output.data.kind === "resync-required") {
                    preciseEventsUnavailable.current = true;
                    return;
                }
                const { event } = output.data;
                if (
                    event.topic === cacheRealtimeTopic &&
                    cacheRealtimeIdentityMatches(event)
                ) {
                    keys.add(event.payload.key);
                }
            },
            onError() {
                preciseEventsUnavailable.current = true;
            },
        });
        return () => {
            keys.clear();
            subscription.unsubscribe();
        };
    }, [hub]);

    const refreshQueries = async (queryClient: QueryClient) => {
        if (preciseEventsUnavailable.current) {
            pendingKeys.current.clear();
            await refreshAllCacheQueries(queryClient);
            return;
        }

        const changedKeys = [...pendingKeys.current];
        pendingKeys.current.clear();
        await Promise.allSettled([
            refreshCacheStatusQueries(queryClient),
            ...changedKeys.map((key) => refreshCacheEntryQuery(queryClient, key)),
        ]);
    };

    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: cacheRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: cacheRealtimeRefreshDelayMs,
        refreshQueries,
        topic: cacheRealtimeTopic,
    });
}
