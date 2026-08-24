import {
    infiniteQueryOptions,
    type InfiniteData,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ListNotificationsInput,
    ListNotificationsResult,
} from "../../contracts/notifications.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export type NotificationCursor = NonNullable<ListNotificationsInput["cursor"]>;

export const notificationQueryKey = ["monitoring", "notifications"] as const;
export const notificationLatestQueryKey = [...notificationQueryKey, "latest"] as const;
export const notificationHistoryQueryRoot = [...notificationQueryKey, "history"] as const;
export const notificationHistoryInactiveCacheMs = 5000;

/**
 * Removes repeated notification identities while preserving newest-page order.
 * @param rows Latest-window and history rows, in newest-first page order.
 * @returns Stable rows with the first occurrence of each identity.
 */
export function uniqueNotificationRows<TRow extends { readonly id: string }>(
    rows: readonly TRow[]
): TRow[] {
    const identities = new Set<string>();
    return rows.filter(({ id }) => {
        if (identities.has(id)) return false;
        identities.add(id);
        return true;
    });
}

/**
 * @param firstCursor Cursor after the named newest window.
 * @param filters Server-owned history filters.
 * @returns Exact cache key for one filtered history sequence.
 */
export function notificationHistoryQueryKey(
    firstCursor: NotificationCursor | undefined,
    filters: ListNotificationsInput["filters"]
) {
    return [
        ...notificationHistoryQueryRoot,
        firstCursor ?? null,
        filters ?? null,
    ] as const;
}

/**
 * @param client Validated browser tRPC client.
 * @returns The named newest notification window with authoritative global counts.
 */
export function notificationLatestQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListNotificationsResult> =>
            client.query("notifications.list", { limit: 100 }, { signal }),
        queryKey: notificationLatestQueryKey,
        staleTime: 10_000,
    });
}

/**
 * Defines one operator-selected, bounded history page. Inactive pages are
 * short-lived so paging remains memory-bounded without hiding rows.
 * @returns Query options for the exact selected history page.
 */
export function notificationHistoryQueryOptions(
    client: DashboardTrpcClient,
    firstCursor: NotificationCursor | undefined,
    filters: ListNotificationsInput["filters"]
) {
    return infiniteQueryOptions<
        ListNotificationsResult,
        Error,
        InfiniteData<ListNotificationsResult, NotificationCursor | undefined>,
        ReturnType<typeof notificationHistoryQueryKey>,
        NotificationCursor | undefined
    >({
        enabled: firstCursor !== undefined,
        gcTime: notificationHistoryInactiveCacheMs,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        initialPageParam: firstCursor,
        queryFn: ({ pageParam, signal }): Promise<ListNotificationsResult> => {
            if (pageParam === undefined) {
                return Promise.reject(
                    new TypeError("Notification history requires a continuation cursor")
                );
            }
            return client.query(
                "notifications.list",
                {
                    cursor: pageParam,
                    ...(filters === undefined ? {} : { filters }),
                    limit: 100,
                },
                { signal }
            );
        },
        queryKey: notificationHistoryQueryKey(firstCursor, filters),
        staleTime: 10_000,
    });
}

/** @returns One exact notification history page for focused contract tests. */
export function notificationHistoryPageQueryOptions(
    client: DashboardTrpcClient,
    cursor: NotificationCursor | undefined,
    filters: ListNotificationsInput["filters"],
    enabled: boolean
) {
    return queryOptions({
        enabled: enabled && cursor !== undefined,
        queryFn: ({ signal }): Promise<ListNotificationsResult> => {
            if (cursor === undefined) {
                return Promise.reject(
                    new TypeError("Notification history requires a continuation cursor")
                );
            }
            return client.query(
                "notifications.list",
                {
                    cursor,
                    ...(filters === undefined ? {} : { filters }),
                    limit: 100,
                },
                { signal }
            );
        },
        queryKey: notificationHistoryQueryKey(cursor, filters),
        staleTime: 10_000,
    });
}

/** Invalidates the complete notification projection without touching other monitoring data. */
export async function refreshNotificationQueries(
    queryClient: QueryClient
): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: notificationQueryKey });
}

/** Refreshes the authoritative newest window and any currently visible history. */
export async function refreshNotificationRealtimeQueries(
    queryClient: QueryClient
): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({
            exact: true,
            queryKey: notificationLatestQueryKey,
        }),
        queryClient.invalidateQueries({
            queryKey: notificationHistoryQueryRoot,
            refetchType: "active",
        }),
    ]);
}
