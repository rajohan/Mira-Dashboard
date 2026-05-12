import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

/** Describes health response. */
export interface HealthResponse {
    status: string;
    gatewayConnected: boolean;
    sessionCount: number;
    backendCommit?: string;
}

/** Handles fetch health. */
function fetchHealth() {
    return apiFetch<HealthResponse>("/health");
}

/** Handles use health. */
export function useHealth() {
    return useQuery({
        queryKey: ["health"],
        queryFn: fetchHealth,
        refetchInterval: 10_000,
        staleTime: 5_000,
    });
}
