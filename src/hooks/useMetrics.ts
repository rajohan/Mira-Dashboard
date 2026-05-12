import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

/** Represents the detailed system metrics payload returned by /api/metrics. */
export interface Metrics {
    cpu: {
        count: number;
        model: string;
        loadAvg: number[];
        loadPercent: number;
    };
    memory: {
        total: number;
        used: number;
        free: number;
        percent: number;
        totalGB: number;
        usedGB: number;
    };
    disk: {
        total: number;
        used: number;
        percent: number;
        totalGB: number;
        usedGB: number;
    };
    system: {
        uptime: number;
        platform: string;
        hostname: string;
    };
    network: {
        downloadMbps: number;
        uploadMbps: number;
    };
    tokens: {
        total: number;
        byModel: Record<string, number>;
        sessionsByModel: Record<string, number>;
        byAgent: Array<{
            label: string;
            model: string;
            tokens: number;
            type: string;
        }>;
    };
    timestamp: number;
}

/** Fetches the latest detailed system metrics snapshot. */
async function fetchMetrics(): Promise<Metrics> {
    return apiFetch<Metrics>("/metrics");
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
