import { type InfiniteData, type QueryClient, useMutation } from "@tanstack/react-query";

import type {
    JobRunSummary,
    JobWorkerControl,
    ScheduleSummary,
} from "../../contracts/jobModel.ts";
import type { JobRunDetail, ListJobRunsResult } from "../../contracts/jobs.ts";
import type {
    ListScheduleRunsResult,
    ListSchedulesInput,
    ListSchedulesResult,
} from "../../contracts/schedules.ts";
import {
    liveHistoryArchiveQueryKey,
    liveHistoryArchiveQueryRoot,
    liveHistoryHeadQueryKey,
} from "../api/liveHistory.ts";
import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import { authenticatedBrowserCacheGeneration } from "../auth/authQueries.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { useOperationTracker } from "../operations/operationTrackerContextValue.ts";
import {
    jobRunDetailQueryKey,
    jobRunEventGapQueryKey,
    jobRunEventHistoryQueryRoot,
    jobRunListQueryRoot,
    jobQueueSummaryQueryKey,
    refreshJobAndScheduleQueries,
    refreshJobQueries,
    scheduleDetailQueryKey,
    scheduleDetailQueryRoot,
    scheduleListQueryRoot,
    scheduleRunListQueryKey,
    scheduleRunListQueryRoot,
} from "./jobQueries.ts";

type JobRunListData = InfiniteData<ListJobRunsResult>;
type JobRunEventHistoryData = InfiniteData<JobRunDetail>;
type ScheduleListData = InfiniteData<ListSchedulesResult>;
type ScheduleRunListData = InfiniteData<ListScheduleRunsResult>;
type JobRunFilters = DashboardProcedureInput<"jobs.listRuns">["filters"];
type ScheduleEnabledFilter = ListSchedulesInput["enabled"];

export const jobMutationKey = ["jobs", "mutation"] as const;

interface PendingScheduleRunKeys {
    readonly cacheGeneration: number;
    readonly keys: Map<string, string>;
}

const pendingScheduleRunKeys = new WeakMap<QueryClient, PendingScheduleRunKeys>();

function archiveQueryMatches(
    queryKey: readonly unknown[],
    featureRoot: readonly unknown[]
): boolean {
    return (
        queryKey[0] === liveHistoryArchiveQueryRoot[0] &&
        featureRoot.every((part, index) => queryKey[index + 1] === part)
    );
}

function scheduleRunKeysForCurrentCache(queryClient: QueryClient): Map<string, string> {
    const cacheGeneration = authenticatedBrowserCacheGeneration(queryClient);
    const current = pendingScheduleRunKeys.get(queryClient);
    if (current?.cacheGeneration === cacheGeneration) return current.keys;
    const keys = new Map<string, string>();
    pendingScheduleRunKeys.set(queryClient, { cacheGeneration, keys });
    return keys;
}

function refreshBestEffort(refresh: () => Promise<void>): void {
    void refresh().catch(() => {
        // Cache-first mutation results remain visible until a later refresh succeeds.
    });
}

function runMatchesFilters(run: JobRunSummary, filters: JobRunFilters): boolean {
    return (
        (filters?.resourceClasses === undefined ||
            filters.resourceClasses.includes(run.resourceClass)) &&
        (filters?.scheduleId === undefined ||
            filters.scheduleId === run.scheduledJobId) &&
        (filters?.states === undefined || filters.states.includes(run.state)) &&
        (filters?.triggerTypes === undefined ||
            filters.triggerTypes.includes(run.triggerType))
    );
}

function scheduleMatchesFilter(
    schedule: ScheduleSummary,
    enabled: ScheduleEnabledFilter
): boolean {
    return (
        enabled === "all" ||
        (enabled === "enabled" && schedule.enabled) ||
        (enabled === "disabled" && !schedule.enabled)
    );
}

function jobRunSnapshotIsNotOlder(
    candidate: JobRunSummary,
    current: JobRunSummary
): boolean {
    return (
        candidate.id === current.id &&
        candidate.stateVersion >= current.stateVersion &&
        candidate.eventCount >= current.eventCount &&
        candidate.updatedAtMs >= current.updatedAtMs
    );
}

