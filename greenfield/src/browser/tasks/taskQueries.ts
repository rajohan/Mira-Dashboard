import {
    infiniteQueryOptions,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ListTaskLabelsResult,
    ListTaskProgressInput,
    ListTaskProgressResult,
    ListTasksInput,
    ListTasksResult,
} from "../../contracts/tasks.ts";
import {
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
} from "../api/liveHistory.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

type TaskCursor = NonNullable<ListTasksInput["cursor"]>;
type TaskProgressCursor = NonNullable<ListTaskProgressInput["cursor"]>;

export const taskQueryKey = ["tasks"] as const;
export const taskListQueryRoot = [...taskQueryKey, "list"] as const;
export const taskLabelSuggestionsQueryKey = [...taskListQueryRoot, "labels"] as const;
export const taskOverviewQueryKey = [...taskListQueryRoot, "overview"] as const;

/** Bounded unfinished-task window rendered on the operational overview. */
export const taskOverviewPageSize = 100;

const taskOverviewFilters = Object.freeze({
    statuses: ["blocked", "in-progress", "todo"],
} as const satisfies NonNullable<ListTasksInput["filters"]>);

/**
 * @param filters Canonical task filters.
 * @returns Stable key for one server-filtered task collection.
 */
export function taskListQueryKey(filters: ListTasksInput["filters"]) {
    return [...taskQueryKey, "list", filters ?? null] as const;
}

/**
 * @param taskId Stable task identity.
 * @returns Stable key for one task detail.
 */
export function taskDetailQueryKey(taskId: string) {
    return [...taskQueryKey, "detail", taskId] as const;
}

/**
 * @param taskId Stable task identity.
 * @returns Stable key for one task's progress history.
 */
export function taskProgressQueryKey(taskId: string) {
    return [...taskQueryKey, "progress", taskId] as const;
}

/** @returns Cursor-paginated task-list query options. */
export function taskListQueryOptions(
    client: DashboardTrpcClient,
    filters: ListTasksInput["filters"]
) {
    return infiniteQueryOptions({
        initialPageParam: undefined as TaskCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListTasksResult> =>
            client.query(
                "tasks.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    ...(filters === undefined ? {} : { filters }),
                    limit: 100,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: taskListQueryKey(filters),
        staleTime: 10_000,
    });
}

/** @returns Bounded persisted task-label suggestion catalog options. */
export function taskLabelSuggestionsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListTaskLabelsResult> =>
            client.query("tasks.listLabels", {}, { signal }),
        queryKey: taskLabelSuggestionsQueryKey,
        staleTime: 10_000,
    });
}

/**
 * Loads one independent newest-unfinished-task window so root refreshes cannot
 * widen to every paginated task-board page.
 * @returns Bounded unfinished-task overview options.
 */
export function taskOverviewQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListTasksResult> =>
            client.query(
                "tasks.list",
                { filters: taskOverviewFilters, limit: taskOverviewPageSize },
                { signal }
            ),
        queryKey: taskOverviewQueryKey,
        staleTime: 10_000,
    });
}

/** @returns Exact task-detail query options. */
export function taskDetailQueryOptions(client: DashboardTrpcClient, taskId: string) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("tasks.get", { id: taskId }, { signal }),
        queryKey: taskDetailQueryKey(taskId),
        staleTime: 0,
    });
}

/** @returns Cursor-paginated task-progress query options. */
export function taskProgressQueryOptions(client: DashboardTrpcClient, taskId: string) {
    return infiniteQueryOptions({
        initialPageParam: undefined as TaskProgressCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListTaskProgressResult> =>
            client.query(
                "tasks.listUpdates",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    limit: 50,
                    taskId,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey(taskProgressQueryKey(taskId)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Live first-page projection for one task's newest progress updates. */
export function taskProgressLiveHeadQueryOptions(
    client: DashboardTrpcClient,
    taskId: string
) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListTaskProgressResult> =>
            client.query("tasks.listUpdates", { limit: 50, taskId }, { signal }),
        queryKey: liveHistoryHeadQueryKey(taskProgressQueryKey(taskId)),
        staleTime: 0,
    });
}

/**
 * Invalidates every task projection after one committed mutation.
 * @param queryClient Browser-owned query cache.
 * @returns Completion after active task observers have refreshed.
 */
export async function refreshTaskQueries(queryClient: QueryClient): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: taskQueryKey }),
        queryClient.invalidateQueries({
            queryKey: liveHistoryArchiveQueryKey(taskQueryKey),
        }),
    ]);
}

/**
 * Invalidates only task collections after deleting a detail resource.
 * @param queryClient Browser-owned query cache.
 * @returns Completion after active task lists have refreshed.
 */
export async function refreshTaskLists(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: taskListQueryRoot });
}
