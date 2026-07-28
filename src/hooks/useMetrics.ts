import { useQuery } from "@tanstack/react-query";

import type { Metrics } from "../../contracts/metrics";
import { parseMetricsResponse } from "../../contracts/metrics";
import { apiFetchParsed } from "./useApi";

/** Fetches the latest detailed system metrics snapshot. */
async function fetchMetrics(): Promise<Metrics> {
    return apiFetchParsed("/metrics", parseMetricsResponse);
}

/** Provides periodically refreshed system metrics for dashboard cards. */
export function useMetrics(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["metrics"],
        queryFn: fetchMetrics,
        refetchInterval: refreshInterval,
        staleTime: 1000,
    });
}