function currentJobRunSnapshot(
    current: JobRunSummary,
    candidate: JobRunSummary
): JobRunSummary {
    return jobRunSnapshotIsNotOlder(candidate, current) ? candidate : current;
}

function jobRunIsActive(run: JobRunSummary): boolean {
    return run.state === "queued" || run.state === "running";
}

function jobRunIsNewer(left: JobRunSummary, right: JobRunSummary): boolean {
    return (
        left.queuedAtMs > right.queuedAtMs ||
        (left.queuedAtMs === right.queuedAtMs && left.id > right.id)
    );
}

function mergeJobRuns(runs: readonly (JobRunSummary | undefined)[]): JobRunSummary[] {
    const merged = new Map<string, JobRunSummary>();
    for (const run of runs) {
        if (run === undefined) continue;
        const current = merged.get(run.id);
        merged.set(
            run.id,
            current === undefined ? run : currentJobRunSnapshot(current, run)
        );
    }
    return [...merged.values()];
}

function mergeScheduleRunRelations(
    schedule: ScheduleSummary,
    runs: readonly (JobRunSummary | undefined)[]
): ScheduleSummary {
    const relatedRuns = mergeJobRuns([
        schedule.activeRun,
        schedule.latestRun,
        ...runs,
    ]).toSorted((left, right) => {
        if (jobRunIsNewer(left, right)) return -1;
        if (jobRunIsNewer(right, left)) return 1;
        return 0;
    });
    const latestRun = relatedRuns[0];
    const activeRun =
        latestRun !== undefined && jobRunIsActive(latestRun) ? latestRun : undefined;
    const {
        activeRun: _previousActiveRun,
        latestRun: _previousLatestRun,
        ...withoutRunRelations
    } = schedule;
    return {
        ...withoutRunRelations,
        ...(activeRun === undefined ? {} : { activeRun }),
        ...(latestRun === undefined ? {} : { latestRun }),
    };
}

function scheduleSnapshotIsNotOlder(
    candidate: ScheduleSummary,
    current: ScheduleSummary
): boolean {
    if (
        candidate.version < current.version ||
        candidate.updatedAtMs < current.updatedAtMs
    ) {
        return false;
    }
    if (
        candidate.version !== current.version ||
        candidate.updatedAtMs !== current.updatedAtMs
    ) {
        return true;
    }
    if (
        candidate.enabled !== current.enabled ||
        candidate.nextRunAtMs === undefined ||
        current.nextRunAtMs === undefined
    ) {
        return (
            candidate.enabled === current.enabled &&
            candidate.nextRunAtMs === current.nextRunAtMs
        );
    }
    return candidate.nextRunAtMs >= current.nextRunAtMs;
}

function mergeScheduleSnapshots(
    current: ScheduleSummary,
    candidate: ScheduleSummary
): ScheduleSummary {
    const base = scheduleSnapshotIsNotOlder(candidate, current) ? candidate : current;
    return mergeScheduleRunRelations(base, [
        current.activeRun,
        current.latestRun,
        candidate.activeRun,
        candidate.latestRun,
    ]);
}

function currentJobWorkerControl(
    current: JobWorkerControl,
    candidate: JobWorkerControl
): JobWorkerControl {
    return candidate.version >= current.version ? candidate : current;
}

function patchRunInBoundedSnapshot(
    result: ListJobRunsResult,
    run: JobRunSummary
): ListJobRunsResult {
    // Aggregate fields form one server-owned snapshot. A bounded row projection
    // cannot safely reconstruct workers, resource classes, or the oldest queued run.
    if (!result.runs.some((candidate) => candidate.id === run.id)) return result;
    return {
        ...result,
        runs: result.runs.map((candidate) =>
            candidate.id === run.id ? currentJobRunSnapshot(candidate, run) : candidate
        ),
    };
}

function patchLiveRunRows(
    rows: readonly JobRunSummary[],
    run: JobRunSummary,
    includeNew: boolean
): JobRunSummary[] {
    const existing = rows.find((candidate) => candidate.id === run.id);
    if (existing === undefined) {
        return includeNew ? [run, ...rows] : [...rows];
    }
    return rows.map((candidate) =>
        candidate.id === run.id ? currentJobRunSnapshot(candidate, run) : candidate
    );
}

