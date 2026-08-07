import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import type { DashboardBrowserCollections } from "../data/dashboardCollections.ts";

export const authStatusQueryKey = ["auth", "status"] as const;

/**
 * Defines the sole cache entry for non-secret browser authentication state.
 * @param client Browser contract client.
 * @returns TanStack Query options with request cancellation propagation.
 */
export function authStatusQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("auth.status", {}, { signal }),
        queryKey: authStatusQueryKey,
        retry: false,
        staleTime: 0,
    });
}

/**
 * Replaces all cached browser data after an authentication boundary changes.
 * @param queryClient Browser-owned query cache.
 * @param collections Browser-owned normalized collection registry.
 * @param status Optional known state to seed after clearing.
 */
export async function resetAuthenticatedBrowserCache(
    queryClient: QueryClient,
    collections: DashboardBrowserCollections,
    status?: AuthStatus
): Promise<void> {
    try {
        await collections.reset();
    } finally {
        if (status === undefined) {
            queryClient.clear();
        } else {
            for (const query of queryClient.getQueryCache().getAll()) {
                if (
                    query.queryKey.length === authStatusQueryKey.length &&
                    query.queryKey.every(
                        (value, index) => value === authStatusQueryKey[index]
                    )
                ) {
                    continue;
                }
                queryClient.removeQueries({ exact: true, queryKey: query.queryKey });
            }
            queryClient.setQueryData(authStatusQueryKey, status);
        }
    }
}
