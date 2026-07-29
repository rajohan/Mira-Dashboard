import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type CronToggleRequest,
    type CronUpdateRequest,
    parseCronJobsResponse,
    parseCronMutationResponse,
} from "../../../contracts/cron";
import type { JobDisableIntent } from "../../../contracts/jobs";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed, apiPostParsed } from "./useApi";

/** Defines cron keys. */
export const cronKeys = {
    all: ["cron"] as const,
    jobs: () => [...cronKeys.all, "jobs"] as const,
};

/**
 * Provides cron jobs.
 * @returns The cron jobs.
 */
export function useCronJobs() {
    return useQuery({
        queryKey: cronKeys.jobs(),
        queryFn: () => apiFetchParsed("/cron/jobs", parseCronJobsResponse),
        select: (data) => data.jobs,
        refetchInterval: refreshPolicy.active * 2,
    });
}

/**
 * Provides toggle cron job.
 * @returns The toggle cron job.
 */
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
            apiPostParsed(`/cron/jobs/${id}/toggle`, parseCronMutationResponse, {
                enabled,
                disableIntent,
            } satisfies CronToggleRequest),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });
}

/**
 * Provides update cron job.
 * @returns The update cron job.
 */
export function useUpdateCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
            apiPostParsed(`/cron/jobs/${id}/update`, parseCronMutationResponse, {
                patch,
            } satisfies CronUpdateRequest),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

/**
 * Provides delete cron job.
 * @returns The delete cron job.
 */
export function useDeleteCronJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPostParsed(`/cron/jobs/${id}/delete`, parseCronMutationResponse),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}

/**
 * Provides run cron job now.
 * @returns The run cron job now.
 */
export function useRunCronJobNow() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string }) =>
            apiPostParsed(`/cron/jobs/${id}/run`, parseCronMutationResponse),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: cronKeys.jobs() });
        },
    });
}
