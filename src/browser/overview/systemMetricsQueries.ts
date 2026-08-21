import { queryOptions } from "@tanstack/react-query";

import type { SystemMetrics } from "../../contracts/system.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

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
