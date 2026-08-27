import { queryOptions } from "@tanstack/react-query";
import * as v from "valibot";

import {
    type OpenClawUpdateStatus,
    type SystemMetrics,
    openClawUpdateCacheKey,
    openClawUpdateCacheTtlMs,
    openClawUpdateStatusSchema,
} from "../../contracts/system.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { cacheEntryQueryKey } from "../cache/cacheQueries.ts";

export const systemMetricsQueryKey = ["system", "metrics"] as const;
export const systemMetricsRefreshIntervalMs = 5000;

/** @returns Five-second demand-driven system metric query options. */
export function systemMetricsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<SystemMetrics> =>
            client.query("system.metrics", {}, { signal }),
        queryKey: systemMetricsQueryKey,
        refetchInterval: systemMetricsRefreshIntervalMs,
        refetchOnMount: "always",
        staleTime: systemMetricsRefreshIntervalMs,
    });
}

/** @returns Five-minute OpenClaw update query options. */
export function openClawUpdateStatusQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<OpenClawUpdateStatus | null> =>
            client
                .query("cache.getEntry", { key: openClawUpdateCacheKey }, { signal })
                .then((entry) =>
                    entry.freshness === "fresh"
                        ? v.parse(openClawUpdateStatusSchema, entry.payload)
                        : null
                ),
        queryKey: cacheEntryQueryKey(openClawUpdateCacheKey),
        refetchInterval: openClawUpdateCacheTtlMs,
        refetchOnMount: "always",
        staleTime: openClawUpdateCacheTtlMs,
    });
}
