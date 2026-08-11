import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export const moltbookQueryKey = ["moltbook"] as const;
const moltbookPollingIntervalMs = 60_000;

/** @returns Bounded home and notification projection query options. */
export function moltbookHomeQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("moltbook.home", {}, { signal }),
        queryKey: [...moltbookQueryKey, "home"],
        refetchInterval: moltbookPollingIntervalMs,
        retry: false,
        staleTime: moltbookPollingIntervalMs,
    });
}

/** @returns One strict hot or new feed projection query. */
export function moltbookFeedQueryOptions(
    client: DashboardTrpcClient,
    sort: "hot" | "new"
) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("moltbook.feed", { sort }, { signal }),
        queryKey: [...moltbookQueryKey, "feed", sort],
        refetchInterval: moltbookPollingIntervalMs,
        retry: false,
        staleTime: moltbookPollingIntervalMs,
    });
}

/** @returns Configured agent profile projection query. */
export function moltbookProfileQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("moltbook.profile", {}, { signal }),
        queryKey: [...moltbookQueryKey, "profile"],
        refetchInterval: moltbookPollingIntervalMs,
        retry: false,
        staleTime: moltbookPollingIntervalMs,
    });
}

/** @returns Configured agent posts and comments projection query. */
export function moltbookOwnContentQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("moltbook.listMyPosts", {}, { signal }),
        queryKey: [...moltbookQueryKey, "own-content"],
        refetchInterval: moltbookPollingIntervalMs,
        retry: false,
        staleTime: moltbookPollingIntervalMs,
    });
}

/** Refetches every browser projection without directly dispatching an upstream job. */
export async function refreshMoltbookQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: moltbookQueryKey });
}