function patchRunInLiveSnapshot(
    result: ListJobRunsResult,
    run: JobRunSummary,
    includeNew: boolean
): ListJobRunsResult {
    return { ...result, runs: patchLiveRunRows(result.runs, run, includeNew) };
}

function patchRunPages<TPage extends { readonly runs: JobRunSummary[] }>(
    data: InfiniteData<TPage>,
    run: JobRunSummary,
    includesRun: (candidate: JobRunSummary) => boolean
): InfiniteData<TPage> {
    const matchingRuns = data.pages.flatMap((page) =>
        page.runs.filter((candidate) => candidate.id === run.id)
    );
    const firstMaterializedRun = matchingRuns[0];
    if (firstMaterializedRun === undefined) return data;
    let materializedRun = firstMaterializedRun;
    for (const candidate of matchingRuns.slice(1)) {
        materializedRun = currentJobRunSnapshot(materializedRun, candidate);
    }
    const currentRun = currentJobRunSnapshot(materializedRun, run);
    const include = includesRun(currentRun);
    let replaced = false;
    const pages = data.pages.map((page) => ({
        ...page,
        runs: page.runs.flatMap((candidate) => {
            if (candidate.id !== run.id) return [candidate];
            if (replaced || !include) return [];
            replaced = true;
            return [currentRun];
        }),
    }));
    return { ...data, pages };
}

function patchJobRunDetail(detail: JobRunDetail, run: JobRunSummary): JobRunDetail {
    const currentRun = currentJobRunSnapshot(detail.run, run);
    if (currentRun === detail.run) return detail;
    if (currentRun.state === "succeeded" && detail.result === undefined) return detail;
    return { ...detail, run: currentRun };
}

function removeRunFromPages<TPage extends { readonly runs: JobRunSummary[] }>(
    data: InfiniteData<TPage>,
    id: string
): InfiniteData<TPage> {
    return {
        ...data,
        pages: data.pages.map((page) => ({
            ...page,
            runs: page.runs.filter((run) => run.id !== id),
        })),
    };
}

function patchScheduleRunReferences(
    schedule: ScheduleSummary,
    run: JobRunSummary,
    newRun: boolean
): ScheduleSummary {
    if (run.scheduledJobId !== schedule.id) return schedule;
    if (
        !newRun &&
        schedule.activeRun?.id !== run.id &&
        schedule.latestRun?.id !== run.id
    ) {
        return schedule;
    }
    return mergeScheduleRunRelations(schedule, [run]);
}

function patchScheduleProjectionsForRun(
    queryClient: QueryClient,
    run: JobRunSummary,
    newRun: boolean
): void {
    if (run.scheduledJobId === undefined) return;
    queryClient.setQueryData<ScheduleSummary>(
        scheduleDetailQueryKey(run.scheduledJobId),
        (schedule) =>
            schedule === undefined
                ? undefined
                : patchScheduleRunReferences(schedule, run, newRun)
    );
    queryClient.setQueriesData<ScheduleListData>(
        { queryKey: scheduleListQueryRoot },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => ({
                          ...page,
                          schedules: page.schedules.map((schedule) =>
                              patchScheduleRunReferences(schedule, run, newRun)
                          ),
                      })),
                  }
    );
}

