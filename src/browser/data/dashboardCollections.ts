import type { QueryClient } from "@tanstack/react-query";

import {
    createAgentCollections,
    type AgentCollections,
} from "../agents/agentCollections.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    createNotificationCollection,
    type NotificationCollection,
} from "../notifications/notificationCollection.ts";

/** Browser-owned normalized collections and their explicit lifetime/reset boundaries. */
export interface DashboardBrowserCollections {
    readonly agents: AgentCollections;
    readonly notifications: NotificationCollection;
    readonly cleanup: () => Promise<void>;
    readonly reset: () => Promise<void>;
}

async function cleanupCollections(
    agents: AgentCollections,
    notifications: NotificationCollection
): Promise<void> {
    const results = await Promise.allSettled([
        agents.definitions.cleanup(),
        agents.statuses.cleanup(),
        notifications.cleanup(),
    ]);
    const failures: unknown[] = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : []
    );
    if (failures.length > 0) {
        throw new AggregateError(failures, "Dashboard collection cleanup failed");
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
    let notifications = createNotificationCollection(queryClient, trpcClient);
    let cleaned = false;
    let pendingOperation = Promise.resolve();

    function enqueue(operation: () => Promise<void>): Promise<void> {
        const result = pendingOperation.then(operation);
        pendingOperation = result.catch(() => {});
        return result;
    }

    return Object.freeze({
        get agents() {
            return agents;
        },
        get notifications() {
            return notifications;
        },
        async cleanup(): Promise<void> {
            await enqueue(async () => {
                if (cleaned) return;
                cleaned = true;
                await cleanupCollections(agents, notifications);
            });
        },
        async reset(): Promise<void> {
            await enqueue(async () => {
                if (cleaned) {
                    throw new TypeError("Dashboard collections are cleaned up");
                }
                const previousAgents = agents;
                const previousNotifications = notifications;
                try {
                    await cleanupCollections(previousAgents, previousNotifications);
                } finally {
                    agents = createAgentCollections(queryClient, trpcClient);
                    notifications = createNotificationCollection(queryClient, trpcClient);
                }
            });
        },
    });
}
