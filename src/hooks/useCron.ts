import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

export interface CronJob {
    id?: string;
    jobId?: string;
    name?: string;
    enabled?: boolean;
    schedule?: { kind?: string; [key: string]: unknown };
    payload?: { kind?: string; [key: string]: unknown };
    delivery?: { mode?: string; [key: string]: unknown };
    [key: string]: unknown;
}

interface CronJobsResponse {
    jobs: CronJob[];
}

export const cronKeys = {
    all: ["cron"] as const,
    jobs: () => [...cronKeys.all, "jobs"] as const,
};

export function useCronJobs() {
    return useQuery({
        queryKey: cronKeys.jobs(),
        queryFn: () => apiFetch<CronJobsResponse>("/cron/jobs"),
        select: (data) => data.jobs,
        refetchInterval: 10_000,
    });
}

export function useToggleCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
            apiPost<{ ok: boolean }>(`/cron/jobs/${id}/toggle`, { enabled }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

export function useUpdateCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
            apiPost<{ ok: boolean }>(`/cron/jobs/${id}/update`, { patch }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

export function useRunCronJobNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPost<{ ok: boolean }>(`/cron/jobs/${id}/run`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}
