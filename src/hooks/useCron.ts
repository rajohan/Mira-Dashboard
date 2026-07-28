import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CronJobsResponse, CronMutationResponse } from "../../contracts/cron";
import type { JobDisableIntent } from "../../contracts/jobs";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchRequired, apiPostRequired } from "./useApi";

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
        refetchInterval: refreshPolicy.active * 2,
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
            apiPostRequired<CronMutationResponse>(`/cron/jobs/${id}/toggle`, {
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
            apiPostRequired<CronMutationResponse>(`/cron/jobs/${id}/update`, {
                patch,
            }),
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
            apiPostRequired<CronMutationResponse>(`/cron/jobs/${id}/delete`),
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
            apiPostRequired<CronMutationResponse>(`/cron/jobs/${id}/run`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}
