import {
    infiniteQueryOptions,
    type InfiniteData,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronFreshness,
    OpenClawCronJob,
    OpenClawCronRun,
} from "../../contracts/openClawCron.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Stable cache root shared by bounded OpenClaw cron inventory, detail, and history. */
export const openClawCronQueryKey = ["openclaw-cron"] as const;
export const openClawCronListQueryRoot = [...openClawCronQueryKey, "list"] as const;
export const openClawCronDetailQueryRoot = [...openClawCronQueryKey, "detail"] as const;
export const openClawCronRunsQueryRoot = [...openClawCronQueryKey, "runs"] as const;

/** Foreground cadence for Gateway freshness and expired-intent reconciliation. */
export const openClawCronRefreshIntervalMs = 10_000;

/** A browser may retain at most five individually validated provider pages. */
export const openClawCronBrowserPageMaximum = 5;

export const openClawCronInventoryInput = Object.freeze({
    enabled: "all" as const,
    lastRunStatus: "all" as const,
    limit: 100,
    offset: 0,
    scheduleKind: "all" as const,
    sortBy: "name" as const,
    sortDir: "asc" as const,
});

export const openClawCronListQueryKey = [
    ...openClawCronListQueryRoot,
    openClawCronInventoryInput,
] as const;

export interface OpenClawCronInventoryView {
    readonly freshness: OpenClawCronFreshness;
    readonly hasMore: boolean;
    readonly jobs: readonly OpenClawCronJob[];
    readonly snapshotRevision: string;
    readonly total: number;
}

export interface OpenClawCronRunsView {
    readonly freshness: OpenClawCronFreshness;
    readonly hasMore: boolean;
    readonly runs: readonly OpenClawCronRun[];
    readonly total: number;
}

export interface OpenClawCronPageAccumulation<TResult> {
    readonly result: TResult;
    /** False means later pages were discarded instead of mixing changing snapshots. */
    readonly stable: boolean;
}

function inventoryView(page: ListOpenClawCronResult): OpenClawCronInventoryView {
    return {
        freshness: page.freshness,
        hasMore: page.hasMore,
        jobs: page.jobs,
        snapshotRevision: page.snapshotRevision,
        total: page.total,
    };
}

function aggregateFreshness(
    pages: readonly Readonly<{ freshness: OpenClawCronFreshness }>[]
): OpenClawCronFreshness {
    const observedAtMs = Math.min(
        ...pages.map(({ freshness }) => freshness.observedAtMs)
    );
    const staleSinceValues = pages.flatMap(({ freshness }) =>
        freshness.kind === "last-known-good" ? [freshness.staleSinceMs] : []
    );
    if (staleSinceValues.length === 0) {
        return { kind: "fresh", observedAtMs };
    }
    return {
        kind: "last-known-good",
        observedAtMs,
        staleSinceMs: Math.min(...staleSinceValues),
    };
}

function everyRunHasStableIdentity(
    pages: readonly ListOpenClawCronRunsResult[]
): boolean {
    return pages.every((page) => page.runs.every(({ runId }) => runId !== undefined));
}

/**
 * Accumulates only a contiguous, single-revision inventory prefix. A changed
 * provider snapshot is never combined with rows from the previous revision.
 * @param pages Individually validated provider inventory pages.
 * @returns The stable prefix and whether every supplied page was accepted.
 */
export function accumulateOpenClawCronInventoryPages(
    pages: readonly ListOpenClawCronResult[]
): OpenClawCronPageAccumulation<OpenClawCronInventoryView> | undefined {
    const first = pages[0];
    if (first === undefined) return;
    const jobs: OpenClawCronJob[] = [];
    const ids = new Set<string>();
    const acceptedPages: ListOpenClawCronResult[] = [];
    let lastAccepted = first;
    let expectedOffset = 0;
    let stable = true;

    for (const page of pages.slice(0, openClawCronBrowserPageMaximum)) {
        const pageIsStable =
            page.snapshotRevision === first.snapshotRevision &&
            page.total === first.total &&
            page.offset === expectedOffset &&
            page.jobs.every(({ id }) => !ids.has(id));
        if (!pageIsStable) {
            stable = false;
            break;
        }
        for (const job of page.jobs) {
            ids.add(job.id);
            jobs.push(job);
        }
        acceptedPages.push(page);
        lastAccepted = page;
        expectedOffset += page.jobs.length;
    }

    return {
        result: {
            ...inventoryView(first),
            freshness: aggregateFreshness(acceptedPages),
            hasMore: lastAccepted.hasMore,
            jobs: Object.freeze(jobs),
        },
        stable,
    };
}

/**
 * Accumulates only a contiguous run-history prefix with one stable total. The
 * current Gateway protocol has no run snapshot revision, so offset/total drift
 * fences the loaded prefix and requires refresh before another page is shown.
 * @param pages Individually validated provider run-history pages.
 * @returns The stable prefix and whether every supplied page was accepted.
 */