/** Patches one validated run only where that identity is already materialized. */
export function patchJobRunInCachedQueries(
    queryClient: QueryClient,
    run: JobRunSummary,
    newRun = false
): void {
    for (const [queryKey, data] of queryClient.getQueriesData<ListJobRunsResult>({
        queryKey: jobRunListQueryRoot,
    })) {
        if (data === undefined || queryKey.at(-1) !== "live-head") continue;
        const filters = queryKey[jobRunListQueryRoot.length] as JobRunFilters | null;
        queryClient.setQueryData<ListJobRunsResult>(
            queryKey,
            patchRunInLiveSnapshot(
                data,
                run,
                newRun && runMatchesFilters(run, filters ?? undefined)
            )
        );
    }
    for (const [queryKey, data] of queryClient.getQueriesData<JobRunListData>({
        predicate: ({ queryKey }) => archiveQueryMatches(queryKey, jobRunListQueryRoot),
    })) {
        if (data === undefined) continue;
        const filters = queryKey[1 + jobRunListQueryRoot.length] as JobRunFilters | null;
        const patched = patchRunPages(data, run, (candidate) =>
            runMatchesFilters(candidate, filters ?? undefined)
        );
        queryClient.setQueryData<JobRunListData>(queryKey, patched);
    }
    queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, (result) =>
        result === undefined ? undefined : patchRunInBoundedSnapshot(result, run)
    );
    queryClient.setQueryData<JobRunDetail>(jobRunDetailQueryKey(run.id), (detail) =>
        detail === undefined ? undefined : patchJobRunDetail(detail, run)
    );
    queryClient.setQueriesData<JobRunEventHistoryData>(
        { queryKey: [...jobRunEventHistoryQueryRoot, run.id] },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => patchJobRunDetail(page, run)),
                  }
    );
    if (run.scheduledJobId !== undefined) {
        queryClient.setQueryData<ListScheduleRunsResult>(
            liveHistoryHeadQueryKey(scheduleRunListQueryKey(run.scheduledJobId)),
            (data) =>
                data === undefined
                    ? undefined
                    : {
                          ...data,
                          runs: patchLiveRunRows(data.runs, run, newRun),
                      }
        );
        queryClient.setQueryData<ScheduleRunListData>(
            liveHistoryArchiveQueryKey(scheduleRunListQueryKey(run.scheduledJobId)),
            (data) =>
                data === undefined ? undefined : patchRunPages(data, run, () => true)
        );
    }
    patchScheduleProjectionsForRun(queryClient, run, newRun);
}

/** Removes one server-missing run from cached histories, details, and schedule links. */
export function removeJobRunFromCachedQueries(
    queryClient: QueryClient,
    id: string
): void {
    queryClient.setQueriesData<JobRunListData>(
        {
            predicate: ({ queryKey }) =>
                archiveQueryMatches(queryKey, jobRunListQueryRoot),
        },
        (data) => (data === undefined ? undefined : removeRunFromPages(data, id))
    );
    queryClient.setQueriesData<ListJobRunsResult>(
        {
            predicate: ({ queryKey }) =>
                jobRunListQueryRoot.every((part, index) => queryKey[index] === part) &&
                queryKey.at(-1) === "live-head",
        },
        (data) =>
            data === undefined
                ? undefined
                : { ...data, runs: data.runs.filter((run) => run.id !== id) }
    );
    queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, (result) =>
        result === undefined
            ? undefined
            : {
                  ...result,
                  runs: result.runs.filter((run) => run.id !== id),
              }
    );
    queryClient.setQueriesData<ScheduleRunListData>(
        {
            predicate: ({ queryKey }) =>
                archiveQueryMatches(queryKey, scheduleRunListQueryRoot),
        },
        (data) => (data === undefined ? undefined : removeRunFromPages(data, id))
    );
    queryClient.setQueriesData<ListScheduleRunsResult>(
        {
            predicate: ({ queryKey }) =>
                scheduleRunListQueryRoot.every(
                    (part, index) => queryKey[index] === part
                ) && queryKey.at(-1) === "live-head",
        },
        (data) =>
            data === undefined
                ? undefined
                : { ...data, runs: data.runs.filter((run) => run.id !== id) }
    );
    queryClient.removeQueries({ exact: true, queryKey: jobRunDetailQueryKey(id) });
    queryClient.removeQueries({ queryKey: [...jobRunEventHistoryQueryRoot, id] });
    queryClient.removeQueries({ queryKey: jobRunEventGapQueryKey(id) });
    const removeScheduleReference = (schedule: ScheduleSummary): ScheduleSummary => {
        const {
            activeRun: previousActiveRun,
            latestRun: previousLatestRun,
            ...withoutRunReferences
        } = schedule;
        const activeRun = previousActiveRun?.id === id ? undefined : previousActiveRun;
        const latestRun = previousLatestRun?.id === id ? undefined : previousLatestRun;
        return {
            ...withoutRunReferences,
            ...(activeRun === undefined ? {} : { activeRun }),
            ...(latestRun === undefined ? {} : { latestRun }),
        };
    };
    queryClient.setQueriesData<ScheduleSummary>(
        { queryKey: scheduleDetailQueryRoot },
        (schedule) =>
            schedule === undefined ? undefined : removeScheduleReference(schedule)
    );
    queryClient.setQueriesData<ScheduleListData>(
        { queryKey: scheduleListQueryRoot },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => ({
                          ...page,
                          schedules: page.schedules.map(removeScheduleReference),
                      })),
                  }
    );
}

