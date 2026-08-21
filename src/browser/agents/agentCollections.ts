import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import type { QueryClient } from "@tanstack/react-query";

import {
    type AgentStatusProjection,
    agentDefinitionSchema,
    agentStatusProjectionSchema,
} from "../../contracts/agentModel.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { agentConfigurationQueryKey, agentStatusesQueryKey } from "./agentQueries.ts";

/** Foreground repair interval for lossy targeted Gateway session markers. */
export const agentStatusRefreshIntervalMs = 10_000;

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
            queryKey: agentConfigurationQueryKey,
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
                return result.statuses.map((status): AgentStatusProjection => ({
                    ...status,
                }));
            },
            queryKey: agentStatusesQueryKey,
            refetchInterval: agentStatusRefreshIntervalMs,
            schema: agentStatusProjectionSchema,
            staleTime: agentStatusRefreshIntervalMs,
        })
    );
    return Object.freeze({ definitions, statuses });
}

export type AgentCollections = ReturnType<typeof createAgentCollections>;
