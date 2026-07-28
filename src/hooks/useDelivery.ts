import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    DashboardReleaseStatus,
    DashboardReleaseStatusResponse,
    DeploymentActionResponse,
    DeploymentJob,
    DeploymentsResponse,
    ProductionCheckoutResponse,
    ProductionCheckoutStatus,
    PullRequestActionResponse,
    PullRequestPreviewMutationResponse,
    PullRequestPreviewResponse,
    PullRequestPreviewStatus,
    PullRequestsResponse,
    PullRequestSummary,
} from "../../contracts/delivery";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchRequired, apiPostRequired } from "./useApi";

/** Defines delivery page query keys. */
export const deliveryKeys = {
    all: ["delivery"] as const,
    list: () => [...deliveryKeys.all, "pull-requests"] as const,
    deployments: () => [...deliveryKeys.all, "deployments"] as const,
    preview: () => [...deliveryKeys.all, "preview"] as const,
    productionCheckout: () => [...deliveryKeys.all, "production-checkout"] as const,
    releaseStatus: () => [...deliveryKeys.all, "releases"] as const,
};

export const DELIVERY_NAV_REFRESH_MS = refreshPolicy.static;
export const DELIVERY_PAGE_REFRESH_MS = AUTO_REFRESH_MS;

/** Fetches pull requests. */
async function fetchPullRequests(): Promise<PullRequestSummary[]> {
    const response = await apiFetchRequired<PullRequestsResponse>("/pull-requests");
    return response.pullRequests;
}

/** Fetches deployments. */
async function fetchDeployments(): Promise<DeploymentJob[]> {
    const response = await apiFetchRequired<DeploymentsResponse>(
        "/pull-requests/deployments"
    );
    return response.deployments;
}

/** Fetches production checkout. */
async function fetchProductionCheckout(): Promise<ProductionCheckoutStatus> {
    const response = await apiFetchRequired<ProductionCheckoutResponse>(
        "/pull-requests/production-checkout"
    );
    return response.checkout;
}

/** Fetches active and previous managed Dashboard releases. */
async function fetchDashboardReleaseStatus(): Promise<DashboardReleaseStatus> {
    const response = await apiFetchRequired<DashboardReleaseStatusResponse>(
        "/pull-requests/releases"
    );
    return response.release;
}

/** Fetches the current managed PR preview slot. */
async function fetchPullRequestPreview(): Promise<PullRequestPreviewStatus> {
    const response = await apiFetchRequired<PullRequestPreviewResponse>(
        "/pull-requests/preview"
    );
    return response.preview;
}

/** Performs approve pull request. */
async function approvePullRequest(
    number: number,
    willDeploy: boolean
): Promise<PullRequestActionResponse> {
    return apiPostRequired<PullRequestActionResponse>(
        `/pull-requests/${number}/approve`,
        {
            deploy: willDeploy,
        }
    );
}

/** Performs reject pull request. */
async function rejectPullRequest(
    number: number,
    comment?: string
): Promise<PullRequestActionResponse> {
    return apiPostRequired<PullRequestActionResponse>(`/pull-requests/${number}/reject`, {
        comment,
    });
}

/** Performs approve pull request review. */
async function approvePullRequestReview(
    number: number
): Promise<PullRequestActionResponse> {
    return apiPostRequired<PullRequestActionResponse>(
        `/pull-requests/${number}/review-approval`,
        {}
    );
}

/** Performs update pull request branch. */
async function updatePullRequestBranch(
    number: number
): Promise<PullRequestActionResponse> {
    return apiPostRequired<PullRequestActionResponse>(
        `/pull-requests/${number}/update-branch`,
        {}
    );
}

/** Performs deploy dashboard. */
async function deployDashboard(): Promise<DeploymentActionResponse> {
    return apiPostRequired<DeploymentActionResponse>("/pull-requests/deploy");
}

/** Queues an atomic rollback to the previous managed release. */
async function rollbackDashboard(
    targetCommit: string
): Promise<DeploymentActionResponse> {
    return apiPostRequired<DeploymentActionResponse>("/pull-requests/releases/rollback", {
        targetCommit,
    });
}

