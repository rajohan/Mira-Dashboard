import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type DashboardRollbackRequest,
    type DashboardReleaseStatus,
    type DeploymentActionResponse,
    type DeploymentJob,
    parseDashboardReleaseStatusResponse,
    parseDeploymentActionResponse,
    parseDeploymentsResponse,
    parseProductionCheckoutResponse,
    parsePullRequestActionResponse,
    parsePullRequestPreviewMutationResponse,
    parsePullRequestPreviewResponse,
    parsePullRequestsResponse,
    type ProductionCheckoutStatus,
    type PullRequestActionResponse,
    type PullRequestApproveRequest,
    type PullRequestExpectedHead,
    type PullRequestPreviewStatus,
    type PullRequestPreviewStartRequest,
    type PullRequestRejectRequest,
    type PullRequestStackCreateRequest,
    type PullRequestSummary,
} from "../../../contracts/delivery";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed, apiPostParsed } from "./useApi";

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

/**
 * Fetches pull requests.
 * @returns Promise resolving to the fetch pull requests result.
 */
async function fetchPullRequests(): Promise<PullRequestSummary[]> {
    const response = await apiFetchParsed("/pull-requests", parsePullRequestsResponse);
    return response.pullRequests;
}

/**
 * Fetches deployments.
 * @returns Promise resolving to the fetch deployments result.
 */
async function fetchDeployments(): Promise<DeploymentJob[]> {
    const response = await apiFetchParsed(
        "/pull-requests/deployments",
        parseDeploymentsResponse
    );
    return response.deployments;
}

/**
 * Fetches production checkout.
 * @returns Promise resolving to the fetch production checkout result.
 */
async function fetchProductionCheckout(): Promise<ProductionCheckoutStatus> {
    const response = await apiFetchParsed(
        "/pull-requests/production-checkout",
        parseProductionCheckoutResponse
    );
    return response.checkout;
}

/**
 * Fetches active and previous managed Dashboard releases.
 * @returns Promise resolving to the fetch dashboard release status result.
 */
async function fetchDashboardReleaseStatus(): Promise<DashboardReleaseStatus> {
    const response = await apiFetchParsed(
        "/pull-requests/releases",
        parseDashboardReleaseStatusResponse
    );
    return response.release;
}

/**
 * Fetches the current managed PR preview slot.
 * @returns Promise resolving to the fetch pull request preview result.
 */
async function fetchPullRequestPreview(): Promise<PullRequestPreviewStatus> {
    const response = await apiFetchParsed(
        "/pull-requests/preview",
        parsePullRequestPreviewResponse
    );
    return response.preview;
}

/**
 * Performs approve pull request.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @param options Exact-head and native stack merge options.
 * @returns Approve pull request result.
 */
async function approvePullRequest(
    number: number,
    willDeploy: boolean,
    options: {
        expectedHeadSha: string;
        expectedStackHeads?: PullRequestExpectedHead[];
        mergeStack?: boolean;
    }
): Promise<PullRequestActionResponse> {
    return apiPostParsed(
        `/pull-requests/${number}/approve`,
        parsePullRequestActionResponse,
        {
            deploy: willDeploy,
            expectedHeadSha: options.expectedHeadSha,
            expectedStackHeads: options.expectedStackHeads,
            mergeStack: options.mergeStack,
        } satisfies PullRequestApproveRequest
    );
}

/**
 * Creates a native GitHub stack from an existing linear pull request chain.
 * @param pullRequests Pull request numbers ordered from bottom to top.
 * @returns Stack creation result.
 */
async function createPullRequestStack(
    pullRequests: number[]
): Promise<PullRequestActionResponse> {
    return apiPostParsed("/pull-requests/stacks", parsePullRequestActionResponse, {
        pullRequests,
    } satisfies PullRequestStackCreateRequest);
}

/**
 * Performs reject pull request.
 * @param number Number value.
 * @param comment Comment value.
 * @returns Reject pull request result.
 */
async function rejectPullRequest(
    number: number,
    comment?: string
): Promise<PullRequestActionResponse> {
    return apiPostParsed(
        `/pull-requests/${number}/reject`,
        parsePullRequestActionResponse,
        { comment } satisfies PullRequestRejectRequest
    );
}

/**
 * Performs approve pull request review.
 * @param number Number value.
 * @returns Approve pull request review result.
 */
async function approvePullRequestReview(
    number: number
): Promise<PullRequestActionResponse> {
    return apiPostParsed(
        `/pull-requests/${number}/review-approval`,
        parsePullRequestActionResponse,
        {}
    );
}

/**
 * Performs update pull request branch.
 * @param number Number value.
 * @returns Update pull request branch result.
 */
async function updatePullRequestBranch(
    number: number
): Promise<PullRequestActionResponse> {
    return apiPostParsed(
        `/pull-requests/${number}/update-branch`,
        parsePullRequestActionResponse,
        {}
    );
}

/**
 * Performs deploy dashboard.
 * @returns Deploy dashboard result.
 */
async function deployDashboard(): Promise<DeploymentActionResponse> {
    return apiPostParsed("/pull-requests/deploy", parseDeploymentActionResponse);
}

