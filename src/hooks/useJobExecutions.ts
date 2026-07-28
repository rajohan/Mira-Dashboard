import {
    type QueryClient,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import {
    parseJobExecutionCancelResponse,
    parseJobExecutionsResponse,
} from "../../contracts/jobs";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed, apiPostParsed } from "./useApi";

export const jobExecutionKeys = {
    all: ["job-executions"] as const,
    list: () => [...jobExecutionKeys.all, "list"] as const,
};

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
        queryFn: () => apiFetchParsed("/job-executions", parseJobExecutionsResponse),
        refetchInterval: refreshPolicy.active,
        refetchIntervalInBackground: false,
        staleTime: 500,
    });
}

export function useCancelJobExecution() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) =>
            apiPostParsed(
                `/job-executions/${encodeURIComponent(id)}/cancel`,
                parseJobExecutionCancelResponse
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
