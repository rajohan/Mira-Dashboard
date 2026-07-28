import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    ScheduledJobMutationResponse,
    ScheduledJobPatch,
    ScheduledJobRun,
    ScheduledJobRunResponse,
    ScheduledJobRunsResponse,
    ScheduledJobsResponse,
} from "../../contracts/jobs";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchRequired, apiPatchRequired, apiPostRequired } from "./useApi";
import {
    jobExecutionKeys,
    refreshJobExecutionQueueWhilePending,
} from "./useJobExecutions";

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
        select: (data) => data.jobs,
        refetchInterval: (query) =>
            query.state.data?.jobs.some((job) => job.isQueued || job.isRunning)
                ? refreshPolicy.live
                : refreshPolicy.background,
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
        select: (data) => data.runs,
        enabled: id.length > 0,
        refetchInterval: (query) =>
            query.state.data?.runs.some(
                (run) => run.status === "queued" || run.status === "running"
            )
                ? refreshPolicy.live
                : refreshPolicy.background,
    });
}

/** Provides scheduled job update. */
export function useUpdateScheduledJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: ScheduledJobPatch }) =>
            apiPatchRequired<ScheduledJobMutationResponse>(
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
            const result = await refreshJobExecutionQueueWhilePending(
                queryClient,
                apiPostRequired<ScheduledJobRunResponse>(
                    `/jobs/${encodeURIComponent(id)}/run`
                )
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
