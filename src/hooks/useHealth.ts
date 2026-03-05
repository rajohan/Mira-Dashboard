import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

export interface HealthResponse {
    status: string;
    gatewayConnected: boolean;
    sessionCount: number;
    backendCommit?: string;
}

function fetchHealth() {
    return apiFetch<HealthResponse>("/health");
}

export function useHealth() {
    return useQuery({
        queryKey: ["health"],
        queryFn: fetchHealth,
        refetchInterval: 10_000,
        staleTime: 5_000,
    });
}