/**
 * Queues an atomic rollback to the previous managed release.
 * @param targetCommit Target commit value.
 * @returns Promise resolving to the rollback dashboard result.
 */
async function rollbackDashboard(
    targetCommit: string
): Promise<DeploymentActionResponse> {
    return apiPostParsed(
        "/pull-requests/releases/rollback",
        parseDeploymentActionResponse,
        { targetCommit } satisfies DashboardRollbackRequest
    );
}

/**
 * Starts or updates the managed preview slot.
 * @param number Number value.
 * @param expectedHeadSha Exact pull request head confirmed in Delivery.
 * @returns Promise resolving to the start pull request preview result.
 */
async function startPullRequestPreview(
    number: number,
    expectedHeadSha: string
): Promise<PullRequestPreviewStatus> {
    const response = await apiPostParsed(
        `/pull-requests/${number}/preview/start`,
        parsePullRequestPreviewMutationResponse,
        { expectedHeadSha } satisfies PullRequestPreviewStartRequest
    );
    return response.preview;
}

/**
 * Stops the managed preview slot owned by one PR.
 * @param number Number value.
 * @returns Promise resolving to the stop pull request preview result.
 */
async function stopPullRequestPreview(number: number): Promise<PullRequestPreviewStatus> {
    const response = await apiPostParsed(
        `/pull-requests/${number}/preview/stop`,
        parsePullRequestPreviewMutationResponse,
        {}
    );
    return response.preview;
}

/**
 * Provides pull requests.
 * @param refreshInterval Refresh interval value.
 * @returns The pull requests.
 */
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

/**
 * Provides Dashboard deployment and rollback jobs.
 * @returns The Dashboard deployment and rollback jobs.
 */
export function useDashboardDeployments() {
    return useQuery({
        queryKey: deliveryKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/**
 * Provides production checkout.
 * @returns The production checkout.
 */
export function useProductionCheckout() {
    return useQuery({
        queryKey: deliveryKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/**
 * Provides active and previous managed release status.
 * @returns The active and previous managed release status.
 */
export function useDashboardReleaseStatus() {
    return useQuery({
        queryKey: deliveryKeys.releaseStatus(),
        queryFn: fetchDashboardReleaseStatus,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/**
 * Provides the managed single-slot PR preview status.
 * @returns The managed single-slot PR preview status.
 */
export function usePullRequestPreview() {
    return useQuery({
        queryKey: deliveryKeys.preview(),
        queryFn: fetchPullRequestPreview,
        staleTime: 2000,
        refetchInterval: refreshPolicy.active,
    });
}

/**
 * Provides approve pull request.
 * @returns The approve pull request.
 */
export function useApprovePullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            expectedHeadSha,
            expectedStackHeads,
            mergeStack,
            number,
            willDeploy,
        }: {
            expectedHeadSha: string;
            expectedStackHeads?: PullRequestExpectedHead[];
            mergeStack?: boolean;
            number: number;
            willDeploy: boolean;
        }) =>
            approvePullRequest(number, willDeploy, {
                expectedHeadSha,
                expectedStackHeads,
                mergeStack,
            }),
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

/**
 * Creates a native GitHub stack and refreshes Delivery metadata.
 * @returns Native stack creation mutation.
 */
export function useCreatePullRequestStack() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ pullRequests }: { pullRequests: number[] }) =>
            createPullRequestStack(pullRequests),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
        },
    });
}

/**
 * Provides approve pull request review.
 * @returns The approve pull request review.
 */
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
                                ? {
                                      ...updatedPullRequest,
                                      previewEligible:
                                          updatedPullRequest.stack === undefined &&
                                          pullRequest.stack !== undefined
                                              ? pullRequest.previewEligible
                                              : updatedPullRequest.previewEligible,
                                      stack:
                                          updatedPullRequest.stack ?? pullRequest.stack,
                                  }
                                : pullRequest
                        )
                );
            }
            void queryClient.invalidateQueries({ queryKey: deliveryKeys.list() });
        },
    });
}

/**
 * Provides update pull request branch.
 * @returns The update pull request branch.
 */
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

/**
 * Provides reject pull request.
 * @returns The reject pull request.
 */
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

/**
 * Provides deploy dashboard.
 * @returns The deploy dashboard.
 */
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

/**
 * Provides atomic rollback to the previous managed release.
 * @returns The atomic rollback to the previous managed release.
 */
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

/**
 * Provides managed PR preview startup.
 * @returns The managed PR preview startup.
 */
export function useStartPullRequestPreview() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            expectedHeadSha,
            number,
        }: {
            expectedHeadSha: string;
            number: number;
        }) => startPullRequestPreview(number, expectedHeadSha),
        onSuccess: (preview) => {
            queryClient.setQueryData(deliveryKeys.preview(), preview);
            void queryClient.invalidateQueries({
                queryKey: deliveryKeys.preview(),
            });
        },
    });
}

/**
 * Provides managed PR preview shutdown.
 * @returns The managed PR preview shutdown.
 */
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
