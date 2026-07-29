import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { type GatewayAgentInfo, parseGatewayAgentInfos } from "../../../contracts/agents";
import { queryClient } from "../lib/queryClient";

/** Defines agents collection. */
export const agentsCollection = createCollection(
    queryCollectionOptions({
        id: "agents",
        queryKey: ["agents"],
        queryFn: () => Promise.resolve([]),
        queryClient,
        staleTime: Infinity,
        getKey: (item: GatewayAgentInfo) => item.id,
    })
);

/** Starts the agents collection query. */
export function preloadAgentsCollection() {
    void agentsCollection.preload();
}

/**
 * Performs write agents from WebSocket.
 * @param agents Agents value.
 */
export function writeAgentsFromWebSocket(agents: unknown) {
    if (!agentsCollection.isReady()) {
        return;
    }

    let writableAgents: GatewayAgentInfo[];
    try {
        writableAgents = parseGatewayAgentInfos(agents);
    } catch {
        return;
    }

    for (const agent of writableAgents) {
        agentsCollection.utils.writeUpsert(agent);
    }
}
