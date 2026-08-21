import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import type { QueryClient } from "@tanstack/react-query";

import { notificationRecordSchema } from "../../contracts/monitoring.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { notificationLatestQueryKey } from "./notificationQueries.ts";

/**
 * Creates the normalized newest notification window for one browser runtime.
 * The collection `select` materializes rows while TanStack Query retains the full
 * list result, including global counts and the history cursor, under the exact key.
 * @param queryClient Browser-owned TanStack Query cache.
 * @param trpcClient Browser-owned validated transport client.
 * @returns Query-backed notification rows with stable UUID keys.
 */
export function createNotificationCollection(
    queryClient: QueryClient,
    trpcClient: DashboardTrpcClient
) {
    return createCollection(
        queryCollectionOptions({
            getKey: (notification) => notification.id,
            queryClient,
            queryFn: ({ signal }) =>
                trpcClient.query("notifications.list", { limit: 100 }, { signal }),
            queryKey: notificationLatestQueryKey,
            schema: notificationRecordSchema,
            select: (result) =>
                result.notifications.map((notification) => ({ ...notification })),
            staleTime: 10_000,
        })
    );
}

export type NotificationCollection = ReturnType<typeof createNotificationCollection>;
