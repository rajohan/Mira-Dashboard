import {
    type QueryClient,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import { apiFetchRequired, apiPostRequired } from "./useApi";

export type JobResourceClass =
    "interactive" | "light" | "network" | "host-heavy" | "exclusive";
export type JobExecutionStatus =
    "queued" | "running" | "success" | "failed" | "cancelled";

export interface JobExecution {
    id: string;
    scheduledJobId?: string | undefined;
    scheduledRunId?: number | undefined;
    actionKey: string;
    displayName: string;
    resourceClass: JobResourceClass;
    status: JobExecutionStatus;
    triggerType: "manual" | "schedule" | "startup" | "system";
    queuedAt: string;
    availableAt: string;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    heartbeatAt?: string | undefined;
    cancelRequestedAt?: string | undefined;
    cancellable: boolean;
    attempt: number;
    message?: string | undefined;
}

export interface JobExecutionSummary {
    activeResourceClasses: JobResourceClass[];
    oldestQueuedAgeMs?: number | undefined;
    oldestQueuedAt?: string | undefined;
    queued: number;
    running: number;
    workerCapacity: number;
    workerCount: number;
    workerLastHeartbeatAt?: string | undefined;
    workerOnline: boolean;
}

interface JobExecutionsResponse {
    executions: JobExecution[];
    summary: JobExecutionSummary;
}

export const jobExecutionKeys = {
    all: ["job-executions"] as const,
    list: () => [...jobExecutionKeys.all, "list"] as const,
};

const JOB_EXECUTION_REFRESH_MS = 5000;
const JOB_EXECUTION_ENQUEUE_REFRESH_DELAY_MS = 250;

/**
 * Refreshes the active queue immediately after a request is dispatched and once
 * more if the request is still waiting for the queued execution to finish.
 */
export async function refreshJobExecutionQueueWhilePending<T>(
    queryClient: QueryClient,
    request: Promise<T>
): Promise<T> {
    void queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all });
    const delayedRefresh = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all });
    }, JOB_EXECUTION_ENQUEUE_REFRESH_DELAY_MS);

    try {
        return await request;
    } finally {
        clearTimeout(delayedRefresh);
    }
}

export function useJobExecutions() {
    return useQuery({
        queryKey: jobExecutionKeys.list(),
        queryFn: () => apiFetchRequired<JobExecutionsResponse>("/job-executions"),
        refetchInterval: JOB_EXECUTION_REFRESH_MS,
        refetchIntervalInBackground: false,
        staleTime: 500,
    });
}

export function useCancelJobExecution() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) =>
            apiPostRequired<{ execution: JobExecution; isOk: boolean }>(
                `/job-executions/${encodeURIComponent(id)}/cancel`
            ),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all });
            void queryClient.invalidateQueries({ queryKey: ["scheduled-jobs"] });
            if (result.execution.scheduledJobId) {
                void queryClient.invalidateQueries({
                    queryKey: ["scheduled-jobs", "runs", result.execution.scheduledJobId],
                });
            }
        },
    });
}
