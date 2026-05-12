import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetchRequired, apiPostRequired } from "./useApi";

/** Represents cron job. */
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

/** Represents the cron jobs API response. */
interface CronJobsResponse {
    jobs: CronJob[];
}

/** Defines cron keys. */
export const cronKeys = {
    all: ["cron"] as const,
    jobs: () => [...cronKeys.all, "jobs"] as const,
};

/** Provides cron jobs. */
export function useCronJobs() {
    return useQuery({
        queryKey: cronKeys.jobs(),
        queryFn: () => apiFetchRequired<CronJobsResponse>("/cron/jobs"),
        select: (data) => data.jobs,
        refetchInterval: 10_000,
    });
}

/** Provides toggle cron job. */
export function useToggleCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
            apiPostRequired<{ ok: boolean }>(`/cron/jobs/${id}/toggle`, { enabled }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

/** Provides update cron job. */
export function useUpdateCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
            apiPostRequired<{ ok: boolean }>(`/cron/jobs/${id}/update`, { patch }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

/** Provides run cron job now. */
export function useRunCronJobNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPostRequired<{ ok: boolean }>(`/cron/jobs/${id}/run`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}
