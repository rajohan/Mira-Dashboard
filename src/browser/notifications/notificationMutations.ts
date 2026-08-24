import { type InfiniteData, type QueryClient, useMutation } from "@tanstack/react-query";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import type {
    BulkNotificationInput,
    BulkNotificationResult,
    ListNotificationsResult,
} from "../../contracts/notifications.ts";
import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
    DashboardTrpcClient,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    notificationHistoryQueryRoot,
    notificationLatestQueryKey,
    notificationQueryKey,
    refreshNotificationQueries,
} from "./notificationQueries.ts";

export type NotificationBulkActionName =
    | "notifications.clearRead"
    | "notifications.markAllRead";

export const notificationBulkActionMaximumBatches = 32;
export const notificationMutationKey = [...notificationQueryKey, "mutation"] as const;

/** Aggregate result after all bounded server batches have completed. */
export interface NotificationBulkActionSummary {
    readonly affectedCount: number;
    readonly batchCount: number;
    readonly completedAtMs: number;
}

/** Defensive zero-progress continuation guard for nonstandard injected clients. */
export class NotificationBulkProtocolError extends Error {
    constructor() {
        super("Notification bulk action made no progress");
        this.name = "NotificationBulkProtocolError";
    }
}

/** Defensive client ceiling for a server stream that never reaches completion. */
export class NotificationBulkLimitError extends Error {
    constructor() {
        super("Notification bulk action exceeded its browser batch limit");
        this.name = "NotificationBulkLimitError";
    }
}

function refreshNotificationQueriesBestEffort(queryClient: QueryClient): void {
    void (async () => {
        try {
            await refreshNotificationQueries(queryClient);
        } catch {
            // Cache-first notification state remains authoritative until a later refresh.
        }
    })();
}

interface NotificationMutationExecutionOptions {
    readonly isActive?: () => boolean;
    readonly signal?: AbortSignal;
}

function assertNotificationMutationActive(
    options: NotificationMutationExecutionOptions
): void {
    if (options.signal?.aborted || options.isActive?.() === false) {
        throw new DOMException("Notification mutation was cancelled", "AbortError");
    }
}

function notificationHistoryPages(
    data: InfiniteData<ListNotificationsResult> | ListNotificationsResult | undefined
): readonly ListNotificationsResult[] {
    if (data === undefined) return [];
    return "pages" in data ? data.pages : [data];
}

function notificationFromHistoryCache(
    queryClient: QueryClient,
    id: string
): NotificationRecord | undefined {
    for (const [, data] of queryClient.getQueriesData<
        InfiniteData<ListNotificationsResult> | ListNotificationsResult
    >({ queryKey: notificationHistoryQueryRoot })) {
        const notification = notificationHistoryPages(data)
            .flatMap((page) => page.notifications)
            .find((candidate) => candidate.id === id);
        if (notification !== undefined) return notification;
    }
    return undefined;
}

function cachedNotification(
    queryClient: QueryClient,
    id: string
): NotificationRecord | undefined {
    const latest = queryClient.getQueryData<ListNotificationsResult>(
        notificationLatestQueryKey
    );
    return (
        latest?.notifications.find((candidate) => candidate.id === id) ??
        notificationFromHistoryCache(queryClient, id)
    );
}

function updateGlobalCounts(
    result: ListNotificationsResult,
    previous: NotificationRecord | undefined,
    operation: "delete" | "mark-read"
): Pick<ListNotificationsResult, "readCount" | "unreadCount"> {
    if (previous === undefined) {
        return { readCount: result.readCount, unreadCount: result.unreadCount };
    }
    if (operation === "delete") {
        return previous.readAtMs === undefined
            ? {
                  readCount: result.readCount,
                  unreadCount: Math.max(0, result.unreadCount - 1),
              }
            : {
                  readCount: Math.max(0, result.readCount - 1),
                  unreadCount: result.unreadCount,
              };
    }
    if (previous.readAtMs !== undefined) {
        return { readCount: result.readCount, unreadCount: result.unreadCount };
    }
    return {
        readCount: result.readCount + 1,
        unreadCount: Math.max(0, result.unreadCount - 1),
    };
}

function updateNotificationHistory(
    queryClient: QueryClient,
    update: (result: ListNotificationsResult) => ListNotificationsResult
): void {
    queryClient.setQueriesData<
        InfiniteData<ListNotificationsResult> | ListNotificationsResult
    >({ queryKey: notificationHistoryQueryRoot }, (data) => {
        if (data === undefined) return;
        return "pages" in data
            ? { ...data, pages: data.pages.map((page) => update(page)) }
            : update(data);
    });
}

/** Patches one known notification and global counts before its refresh can fail. */
export function patchNotificationInCachedQueries(
    queryClient: QueryClient,
    notification: NotificationRecord
): void {
    const previous = cachedNotification(queryClient, notification.id);
    const update = (result: ListNotificationsResult): ListNotificationsResult => ({
        ...result,
        ...updateGlobalCounts(result, previous, "mark-read"),
        notifications: result.notifications.map((candidate) =>
            candidate.id === notification.id ? notification : candidate
        ),
    });
    queryClient.setQueryData<ListNotificationsResult>(
        notificationLatestQueryKey,
        (result) => (result === undefined ? undefined : update(result))
    );
    updateNotificationHistory(queryClient, update);
}

