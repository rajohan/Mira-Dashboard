import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { AgentInfo } from "../types/session";

export const agentsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["agents"],
        queryFn: async () => [],
        queryClient,
        staleTime: Number.POSITIVE_INFINITY,
        getKey: (item: AgentInfo) => item.id,
    })
);

export function writeAgentFromWebSocket(agent: AgentInfo) {
    agentsCollection.utils.writeUpsert(agent);
}

export function writeAgentsFromWebSocket(agents: AgentInfo[]) {
    agentsCollection.utils.writeBatch(() => {
        for (const agent of agents) {
            agentsCollection.utils.writeUpsert(agent);
        }
    });
}
