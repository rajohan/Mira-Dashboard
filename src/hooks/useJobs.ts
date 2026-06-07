import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPatchRequired, apiPostRequired } from "./useApi";

export interface ScheduledJobRun {
    id: number;
    jobId: string;
    status: "running" | "success" | "failed";
    triggerType: "manual" | "schedule";
    startedAt: string;
    finishedAt: string | null;
    message: string | null;
    output: Record<string, unknown>;
}

export interface ScheduledJob {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    scheduleType: "interval" | "daily" | "cron";
    intervalSeconds: number;
    timeOfDay: string | null;
    cronExpression: string | null;
    actionType:
        | "cache.refresh"
        | "cache.refreshMany"
        | "docker.updater"
        | "notification.openclaw"
        | "notification.quota"
        | "ops.logRotation";
    actionTarget: string;
    settings: Record<string, unknown>;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastRun: ScheduledJobRun | null;
    isRunning: boolean;
}

interface JobsResponse {
    jobs: ScheduledJob[];
}

export const jobKeys = {
    all: ["jobs"] as const,
    list: () => [...jobKeys.all, "list"] as const,
};

export function useScheduledJobs() {
    return useQuery({
        queryKey: jobKeys.list(),
        queryFn: () => apiFetchRequired<JobsResponse>("/jobs"),
        select: (data) => data.jobs,
        refetchInterval: 10_000,
    });
}

export function useUpdateScheduledJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            id,
            patch,
        }: {
            id: string;
            patch: {
                enabled?: boolean;
                intervalSeconds?: number;
                scheduleType?: "interval" | "daily" | "cron";
                timeOfDay?: string | null;
            };
        }) =>
            apiPatchRequired<{ ok: boolean; job: ScheduledJob }>(
                `/jobs/${encodeURIComponent(id)}`,
                {
                    patch,
                }
            ),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: jobKeys.list() });
        },
    });
}

export function useRunScheduledJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPostRequired<{ ok: boolean; run: ScheduledJobRun }>(
                `/jobs/${encodeURIComponent(id)}/run`
            ),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: jobKeys.list() });
        },
    });
}