/** Removes one known notification and adjusts global counts before refetch. */
export function removeNotificationFromCachedQueries(
    queryClient: QueryClient,
    id: string
): void {
    const previous = cachedNotification(queryClient, id);
    const update = (result: ListNotificationsResult): ListNotificationsResult => ({
        ...result,
        ...updateGlobalCounts(result, previous, "delete"),
        notifications: result.notifications.filter(
            (notification) => notification.id !== id
        ),
    });
    queryClient.setQueryData<ListNotificationsResult>(
        notificationLatestQueryKey,
        (result) => (result === undefined ? undefined : update(result))
    );
    updateNotificationHistory(queryClient, update);
}

/**
 * Repeats one bounded bulk mutation sequentially until the server reports completion.
 * The exact same filter input is retained for every batch.
 * @param client Validated browser tRPC client.
 * @param action Exact bounded bulk procedure.
 * @param input Stable server-owned filters reused for every batch.
 * @returns Aggregate affected count after every bounded batch completes.
 */
async function executeNotificationBatches(
    client: DashboardTrpcClient,
    action: NotificationBulkActionName,
    input: BulkNotificationInput,
    options: NotificationMutationExecutionOptions
): Promise<NotificationBulkActionSummary> {
    let affectedCount = 0;
    let batchCount = 0;
    while (true) {
        assertNotificationMutationActive(options);
        const result: BulkNotificationResult = await client.mutation(action, input, {
            signal: options.signal,
        });
        assertNotificationMutationActive(options);
        affectedCount += result.affectedCount;
        batchCount += 1;
        if (!result.remaining) {
            return {
                affectedCount,
                batchCount,
                completedAtMs: result.completedAtMs,
            };
        }
        if (result.affectedCount === 0) throw new NotificationBulkProtocolError();
        if (batchCount >= notificationBulkActionMaximumBatches) {
            throw new NotificationBulkLimitError();
        }
    }
}

/**
 * Executes and refreshes one complete bulk action without masking an action failure.
 * @param client Validated browser tRPC client.
 * @param queryClient Browser cache invalidated after success or partial failure.
 * @param action Exact bounded bulk procedure.
 * @param input Stable server-owned filters reused for every batch.
 * @returns Aggregate affected count after every bounded batch completes.
 */
export async function executeBulkNotificationAction(
    client: DashboardTrpcClient,
    queryClient: QueryClient,
    action: NotificationBulkActionName,
    input: BulkNotificationInput,
    options: NotificationMutationExecutionOptions = {}
): Promise<NotificationBulkActionSummary> {
    let summary: NotificationBulkActionSummary;
    try {
        summary = await executeNotificationBatches(client, action, input, options);
    } catch (error) {
        if (options.isActive?.() !== false && !options.signal?.aborted) {
            await refreshNotificationQueries(queryClient).catch(() => {});
        }
        throw error;
    }
    assertNotificationMutationActive(options);
    await refreshNotificationQueries(queryClient);
    assertNotificationMutationActive(options);
    return summary;
}

/** @returns Exact idempotent mark-read mutation with cache-first state repair. */
export function useMarkNotificationReadMutation() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"notifications.markRead">,
        Error,
        DashboardProcedureInput<"notifications.markRead">
    >({
        mutationKey: notificationMutationKey,
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("notifications.markRead", input, { signal })
            ),
        onError: (error, input) => {
            if (
                !boundary.completionIsCurrent() ||
                classifyDashboardBrowserFailure(error) !== "not-found"
            ) {
                return;
            }
            removeNotificationFromCachedQueries(boundary.queryClient, input.id);
            refreshNotificationQueriesBestEffort(boundary.queryClient);
        },
        onSuccess: (notification) => {
            if (!boundary.completionIsCurrent()) return;
            patchNotificationInCachedQueries(boundary.queryClient, notification);
            void refreshNotificationQueries(boundary.queryClient).catch(() => {});
        },
    });
}

/** @returns Exact notification deletion with cache-first row removal. */
export function useDeleteNotificationMutation() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"notifications.delete">,
        Error,
        DashboardProcedureInput<"notifications.delete">
    >({
        mutationKey: notificationMutationKey,
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("notifications.delete", input, { signal })
            ),
        onError: (error, input) => {
            if (
                !boundary.completionIsCurrent() ||
                classifyDashboardBrowserFailure(error) !== "not-found"
            ) {
                return;
            }
            removeNotificationFromCachedQueries(boundary.queryClient, input.id);
            refreshNotificationQueriesBestEffort(boundary.queryClient);
        },
        onSuccess: (result) => {
            if (!boundary.completionIsCurrent()) return;
            removeNotificationFromCachedQueries(boundary.queryClient, result.id);
            void refreshNotificationQueries(boundary.queryClient).catch(() => {});
        },
    });
}

function useBulkNotificationMutation(action: NotificationBulkActionName) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<NotificationBulkActionSummary, Error, BulkNotificationInput>({
        mutationKey: notificationMutationKey,
        mutationFn: (input) =>
            boundary.run((signal, isActive) =>
                executeBulkNotificationAction(
                    client,
                    boundary.queryClient,
                    action,
                    input,
                    { isActive, signal }
                )
            ),
    });
}

/** @returns Sequential bounded mark-all-read mutation. */
export function useMarkAllNotificationsReadMutation() {
    return useBulkNotificationMutation("notifications.markAllRead");
}

/** @returns Sequential bounded clear-read mutation. */
export function useClearReadNotificationsMutation() {
    return useBulkNotificationMutation("notifications.clearRead");
}
