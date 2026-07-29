import { useQuery } from "@tanstack/react-query";

import { parseDashboardDiagnosticsResponse } from "../../../contracts/health";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed } from "./useApi";

/**
 * Fetches health.
 * @returns Fetch health result.
 */
function fetchHealth() {
    return apiFetchParsed("/health/diagnostics", parseDashboardDiagnosticsResponse);
}

/**
 * Provides health.
 * @returns The health.
 */
export function useHealth() {
    return useQuery({
        queryKey: ["health"],
        queryFn: fetchHealth,
        refetchInterval: refreshPolicy.active * 2,
        staleTime: 5000,
    });
}
