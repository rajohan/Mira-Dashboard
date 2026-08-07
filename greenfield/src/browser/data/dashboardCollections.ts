import type { QueryClient } from "@tanstack/react-query";

import {
    createAgentCollections,
    type AgentCollections,
} from "../agents/agentCollections.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Browser-owned normalized collections and their explicit lifetime boundary. */
export interface DashboardBrowserCollections {
    readonly agents: AgentCollections;
    readonly cleanup: () => Promise<void>;
}

/**
 * Creates all normalized collections owned by one browser application runtime.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param trpcClient Browser-owned validated transport client.
 * @returns One deeply stable collection registry with idempotent cleanup.
 */
export function createDashboardBrowserCollections(
    queryClient: QueryClient,
    trpcClient: DashboardTrpcClient
): DashboardBrowserCollections {
    const agents = createAgentCollections(queryClient, trpcClient);
    let cleaned = false;
    return Object.freeze({
        agents,
        async cleanup(): Promise<void> {
            if (cleaned) return;
            cleaned = true;
            await Promise.all([
                agents.definitions.cleanup(),
                agents.statuses.cleanup(),
            ]);
        },
    });
}
