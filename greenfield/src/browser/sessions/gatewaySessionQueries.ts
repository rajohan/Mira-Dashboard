import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { gatewaySessionsClient } from "./gatewaySessionClient.ts";

export const gatewaySessionQueryKey = ["gateway-sessions", "snapshot"] as const;

/** Foreground cadence for a current OpenClaw projection and connection freshness. */
export const gatewaySessionRefreshIntervalMs = 10_000;

/** @returns One bounded ALL-filter current-session snapshot query. */
export function gatewaySessionQueryOptions(client: DashboardTrpcClient) {
    const sessionsClient = gatewaySessionsClient(client);
    return queryOptions({
        queryFn: ({ signal }) =>
            sessionsClient.query("gatewaySessions.list", { filter: "ALL" }, { signal }),
        queryKey: gatewaySessionQueryKey,
        refetchInterval: gatewaySessionRefreshIntervalMs,
        retry: false,
        staleTime: gatewaySessionRefreshIntervalMs,
    });
}

/** Refreshes the single bounded current-session snapshot. */
export async function refreshGatewaySessionQuery(
    queryClient: QueryClient
): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: gatewaySessionQueryKey });
}
