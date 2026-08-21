import { keepPreviousData, queryOptions, type QueryClient } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export const moltbookQueryKey = ["moltbook"] as const;
const moltbookPollingIntervalMs = 30 * 60_000;

export function moltbookSnapshotQueryKey(sort: "hot" | "new") {
    return [...moltbookQueryKey, "snapshot", sort] as const;
}

/** @returns The complete Moltbook page projection from one bounded cache read. */
export function moltbookSnapshotQueryOptions(
    client: DashboardTrpcClient,
    sort: "hot" | "new"
) {
    return queryOptions({
        placeholderData: keepPreviousData,
        queryFn: ({ signal }) => client.query("moltbook.snapshot", { sort }, { signal }),
        queryKey: moltbookSnapshotQueryKey(sort),
        refetchInterval: moltbookPollingIntervalMs,
        retry: false,
        staleTime: moltbookPollingIntervalMs,
    });
}

/** Refetches every browser projection without directly dispatching an upstream job. */
export async function refreshMoltbookQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: moltbookQueryKey });
}
