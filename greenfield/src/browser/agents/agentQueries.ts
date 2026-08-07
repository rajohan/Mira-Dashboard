import { infiniteQueryOptions, type QueryClient } from "@tanstack/react-query";

import type {
    ListAgentTaskHistoryInput,
    ListAgentTaskHistoryResult,
} from "../../contracts/agents.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

type AgentHistoryCursor = NonNullable<ListAgentTaskHistoryInput["cursor"]>;

export const agentQueryKey = ["agents"] as const;

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
        queryKey: [...agentQueryKey, "history"],
        staleTime: 10_000,
    });
}

/** Invalidates every agent projection after one durable status transition. */
export async function refreshAgentQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: agentQueryKey });
}
