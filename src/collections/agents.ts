import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { AgentInfo } from "../types/session";

/** Defines agents collection. */
export const agentsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["agents"],
        queryFn: async () => [],
        queryClient,
        staleTime: Number.POSITIVE_INFINITY,
        getKey: (item: AgentInfo) => item.id,
    })
);

void agentsCollection.preload();

/** Performs write agents from WebSocket. */
export function writeAgentsFromWebSocket(agents: AgentInfo[]) {
    if (!agentsCollection.isReady()) {
        return;
    }

    for (const agent of agents) {
        agentsCollection.utils.writeUpsert(
            agent as unknown as Partial<Record<string, unknown>>
        );
    }
}
