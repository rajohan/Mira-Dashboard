import { queryOptions } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export const databaseOverviewQueryKey = ["database", "overview"] as const;
export const databaseOverviewRefreshIntervalMs = 60_000;

/** @returns The foreground-polled bounded SQLite and PostgreSQL/PgBouncer overview query. */
export function databaseOverviewQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("database.overview", {}, { signal }),
        queryKey: databaseOverviewQueryKey,
        refetchInterval: databaseOverviewRefreshIntervalMs,
        refetchIntervalInBackground: false,
        refetchOnMount: "always",
        staleTime: databaseOverviewRefreshIntervalMs,
    });
}
