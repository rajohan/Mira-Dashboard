import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { JobDisableIntent } from "../types/job";
import { apiFetchRequired, apiPostRequired } from "./useApi";

/** Represents a task linked to an OpenClaw cron job. */
export interface CronTaskLink {
    number: number;
    title: string;
}

/** Represents cron job. */
export interface CronJob {
    id?: string;
    jobId?: string;
    name?: string;
    enabled?: boolean;
    schedule?: { kind?: string; [key: string]: unknown };
    payload?: { kind?: string; [key: string]: unknown };
    delivery?: { mode?: string; [key: string]: unknown };
    disableIntent?: JobDisableIntent;
    taskLinks?: CronTaskLink[];
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
        mutationFn: ({
            id,
            enabled,
            disableIntent,
        }: {
            id: string;
            enabled: boolean;
            disableIntent?: JobDisableIntent;
        }) =>
            apiPostRequired<{ isOk: boolean }>(`/cron/jobs/${id}/toggle`, {
                enabled,
                disableIntent,
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });
}

/** Provides update cron job. */
export function useUpdateCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
            apiPostRequired<{ isOk: boolean }>(`/cron/jobs/${id}/update`, { patch }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

/** Provides delete cron job. */
export function useDeleteCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPostRequired<{ isOk: boolean }>(`/cron/jobs/${id}/delete`),
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
            apiPostRequired<{ isOk: boolean }>(`/cron/jobs/${id}/run`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}
