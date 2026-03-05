import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

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

async function fetchMetrics(): Promise<Metrics> {
    return apiFetch<Metrics>("/metrics");
}

export function useMetrics(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["metrics"],
        queryFn: fetchMetrics,
        refetchInterval: refreshInterval,
        staleTime: 1000,
    });
}
