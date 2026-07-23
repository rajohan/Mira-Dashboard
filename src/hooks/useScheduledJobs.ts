import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { JobDisableIntent } from "../types/job";
import { apiFetchRequired, apiPatchRequired, apiPostRequired } from "./useApi";
import { jobExecutionKeys, type JobResourceClass } from "./useJobExecutions";

/** Represents a backend-native scheduled job. */
export interface ScheduledJob {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    scheduleType: "interval" | "daily" | "cron";
    intervalSeconds: number;
    timeOfDay?: string | undefined;
    cronExpression?: string | undefined;
    actionKey: string;
    actionPayload: Record<string, unknown>;
    disableIntent?: JobDisableIntent | undefined;
    nextRunAt?: string | undefined;
    createdAt: string;
    updatedAt: string;
    lastRun?: ScheduledJobRun | undefined;
    resourceClass: JobResourceClass;
    timeoutMs: number;
    isQueued: boolean;
    isRunning: boolean;
}

/** Represents a backend-native scheduled job run. */
export interface ScheduledJobRun {
    id: number;
    jobId: string;
    status: "queued" | "running" | "success" | "failed" | "cancelled";
    triggerType: "manual" | "schedule" | "startup";
    startedAt: string;
    queuedAt: string;
    finishedAt?: string | undefined;
    message?: string | undefined;
    output: Record<string, unknown>;
    executionId?: string | undefined;
    resourceClass: JobResourceClass;
    cancelRequestedAt?: string | undefined;
    cancellable: boolean;
}

export type ScheduledJobPatch = Partial<
    Omit<Pick<ScheduledJob, "enabled" | "intervalSeconds" | "scheduleType">, never> & {
        cronExpression?: string | null | undefined;
        disableIntent?: JobDisableIntent | undefined;
        timeOfDay?: string | null | undefined;
    }
>;

interface ScheduledJobRunsResponse {
    runs: ScheduledJobRun[];
}

interface ScheduledJobsResponse {
    jobs: ScheduledJob[];
}

const legacyScheduledJobTimeoutMs = 5 * 60 * 1000;

function normalizeScheduledJobRun(
    run: ScheduledJobRun,
    resourceClass: JobResourceClass
): ScheduledJobRun {
    return {
        ...run,
        cancellable: run.cancellable ?? false,
        queuedAt: run.queuedAt ?? run.startedAt,
        resourceClass: run.resourceClass ?? resourceClass,
    };
}

/** Keeps a new frontend usable during the brief old-backend deployment window. */
function normalizeScheduledJob(job: ScheduledJob): ScheduledJob {
    const resourceClass = job.resourceClass ?? "light";
    const lastRun = job.lastRun
        ? normalizeScheduledJobRun(job.lastRun, resourceClass)
        : undefined;
    return {
        ...job,
        isQueued: job.isQueued ?? lastRun?.status === "queued",
        isRunning: job.isRunning ?? lastRun?.status === "running",
        lastRun,
        resourceClass,
        timeoutMs: job.timeoutMs ?? legacyScheduledJobTimeoutMs,
    };
}

/** Preserves a failed scheduled run so callers can surface its recorded output. */
export class ScheduledJobRunError extends Error {
    readonly run: ScheduledJobRun;

    constructor(run: ScheduledJobRun) {
        super(run.message || "Scheduled job run failed");
        this.name = "ScheduledJobRunError";
        this.run = run;
    }
}

/** Defines scheduled job query keys. */
export const scheduledJobKeys = {
    all: ["scheduled-jobs"] as const,
    list: () => [...scheduledJobKeys.all, "list"] as const,
    runs: (id: string) => [...scheduledJobKeys.all, "runs", id] as const,
};

/** Provides backend-native scheduled jobs. */
export function useScheduledJobs() {
    return useQuery({
        queryKey: scheduledJobKeys.list(),
        queryFn: () => apiFetchRequired<ScheduledJobsResponse>("/jobs"),
        select: (data) => data.jobs.map((job) => normalizeScheduledJob(job)),
        refetchInterval: (query) =>
            query.state.data?.jobs.some((job) => job.isQueued || job.isRunning)
                ? 2000
                : 30_000,
    });
}

/** Provides backend-native scheduled job runs. */
export function useScheduledJobRuns(id: string) {
    return useQuery({
        queryKey: scheduledJobKeys.runs(id),
        queryFn: () =>
            apiFetchRequired<ScheduledJobRunsResponse>(
                `/jobs/${encodeURIComponent(id)}/runs`
            ),
        select: (data) => data.runs.map((run) => normalizeScheduledJobRun(run, "light")),
        enabled: id.length > 0,
        refetchInterval: (query) =>
            query.state.data?.runs.some(
                (run) => run.status === "queued" || run.status === "running"
            )
                ? 2000
                : 30_000,
    });
}

/** Provides scheduled job update. */
export function useUpdateScheduledJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: ScheduledJobPatch }) =>
            apiPatchRequired<{ isOk: boolean; job: ScheduledJob }>(
                `/jobs/${encodeURIComponent(id)}`,
                { patch }
            ),
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: scheduledJobKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: scheduledJobKeys.runs(variables.id),
            });
        },
    });
}

/** Provides scheduled job manual run. */
export function useRunScheduledJobNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ id }: { id: string }) => {
            const result = await apiPostRequired<{ isOk: boolean; run: ScheduledJobRun }>(
                `/jobs/${encodeURIComponent(id)}/run`
            );
            if (
                !result.isOk ||
                result.run.status === "failed" ||
                result.run.status === "cancelled"
            ) {
                throw new ScheduledJobRunError(result.run);
            }
            return result;
        },
        onSettled: (_data, _error, variables) => {
            void queryClient.invalidateQueries({ queryKey: scheduledJobKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: scheduledJobKeys.runs(variables.id),
            });
            void queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all });
        },
    });
}
