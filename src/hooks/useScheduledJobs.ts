import { useQuery } from "@tanstack/react-query";

import { apiFetchRequired } from "./useApi";

/** Represents a backend-native scheduled job. */
export interface ScheduledJob {
    id: string;
    name: string;
    enabled: boolean;
    scheduleType: "interval" | "daily" | "cron";
    intervalSeconds: number;
    timeOfDay: string | null;
    cronExpression: string | null;
    nextRunAt: string | null;
}

interface ScheduledJobsResponse {
    jobs: ScheduledJob[];
}

/** Defines scheduled job query keys. */
export const scheduledJobKeys = {
    all: ["scheduled-jobs"] as const,
    list: () => [...scheduledJobKeys.all, "list"] as const,
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
