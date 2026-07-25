import { useQuery } from "@tanstack/react-query";

import { apiFetchRequired } from "./useApi";

/** Represents the health API response. */
export interface HealthResponse {
    checks: {
        release: {
            backendCommit: string;
            frontendCommit: string;
            ready: boolean;
        };
        worker: {
            ready: boolean;
        };
    };
    dependencies: {
        gatewayConnected: boolean;
    };
    releaseDetails: {
        backendCommit: string;
        frontendCommit: string;
    };
    sessionCount: number;
    status: "isReady" | "notReady";
}

/** Fetches health. */
function fetchHealth() {
    return apiFetchRequired<HealthResponse>("/health/diagnostics");
}

/** Provides health. */
export function useHealth() {
    return useQuery({
        queryKey: ["health"],
        queryFn: fetchHealth,
        refetchInterval: 10_000,
        staleTime: 5000,
    });
}
