import {
    infiniteQueryOptions,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ListAgentTaskHistoryInput,
    ListAgentTaskHistoryResult,
} from "../../contracts/agents.ts";
import {
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
} from "../api/liveHistory.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

type AgentHistoryCursor = NonNullable<ListAgentTaskHistoryInput["cursor"]>;

export const agentQueryKey = ["agents"] as const;
export const agentConfigurationQueryKey = [...agentQueryKey, "configuration"] as const;
export const agentStatusesQueryKey = [...agentQueryKey, "statuses"] as const;

/** @returns Cursor-paginated newest-first agent task history query options. */
export function agentHistoryQueryOptions(client: DashboardTrpcClient) {
    return infiniteQueryOptions({
        initialPageParam: undefined as AgentHistoryCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListAgentTaskHistoryResult> =>
            client.query(
                "agents.listTaskHistory",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    limit: 50,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey([...agentQueryKey, "history"]),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Live first-page projection for current agent task history. */
export function agentHistoryLiveHeadQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListAgentTaskHistoryResult> =>
            client.query("agents.listTaskHistory", { limit: 50 }, { signal }),
        queryKey: liveHistoryHeadQueryKey([...agentQueryKey, "history"]),
        staleTime: 10_000,
    });
}

/** Invalidates every agent projection after one durable status transition. */
export async function refreshAgentQueries(queryClient: QueryClient): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentQueryKey }),
        queryClient.invalidateQueries({
            queryKey: liveHistoryArchiveQueryKey(agentQueryKey),
        }),
    ]);
}
