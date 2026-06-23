import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPatchRequired, apiPostRequired } from "./useApi";

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
    nextRunAt?: string | undefined;
    createdAt: string;
    updatedAt: string;
    lastRun?: ScheduledJobRun | undefined;
    isRunning: boolean;
}

/** Represents a backend-native scheduled job run. */
export interface ScheduledJobRun {
    id: number;
    jobId: string;
    status: "running" | "success" | "failed";
    triggerType: "manual" | "schedule";
    startedAt: string;
    finishedAt?: string | undefined;
    message?: string | undefined;
    output: Record<string, unknown>;
}

export type ScheduledJobPatch = Partial<
    Pick<
        ScheduledJob,
        "cronExpression" | "enabled" | "intervalSeconds" | "scheduleType" | "timeOfDay"
    >
>;

interface ScheduledJobRunsResponse {
    runs: ScheduledJobRun[];
}

interface ScheduledJobsResponse {
    jobs: ScheduledJob[];
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
        refetchInterval: 30_000,
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
        refetchInterval: 30_000,
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
            if (!result.isOk || result.run.status === "failed") {
                throw new Error(result.run.message || "Scheduled job run failed");
            }
            return result;
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: scheduledJobKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: scheduledJobKeys.runs(variables.id),
            });
        },
    });
}
