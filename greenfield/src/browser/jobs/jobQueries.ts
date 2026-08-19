import {
    infiniteQueryOptions,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import type { JobRunEvent, ScheduleSummary } from "../../contracts/jobModel.ts";
import { jobRunEventPageMaximum } from "../../contracts/jobs.ts";
import type {
    GetJobRunInput,
    JobRunDetail,
    ListJobRunsInput,
    ListJobRunsResult,
} from "../../contracts/jobs.ts";
import type {
    ListScheduleRunsResult,
    ListSchedulesInput,
    ListSchedulesResult,
} from "../../contracts/schedules.ts";
import {
    liveHistoryArchiveQueryRoot,
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
} from "../api/liveHistory.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export type JobRunCursor = NonNullable<ListJobRunsInput["cursor"]>;
export type JobRunEventCursor = NonNullable<GetJobRunInput["eventCursor"]>;
export type ScheduleCursor = NonNullable<ListSchedulesInput["cursor"]>;

export const jobQueryKey = ["jobs"] as const;
export const jobRunQueryKey = [...jobQueryKey, "runs"] as const;
export const jobRunListQueryRoot = [...jobRunQueryKey, "list"] as const;
export const jobRunDetailQueryRoot = [...jobRunQueryKey, "detail"] as const;
export const jobRunEventHistoryQueryRoot = [...jobRunQueryKey, "events"] as const;
export const jobRunEventGapQueryRoot = [...jobRunEventHistoryQueryRoot, "gap"] as const;
export const jobQueueSummaryQueryKey = [...jobQueryKey, "queue-summary"] as const;
export const scheduleQueryKey = ["schedules"] as const;
export const scheduleListQueryRoot = [...scheduleQueryKey, "list"] as const;
export const scheduleDetailQueryRoot = [...scheduleQueryKey, "detail"] as const;
export const scheduleRunListQueryRoot = [...scheduleQueryKey, "runs"] as const;

/** Foreground refresh cadence for time-derived queue and live-worker summaries. */
export const jobQueueSummaryRefreshIntervalMs = 10_000;

/**
 * Removes repeated identities while preserving the first, newest-page occurrence.
 * @param rows Rows flattened from stable keyset pages.
 * @returns Rows with each durable identity represented once.
 */
export function uniqueJobRows<TRow extends { readonly id: string }>(
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
 * Removes repeated event sequences while preserving newest-page order.
 * @param events Events flattened from the exact detail and older pages.
 * @returns Events with each durable sequence represented once.
 */
export function uniqueJobRunEvents<TEvent extends { readonly sequence: number }>(
    events: readonly TEvent[]
): TEvent[] {
    const sequences = new Set<number>();
    return events.filter(({ sequence }) => {
        if (sequences.has(sequence)) return false;
        sequences.add(sequence);
        return true;
    });
}

/**
 * @param filters Server-owned run filters.
 * @returns Exact key for one filtered global run history.
 */
export function jobRunListQueryKey(filters: ListJobRunsInput["filters"]) {
    return [...jobRunListQueryRoot, filters ?? null] as const;
}

/**
 * @param id Durable run identity.
 * @returns Exact key for one durable run detail.
 */
export function jobRunDetailQueryKey(id: string) {
    return [...jobRunDetailQueryRoot, id] as const;
}

/**
 * @param id Durable run identity.
 * @returns Stable key for one run's immutable older-event history.
 */
export function jobRunEventHistoryQueryKey(id: string) {
    return [...jobRunEventHistoryQueryRoot, id] as const;
}

/**
 * @param id Durable run identity.
 * @param request Missing interval whose identity should scope the query.
 * @returns Stable key for transient gap repair within one run's immutable events.
 */
export function jobRunEventGapQueryKey(id: string, request?: JobRunEventGapRequest) {
    return [
        ...jobRunEventGapQueryRoot,
        id,
        ...(request === undefined
            ? []
            : [request.cursor.sequence, request.knownSequence]),
    ] as const;
}

/**
 * @param enabled Server-owned enabled-state filter.
 * @returns Exact key for one enabled-state schedule directory.
 */
export function scheduleListQueryKey(enabled: ListSchedulesInput["enabled"]) {
    return [...scheduleListQueryRoot, enabled] as const;
}

/**
 * @param id Code-owned schedule identity.
 * @returns Exact key for one code-owned schedule detail.
 */
export function scheduleDetailQueryKey(id: string) {
    return [...scheduleDetailQueryRoot, id] as const;
}

/**
 * @param id Code-owned schedule identity.
 * @returns Exact key for one schedule-scoped durable run history.
 */
export function scheduleRunListQueryKey(id: string) {
    return [...scheduleRunListQueryRoot, id] as const;
}

/** @returns Cursor-paginated global run history and queue-summary options. */
export function jobRunListQueryOptions(
    client: DashboardTrpcClient,
    filters: ListJobRunsInput["filters"]
) {
    return infiniteQueryOptions({
        initialPageParam: undefined as JobRunCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListJobRunsResult> =>
            client.query(
                "jobs.listRuns",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    ...(filters === undefined ? {} : { filters }),
                    limit: 100,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey(jobRunListQueryKey(filters)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Polling first-page projection for current global runs. */
export function jobRunLiveHeadQueryOptions(
    client: DashboardTrpcClient,
    filters: ListJobRunsInput["filters"]
) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListJobRunsResult> =>
            client.query(
                "jobs.listRuns",
                { ...(filters === undefined ? {} : { filters }), limit: 100 },
                { signal }
            ),
        queryKey: liveHistoryHeadQueryKey(jobRunListQueryKey(filters)),
        refetchInterval: jobQueueSummaryRefreshIntervalMs,
        staleTime: jobQueueSummaryRefreshIntervalMs,
    });
}

/**
 * Polls one bounded foreground snapshot so heartbeat-only worker expiry does not
 * refetch every materialized page in the infinite run history.
 * @returns Global queue and live-worker summary options.
 */
export function jobQueueSummaryQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListJobRunsResult> =>
            client.query("jobs.listRuns", { limit: 1 }, { signal }),
        queryKey: jobQueueSummaryQueryKey,
        refetchInterval: jobQueueSummaryRefreshIntervalMs,
        select: ({ summary }) => summary,
        staleTime: jobQueueSummaryRefreshIntervalMs,
    });
}

/** @returns Exact first-page run detail with bounded newest-first events. */
export function jobRunDetailQueryOptions(client: DashboardTrpcClient, id: string) {
    return queryOptions({
        queryFn: ({ signal }): Promise<JobRunDetail> =>
            client.query("jobs.getRun", { eventLimit: 100, id }, { signal }),
        queryKey: jobRunDetailQueryKey(id),
        staleTime: 0,
    });
}

/**
 * Defines older event pages independently from the exact detail cache. A failed
 * history request therefore cannot replace a successfully cached run detail.
 * @param client Validated browser tRPC client.
 * @param id Durable run identity.
 * @param firstCursor Cursor returned by the exact detail page.
 * @param enabled Whether the operator has requested older events.
 * @returns Cursor-paginated older event history options.
 */
export function jobRunEventHistoryQueryOptions(
    client: DashboardTrpcClient,
    id: string,
    firstCursor: JobRunEventCursor | undefined,
    enabled = true
) {
    return infiniteQueryOptions({
        enabled: enabled && firstCursor !== undefined,
        initialPageParam: firstCursor,
        queryFn: ({ pageParam, signal }): Promise<JobRunDetail> => {
            if (pageParam === undefined) {
                return Promise.reject(
                    new TypeError("Job event history requires a continuation cursor")
                );
            }
            return client.query(
                "jobs.getRun",
                { eventCursor: pageParam, eventLimit: 100, id },
                { signal }
            );
        },
        getNextPageParam: (lastPage) => lastPage.nextEventCursor,
        queryKey: jobRunEventHistoryQueryKey(id),
        staleTime: 10_000,
    });
}

/** One missing event interval bounded by a current cursor and a known older sequence. */
export interface JobRunEventGapRequest {
    readonly cursor: JobRunEventCursor;
    readonly knownSequence: number;
}

/** Immutable events fetched to bridge one realtime cursor jump. */
export interface JobRunEventGapResult {
    readonly events: JobRunEvent[];
    readonly request: JobRunEventGapRequest;
}

/**
 * Loads only the missing interval between a moved exact-page cursor and known history.
 * Each interval has its own key so React Query starts the next repair declaratively.
 * @param client Validated browser tRPC client.
 * @param id Durable run identity.
 * @param request Current gap bounds, or nothing before a gap is observed.
 * @returns Disabled query options invoked explicitly when exact detail advances.
 */
export function jobRunEventGapQueryOptions(
    client: DashboardTrpcClient,
    id: string,
    request: JobRunEventGapRequest | undefined
) {
    return queryOptions({
        enabled: request !== undefined,
        queryFn: async ({ signal }): Promise<JobRunEventGapResult> => {
            if (request === undefined) {
                throw new TypeError("Job event gap repair requires exact bounds");
            }
            const events: JobRunEvent[] = [];
            let cursor = request.cursor;
            while (cursor.sequence > request.knownSequence + 1) {
                const missingCount = cursor.sequence - request.knownSequence - 1;
                const page = await client.query(
                    "jobs.getRun",
                    {
                        eventCursor: cursor,
                        eventLimit: Math.min(jobRunEventPageMaximum, missingCount),
                        id,
                    },
                    { signal }
                );
                events.push(...page.events);
                const nextCursor = page.nextEventCursor;
                if (nextCursor === undefined) {
                    const oldestSequence = page.events.at(-1)?.sequence;
                    if (
                        oldestSequence === undefined ||
                        oldestSequence > request.knownSequence + 1
                    ) {
                        throw new TypeError(
                            "Job event gap ended before reaching known history"
                        );
                    }
                    break;
                }
                if (nextCursor.sequence >= cursor.sequence) {
                    throw new TypeError("Job event gap cursor did not advance");
                }
                if (nextCursor.sequence <= request.knownSequence + 1) break;
                cursor = nextCursor;
            }
            return {
                events: uniqueJobRunEvents(events),
                request,
            };
        },
        queryKey: jobRunEventGapQueryKey(id, request),
        staleTime: Number.POSITIVE_INFINITY,
        structuralSharing: (oldData, newData) => {
            const previous = oldData as JobRunEventGapResult | undefined;
            const current = newData as JobRunEventGapResult;
            if (previous === undefined) return current;
            return {
                ...current,
                events: uniqueJobRunEvents([
                    ...current.events,
                    ...previous.events,
                ]).toSorted((left, right) => right.sequence - left.sequence),
            };
        },
    });
}

/** @returns Cursor-paginated code-owned schedule directory options. */
export function scheduleListQueryOptions(
    client: DashboardTrpcClient,
    enabled: ListSchedulesInput["enabled"] = "all"
) {
    return infiniteQueryOptions({
        initialPageParam: undefined as ScheduleCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListSchedulesResult> =>
            client.query(
                "schedules.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    enabled,
                    limit: 100,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: scheduleListQueryKey(enabled),
        staleTime: 10_000,
    });
}

/** @returns Exact code-owned schedule detail options. */
export function scheduleDetailQueryOptions(client: DashboardTrpcClient, id: string) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ScheduleSummary> =>
            client.query("schedules.get", { id }, { signal }),
        queryKey: scheduleDetailQueryKey(id),
        staleTime: 0,
    });
}

