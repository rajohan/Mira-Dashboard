import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import type { QueryClient } from "@tanstack/react-query";

import {
    type AgentStatus,
    agentDefinitionSchema,
    agentStatusSchema,
} from "../../contracts/agentModel.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { agentQueryKey } from "./agentQueries.ts";

/**
 * Creates the normalized agent directory and status collections for one browser runtime.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param trpcClient Browser-owned validated transport client.
 * @returns Query-backed TanStack DB collections with stable agent keys.
 */
export function createAgentCollections(
    queryClient: QueryClient,
    trpcClient: DashboardTrpcClient
) {
    const definitions = createCollection(
        queryCollectionOptions({
            getKey: (agent) => agent.id,
            queryClient,
            queryFn: async ({ signal }) => {
                const result = await trpcClient.query(
                    "agents.getConfiguration",
                    {},
                    { signal }
                );
                return result.agents.map((agent) => ({ ...agent }));
            },
            queryKey: [...agentQueryKey, "configuration"],
            schema: agentDefinitionSchema,
            staleTime: Number.POSITIVE_INFINITY,
        })
    );
    const statuses = createCollection(
        queryCollectionOptions({
            getKey: (status) => status.agentId,
            queryClient,
            queryFn: async ({ signal }) => {
                const result = await trpcClient.query(
                    "agents.listStatuses",
                    {},
                    { signal }
                );
                return result.statuses.map((status): AgentStatus => ({ ...status }));
            },
            queryKey: [...agentQueryKey, "statuses"],
            schema: agentStatusSchema,
            staleTime: 10_000,
        })
    );
    return Object.freeze({ definitions, statuses });
}

export type AgentCollections = ReturnType<typeof createAgentCollections>;
