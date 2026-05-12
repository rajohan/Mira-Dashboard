import { useQuery } from "@tanstack/react-query";

import { apiFetchRequired } from "./useApi";

/** Represents the health API response. */
export interface HealthResponse {
    status: string;
    gatewayConnected: boolean;
    sessionCount: number;
    backendCommit?: string;
}

/** Fetches health. */
function fetchHealth() {
    return apiFetchRequired<HealthResponse>("/health");
}

/** Provides health. */
export function useHealth() {
    return useQuery({
        queryKey: ["health"],
        queryFn: fetchHealth,
        refetchInterval: 10_000,
        staleTime: 5_000,
    });
}