/** Starts or updates the managed preview slot. */
async function startPullRequestPreview(
    number: number
): Promise<PullRequestPreviewStatus> {
    const response = await apiPostRequired<PullRequestPreviewMutationResponse>(
        `/pull-requests/${number}/preview/start`,
        {}
    );
    return response.preview;
}

/** Stops the managed preview slot owned by one PR. */
async function stopPullRequestPreview(number: number): Promise<PullRequestPreviewStatus> {
    const response = await apiPostRequired<PullRequestPreviewMutationResponse>(
        `/pull-requests/${number}/preview/stop`,
        {}
    );
    return response.preview;
}

/** Provides pull requests. */
export function usePullRequests(
    refreshInterval: number | false = DELIVERY_PAGE_REFRESH_MS
) {
    return useQuery({
        queryKey: deliveryKeys.list(),
        queryFn: fetchPullRequests,
        staleTime: 10_000,
        refetchInterval: refreshInterval,
    });
}

/** Provides Dashboard deployment and rollback jobs. */
export function useDashboardDeployments() {
    return useQuery({
        queryKey: deliveryKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides production checkout. */
export function useProductionCheckout() {
    return useQuery({
        queryKey: deliveryKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides active and previous managed release status. */
export function useDashboardReleaseStatus() {
    return useQuery({
        queryKey: deliveryKeys.releaseStatus(),
        queryFn: fetchDashboardReleaseStatus,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides the managed single-slot PR preview status. */
export function usePullRequestPreview() {
    return useQuery({
        queryKey: deliveryKeys.preview(),
        queryFn: fetchPullRequestPreview,
        staleTime: 2000,
        refetchInterval: refreshPolicy.active,
    });
}

/** Provides approve pull request. */
export function useApprovePullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, willDeploy }: { number: number; willDeploy: boolean }) =>
            approvePullRequest(number, willDeploy),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.productionCheckout(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.releaseStatus(),
            });
        },
    });
}

/** Provides approve pull request review. */
export function useApprovePullRequestReview() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => approvePullRequestReview(number),
        onSuccess: (response) => {
            const updatedPullRequest = response.pullRequest;
            if (updatedPullRequest) {
                queryClient.setQueryData<PullRequestSummary[]>(
                    deliveryKeys.list(),
                    (current = []) =>
                        current.map((pullRequest) =>
                            pullRequest.number === updatedPullRequest.number
                                ? updatedPullRequest
                                : pullRequest
                        )
                );
            }
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
        },
    });
}

/** Provides update pull request branch. */
export function useUpdatePullRequestBranch() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => updatePullRequestBranch(number),
        onSuccess: (response) => {
            const updatedPullRequest = response.pullRequest;
            if (updatedPullRequest) {
                queryClient.setQueryData<PullRequestSummary[]>(
                    deliveryKeys.list(),
                    (current = []) =>
                        current.map((pullRequest) =>
                            pullRequest.number === updatedPullRequest.number
                                ? updatedPullRequest
                                : pullRequest
                        )
                );
            }
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
        },
    });
}

/** Provides reject pull request. */
export function useRejectPullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, comment }: { number: number; comment?: string }) =>
            rejectPullRequest(number, comment),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
        },
    });
}

/** Provides deploy dashboard. */
export function useDeployDashboard() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: deployDashboard,
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.productionCheckout(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.releaseStatus(),
            });
        },
    });
}

/** Provides atomic rollback to the previous managed release. */
export function useRollbackDashboard() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ targetCommit }: { targetCommit: string }) =>
            rollbackDashboard(targetCommit),
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.productionCheckout(),
            });
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.releaseStatus(),
            });
        },
    });
}

/** Provides managed PR preview startup. */
export function useStartPullRequestPreview() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => startPullRequestPreview(number),
        onSuccess: (preview) => {
            queryClient.setQueryData(deliveryKeys.preview(), preview);
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.preview(),
            });
        },
    });
}

/** Provides managed PR preview shutdown. */
export function useStopPullRequestPreview() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => stopPullRequestPreview(number),
        onSuccess: (preview) => {
            queryClient.setQueryData(deliveryKeys.preview(), preview);
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.preview(),
            });
        },
    });
}