/** @returns Cursor-paginated newest-first history for one schedule. */
export function scheduleRunListQueryOptions(client: DashboardTrpcClient, id: string) {
    return infiniteQueryOptions({
        initialPageParam: undefined as JobRunCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListScheduleRunsResult> =>
            client.query(
                "schedules.listRuns",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    id,
                    limit: 100,
                },
                { signal }
            ),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: liveHistoryArchiveQueryKey(scheduleRunListQueryKey(id)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** @returns Polling first-page projection for one schedule's current runs. */
export function scheduleRunLiveHeadQueryOptions(client: DashboardTrpcClient, id: string) {
    return queryOptions({
        queryFn: ({ signal }): Promise<ListScheduleRunsResult> =>
            client.query("schedules.listRuns", { id, limit: 100 }, { signal }),
        queryKey: liveHistoryHeadQueryKey(scheduleRunListQueryKey(id)),
        refetchInterval: jobQueueSummaryRefreshIntervalMs,
        staleTime: jobQueueSummaryRefreshIntervalMs,
    });
}

/** Invalidates every queue, global history, and exact run projection. */
export async function refreshJobQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
            (queryKey[0] === jobQueryKey[0] ||
                (queryKey[0] === liveHistoryArchiveQueryRoot[0] &&
                    queryKey[1] === jobQueryKey[0])) &&
            !jobRunEventHistoryQueryRoot.every(
                (segment, index) => queryKey[index] === segment
            ),
    });
}

/** Invalidates the schedule directory, details, and schedule-scoped histories. */
export async function refreshScheduleQueries(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
            queryKey[0] === scheduleQueryKey[0] ||
            (queryKey[0] === liveHistoryArchiveQueryRoot[0] &&
                queryKey[1] === scheduleQueryKey[0]),
    });
}

/** Invalidates projections shared by durable run and schedule mutations. */
export async function refreshJobAndScheduleQueries(
    queryClient: QueryClient
): Promise<void> {
    await Promise.all([
        refreshJobQueries(queryClient),
        refreshScheduleQueries(queryClient),
    ]);
}
