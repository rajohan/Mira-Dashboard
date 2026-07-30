import {
    type QueryClient,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import {
    parseJobExecutionCancelResponse,
    parseJobExecutionsResponse,
    parseJobWorkerClaimsMutationResponse,
} from "../../../contracts/jobs";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed, apiPatchParsed, apiPostParsed } from "./useApi";

export const jobExecutionKeys = {
    all: ["job-executions"] as const,
    list: () => [...jobExecutionKeys.all, "list"] as const,
};

const JOB_EXECUTION_ENQUEUE_REFRESH_DELAY_MS = 250;

/**
 * Refreshes the active queue immediately after a request is dispatched and once
 * more if the request is still waiting for the queued execution to finish.
 * @returns Promise resolving to the refresh job execution queue while pending result.
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
        queryFn: () =>
            apiFetchParsed("/job-executions?include=claims", parseJobExecutionsResponse),
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

export function useSetJobWorkerClaimsPaused() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (paused: boolean) =>
            apiPatchParsed(
                "/job-executions/claims",
                parseJobWorkerClaimsMutationResponse,
                { paused }
            ),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: jobExecutionKeys.all });
        },
    });
}