export function accumulateOpenClawCronRunPages(
    pages: readonly ListOpenClawCronRunsResult[]
): OpenClawCronPageAccumulation<OpenClawCronRunsView> | undefined {
    const first = pages[0];
    if (first === undefined) return;
    const runs: OpenClawCronRun[] = [];
    const runIds = new Set<string>();
    const acceptedPages: ListOpenClawCronRunsResult[] = [];
    let lastAccepted = first;
    let expectedOffset = 0;
    let stable = true;

    for (const [pageIndex, page] of pages
        .slice(0, openClawCronBrowserPageMaximum)
        .entries()) {
        const candidateRunIds = page.runs.flatMap(({ runId }) =>
            runId === undefined ? [] : [runId]
        );
        const pageHasDuplicateIds =
            new Set(candidateRunIds).size !== candidateRunIds.length ||
            candidateRunIds.some((runId) => runIds.has(runId));
        const combiningWithoutStableIdentity =
            pageIndex > 0 &&
            (!everyRunHasStableIdentity(acceptedPages) ||
                page.runs.some(({ runId }) => runId === undefined));
        if (
            page.total !== first.total ||
            page.offset !== expectedOffset ||
            pageHasDuplicateIds ||
            combiningWithoutStableIdentity
        ) {
            stable = false;
            break;
        }
        for (const run of page.runs) {
            if (run.runId !== undefined) runIds.add(run.runId);
            runs.push(run);
        }
        acceptedPages.push(page);
        lastAccepted = page;
        expectedOffset += page.runs.length;
    }

    return {
        result: {
            freshness: aggregateFreshness(acceptedPages),
            hasMore: lastAccepted.hasMore,
            runs: Object.freeze(runs),
            total: first.total,
        },
        stable,
    };
}

/** @returns Bounded offset-paginated OpenClaw cron inventory query options. */
export function openClawCronListQueryOptions(client: DashboardTrpcClient) {
    return infiniteQueryOptions({
        initialPageParam: 0,
        queryFn: ({ pageParam, signal }): Promise<ListOpenClawCronResult> =>
            client.query(
                "openClawCron.list",
                { ...openClawCronInventoryInput, offset: pageParam },
                { signal }
            ),
        getNextPageParam: (lastPage, pages) =>
            pages.length >= openClawCronBrowserPageMaximum
                ? undefined
                : lastPage.nextOffset,
        queryKey: openClawCronListQueryKey,
        refetchInterval: openClawCronRefreshIntervalMs,
        retry: false,
        staleTime: openClawCronRefreshIntervalMs,
    });
}

/** @returns Bounded offset-paginated newest-first history for one selected job. */
export function openClawCronRunsQueryOptions(
    client: DashboardTrpcClient,
    id: string | undefined
) {
    return infiniteQueryOptions({
        enabled: id !== undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam, signal }): Promise<ListOpenClawCronRunsResult> => {
            if (id === undefined) {
                return Promise.reject(new Error("OpenClaw cron job is not selected"));
            }
            return client.query(
                "openClawCron.listRuns",
                {
                    id,
                    limit: 100,
                    offset: pageParam,
                    sortDir: "desc",
                },
                { signal }
            );
        },
        getNextPageParam: (lastPage, pages) =>
            pages.length >= openClawCronBrowserPageMaximum ||
            !everyRunHasStableIdentity(pages)
                ? undefined
                : lastPage.nextOffset,
        queryKey: [...openClawCronRunsQueryRoot, id ?? null],
        refetchInterval: openClawCronRefreshIntervalMs,
        retry: false,
        staleTime: openClawCronRefreshIntervalMs,
    });
}

/**
 * Invalidates all authoritative OpenClaw cron projections after one Gateway marker.
 * Existing query polling remains responsible for normal freshness and LKG recovery checks.
 * @param queryClient Browser-owned query cache.
 * @returns Completion after active OpenClaw cron observers have refreshed.
 */
export async function refreshOpenClawCronQueries(
    queryClient: QueryClient
): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: openClawCronQueryKey });
}

/**
 * Forces active authoritative projections to settle before an indeterminate
 * control may be attempted again. Unlike normal background invalidation, a
 * failed read is intentionally observable by the caller, and only a fresh
 * inventory observation newer than the pre-mutation boundary reconciles it.
 * @param queryClient Browser-owned query cache.
 * @param observationBoundaryMs Inventory observation captured before mutation dispatch.
 * @returns Whether a strictly newer authoritative inventory was observed.
 */
export async function reconcileOpenClawCronQueries(
    queryClient: QueryClient,
    observationBoundaryMs: number | undefined
): Promise<boolean> {
    if (observationBoundaryMs === undefined) return false;
    await queryClient.refetchQueries(
        { queryKey: openClawCronQueryKey, type: "active" },
        { throwOnError: true }
    );
    const inventory = queryClient.getQueryData<
        InfiniteData<ListOpenClawCronResult, number>
    >(openClawCronListQueryKey);
    const reconciled = accumulateOpenClawCronInventoryPages(inventory?.pages ?? []);
    return (
        reconciled !== undefined &&
        reconciled.result.freshness.kind === "fresh" &&
        reconciled.result.freshness.observedAtMs > observationBoundaryMs
    );
}
