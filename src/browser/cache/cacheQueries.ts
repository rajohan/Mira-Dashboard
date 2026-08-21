import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { CacheEntry, CacheStatusResult } from "../../contracts/cache.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export const cacheQueryKey = ["cache"] as const;
export const cacheStatusQueryKey = [...cacheQueryKey, "status"] as const;
export const cacheEntryQueryRoot = [...cacheQueryKey, "entries"] as const;

/**
 * Cache freshness changes as wall time advances even when no provider event occurs.
 * Keep one bounded status snapshot moving while the cache browser is mounted.
 */
export const cacheStatusRefreshIntervalMs = 30_000;

/**
 * @param key Canonical provider-owned cache identity.
 * @returns Exact query key for one payload-bearing cache entry.
 */
export function cacheEntryQueryKey(key: string) {
    return [...cacheEntryQueryRoot, key] as const;
}

/** @returns Bounded payload-free cache inventory query options. */
export function cacheStatusQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<CacheStatusResult> =>
            client.query("cache.getStatus", {}, { signal }),
        queryKey: cacheStatusQueryKey,
        refetchInterval: cacheStatusRefreshIntervalMs,
        refetchOnMount: "always",
        staleTime: cacheStatusRefreshIntervalMs,
    });
}

/**
 * Builds an exact payload query only after the browser has selected an entry.
 * @param client Validated browser tRPC client.
 * @param key Selected provider-owned cache identity.
 * @returns Exact cache-entry query options.
 */
export function cacheEntryQueryOptions(client: DashboardTrpcClient, key: string) {
    return queryOptions({
        queryFn: ({ signal }): Promise<CacheEntry> =>
            client.query("cache.getEntry", { key }, { signal }),
        queryKey: cacheEntryQueryKey(key),
        refetchInterval: cacheStatusRefreshIntervalMs,
        refetchOnMount: "always",
        staleTime: cacheStatusRefreshIntervalMs,
    });
}

/** @param queryClient Browser cache whose bounded status snapshot changed. */
export async function refreshCacheStatusQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({
        exact: true,
        queryKey: cacheStatusQueryKey,
    });
}

/**
 * @param queryClient Browser cache containing exact provider projections.
 * @param key Provider identity whose exact projection changed.
 */
export async function refreshCacheEntryQuery(
    queryClient: QueryClient,
    key: string
): Promise<void> {
    await queryClient.invalidateQueries({
        exact: true,
        queryKey: cacheEntryQueryKey(key),
    });
}

/**
 * Invalidates both public views of one provider attempt without evicting LKG data.
 * Both invalidations are attempted even if one observer refresh rejects.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param key Provider identity changed by a mutation or realtime event.
 */
export async function refreshCacheQueriesForEntry(
    queryClient: QueryClient,
    key: string
): Promise<void> {
    await Promise.allSettled([
        refreshCacheStatusQueries(queryClient),
        refreshCacheEntryQuery(queryClient, key),
    ]);
}

/**
 * Invalidates the bounded status snapshot and every cached exact projection.
 * Used only after a terminal stream condition removes per-entry event precision.
 * @param queryClient Browser-owned TanStack Query cache.
 */
export async function refreshAllCacheQueries(queryClient: QueryClient): Promise<void> {
    await Promise.allSettled([
        refreshCacheStatusQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: cacheEntryQueryRoot }),
    ]);
}