/** Patches one validated schedule in materialized directories and exact detail. */
export function patchScheduleInCachedQueries(
    queryClient: QueryClient,
    schedule: ScheduleSummary
): void {
    for (const [queryKey, data] of queryClient.getQueriesData<ScheduleListData>({
        queryKey: scheduleListQueryRoot,
    })) {
        if (data === undefined) continue;
        const enabled = queryKey.at(-1) as ScheduleEnabledFilter;
        const existingSchedules = data.pages.flatMap((page) =>
            page.schedules.filter((candidate) => candidate.id === schedule.id)
        );
        const firstMaterializedSchedule = existingSchedules[0];
        if (firstMaterializedSchedule === undefined) continue;
        let materializedSchedule = firstMaterializedSchedule;
        for (const candidate of existingSchedules.slice(1)) {
            materializedSchedule = mergeScheduleSnapshots(
                materializedSchedule,
                candidate
            );
        }
        const currentSchedule = mergeScheduleSnapshots(materializedSchedule, schedule);
        const include = scheduleMatchesFilter(currentSchedule, enabled);
        let replaced = false;
        const pages = data.pages.map((page) => ({
            ...page,
            schedules: page.schedules.flatMap((candidate) => {
                if (candidate.id !== schedule.id) return [candidate];
                if (replaced || !include) return [];
                replaced = true;
                return [currentSchedule];
            }),
        }));
        queryClient.setQueryData<ScheduleListData>(queryKey, { ...data, pages });
    }
    queryClient.setQueryData<ScheduleSummary>(
        scheduleDetailQueryKey(schedule.id),
        (current) =>
            current === undefined ? schedule : mergeScheduleSnapshots(current, schedule)
    );
}

/** Removes one server-missing schedule and its schedule-scoped history. */
export function removeScheduleFromCachedQueries(
    queryClient: QueryClient,
    id: string
): void {
    queryClient.setQueriesData<ScheduleListData>(
        { queryKey: scheduleListQueryRoot },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => ({
                          ...page,
                          schedules: page.schedules.filter(
                              (schedule) => schedule.id !== id
                          ),
                      })),
                  }
    );
    queryClient.removeQueries({ exact: true, queryKey: scheduleDetailQueryKey(id) });
    queryClient.removeQueries({
        exact: true,
        queryKey: liveHistoryArchiveQueryKey(scheduleRunListQueryKey(id)),
    });
    queryClient.removeQueries({
        exact: true,
        queryKey: liveHistoryHeadQueryKey(scheduleRunListQueryKey(id)),
    });
}

/** Patches the versioned claim-control singleton before queue refresh. */
export function patchJobWorkerControlInCachedQueries(
    queryClient: QueryClient,
    control: JobWorkerControl
): void {
    queryClient.setQueriesData<JobRunListData>(
        {
            predicate: ({ queryKey }) =>
                archiveQueryMatches(queryKey, jobRunListQueryRoot),
        },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      pages: data.pages.map((page) => ({
                          ...page,
                          summary: {
                              ...page.summary,
                              control: currentJobWorkerControl(
                                  page.summary.control,
                                  control
                              ),
                          },
                      })),
                  }
    );
    queryClient.setQueriesData<ListJobRunsResult>(
        {
            predicate: ({ queryKey }) =>
                jobRunListQueryRoot.every((part, index) => queryKey[index] === part) &&
                queryKey.at(-1) === "live-head",
        },
        (data) =>
            data === undefined
                ? undefined
                : {
                      ...data,
                      summary: {
                          ...data.summary,
                          control: currentJobWorkerControl(data.summary.control, control),
                      },
                  }
    );
    queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, (result) =>
        result === undefined
            ? undefined
            : {
                  ...result,
                  summary: {
                      ...result.summary,
                      control: currentJobWorkerControl(result.summary.control, control),
                  },
              }
    );
}

