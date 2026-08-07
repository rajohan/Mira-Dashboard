import type { QueryClient } from "@tanstack/react-query";

import {
    createAgentCollections,
    type AgentCollections,
} from "../agents/agentCollections.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Browser-owned normalized collections and their explicit lifetime/reset boundaries. */
export interface DashboardBrowserCollections {
    readonly agents: AgentCollections;
    readonly cleanup: () => Promise<void>;
    readonly reset: () => Promise<void>;
}

async function cleanupAgentCollections(collections: AgentCollections): Promise<void> {
    const results = await Promise.allSettled([
        collections.definitions.cleanup(),
        collections.statuses.cleanup(),
    ]);
    const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
        throw new AggregateError(failures, "Agent collection cleanup failed");
    }
}

/**
 * Creates all normalized collections owned by one browser application runtime.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param trpcClient Browser-owned validated transport client.
 * @returns One stable registry that replaces feature collections at auth boundaries.
 */
export function createDashboardBrowserCollections(
    queryClient: QueryClient,
    trpcClient: DashboardTrpcClient
): DashboardBrowserCollections {
    let agents = createAgentCollections(queryClient, trpcClient);
    let cleaned = false;
    let pendingOperation = Promise.resolve();

    function enqueue(operation: () => Promise<void>): Promise<void> {
        const result = pendingOperation.then(operation);
        pendingOperation = result.catch(() => undefined);
        return result;
    }

    return Object.freeze({
        get agents() {
            return agents;
        },
        async cleanup(): Promise<void> {
            await enqueue(async () => {
                if (cleaned) return;
                cleaned = true;
                await cleanupAgentCollections(agents);
            });
        },
        async reset(): Promise<void> {
            await enqueue(async () => {
                if (cleaned) {
                    throw new TypeError("Dashboard collections are cleaned up");
                }
                const previousAgents = agents;
                try {
                    await cleanupAgentCollections(previousAgents);
                } finally {
                    agents = createAgentCollections(queryClient, trpcClient);
                }
            });
        },
    });
}
