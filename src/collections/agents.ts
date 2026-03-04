import { createCollection } from "@tanstack/react-db";

import type { AgentInfo } from "../types/session";

export const agentsCollection = createCollection<AgentInfo>({
    getKey: (item) => item.id,
    sync: {
        sync: () => {},
    },
    startSync: true,
});

export function writeAgentsFromWebSocket(agents: AgentInfo[]) {
    agentsCollection.utils.writeBatch(() => {
        for (const agent of agents) {
            agentsCollection.utils.writeUpsert(agent);
        }
    });
}