/** @returns One caller-scoped, contract-valid lost-response idempotency key. */
export function createScheduleRunIdempotencyKey(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/** @returns Authenticated run cancellation with cache-first state repair. */
export function useCancelJobRunMutation() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"jobs.cancelRun">,
        Error,
        DashboardProcedureInput<"jobs.cancelRun">
    >({
        mutationKey: jobMutationKey,
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("jobs.cancelRun", input, { signal })
            ),
        onError: (error, input) => {
            if (
                boundary.completionIsCurrent() &&
                classifyDashboardBrowserFailure(error) === "not-found"
            ) {
                removeJobRunFromCachedQueries(boundary.queryClient, input.id);
            }
        },
        onSettled: () => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() => refreshJobAndScheduleQueries(boundary.queryClient));
        },
        onSuccess: (run) => {
            if (!boundary.completionIsCurrent()) return;
            patchJobRunInCachedQueries(boundary.queryClient, run);
        },
    });
}

/** @returns Authenticated versioned claim pause/resume mutation. */
export function useSetJobClaimingPausedMutation() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"jobs.setClaimingPaused">,
        Error,
        DashboardProcedureInput<"jobs.setClaimingPaused">
    >({
        mutationKey: jobMutationKey,
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("jobs.setClaimingPaused", input, { signal })
            ),
        onSettled: () => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() => refreshJobQueries(boundary.queryClient));
        },
        onSuccess: (control) => {
            if (!boundary.completionIsCurrent()) return;
            patchJobWorkerControlInCachedQueries(boundary.queryClient, control);
        },
    });
}

/** @returns Authenticated versioned schedule update with cache-first projection repair. */
export function useUpdateScheduleMutation() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"schedules.update">,
        Error,
        DashboardProcedureInput<"schedules.update">
    >({
        mutationKey: jobMutationKey,
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("schedules.update", input, { signal })
            ),
        onError: (error, input) => {
            if (
                boundary.completionIsCurrent() &&
                classifyDashboardBrowserFailure(error) === "not-found"
            ) {
                removeScheduleFromCachedQueries(boundary.queryClient, input.id);
            }
        },
        onSettled: () => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() => refreshJobAndScheduleQueries(boundary.queryClient));
        },
        onSuccess: (schedule) => {
            if (!boundary.completionIsCurrent()) return;
            patchScheduleInCachedQueries(boundary.queryClient, schedule);
        },
    });
}

/** Variables intentionally omit the authenticated cache-owned idempotency key. */
export interface RunScheduleMutationInput {
    readonly id: string;
}

/**
 * @param createIdempotencyKey Injectable secure generator used once per successful cycle.
 * @returns Authenticated manual-run mutation retaining one key across ambiguous retries.
 */
export function useRunScheduleMutation(
    createIdempotencyKey: () => string = createScheduleRunIdempotencyKey
) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    const operationTracker = useOperationTracker();
    const mutation = useMutation<
        DashboardProcedureOutput<"schedules.run">,
        Error,
        RunScheduleMutationInput
    >({
        mutationKey: jobMutationKey,
        mutationFn: ({ id }) =>
            boundary.run((signal) => {
                const pendingKeys = scheduleRunKeysForCurrentCache(boundary.queryClient);
                const idempotencyKey = pendingKeys.get(id) ?? createIdempotencyKey();
                pendingKeys.set(id, idempotencyKey);
                return client.mutation(
                    "schedules.run",
                    { id, idempotencyKey },
                    { signal }
                );
            }),
        onError: (error, input) => {
            if (
                boundary.completionIsCurrent() &&
                classifyDashboardBrowserFailure(error) === "not-found"
            ) {
                removeScheduleFromCachedQueries(boundary.queryClient, input.id);
            }
        },
        onSettled: () => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() => refreshJobAndScheduleQueries(boundary.queryClient));
        },
        onSuccess: (run, input) => {
            if (!boundary.completionIsCurrent()) return;
            operationTracker.track({
                jobRunId: run.id,
                label: run.displayName,
                onTerminal: () => refreshJobAndScheduleQueries(boundary.queryClient),
            });
            scheduleRunKeysForCurrentCache(boundary.queryClient).delete(input.id);
            patchJobRunInCachedQueries(boundary.queryClient, run, true);
        },
    });
    return {
        ...mutation,
        hasPendingRequest: (id: string): boolean =>
            scheduleRunKeysForCurrentCache(boundary.queryClient).has(id),
    };
}
