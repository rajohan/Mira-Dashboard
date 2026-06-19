import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { apiFetchRequired, apiPostRequired } from "./useApi";

/** Represents pull request author. */
export interface PullRequestAuthor {
    login?: string;
    name?: string;
}

/** Represents pull request summary. */
export interface PullRequestSummary {
    number: number;
    title: string;
    body?: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    author: PullRequestAuthor;
    createdAt: string;
    updatedAt: string;
    isDraft: boolean;
    headRefOid?: string;
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    reviewerApproved?: boolean;
    canReviewerApprove?: boolean;
    statusCheckRollup?: unknown[];
    additions?: number;
    deletions?: number;
    changedFiles?: number;
}

/** Represents deployment job. */
export interface DeploymentJob {
    id: string;
    status: "building" | "restart-scheduled" | "isOk" | "failed";
    startedAt: string;
    updatedAt: string;
    commit?: string;
    commitTitle?: string;
    commitUrl?: string;
    note?: string;
    stdout?: string;
    stderr?: string;
}

/** Represents production checkout status. */
export interface ProductionCheckoutStatus {
    root: string;
    expectedRoot: string;
    worktreeRoot: string;
    branch: string;
    expectedBranch: string;
    head: string;
    upstream?: string;
    isClean: boolean;
    isProductionRoot: boolean;
    isSafeForDeploy: boolean;
    statusShort?: string;
}

/** Represents worktree cleanup result. */
export interface WorktreeCleanupResult {
    status: "removed" | "skipped" | "warning";
    branch: string;
    path?: string;
    message: string;
}

/** Represents the pull requests API response. */
interface PullRequestsResponse {
    pullRequests: PullRequestSummary[];
}

/** Represents the deployments API response. */
interface DeploymentsResponse {
    deployments: DeploymentJob[];
}

/** Represents the production checkout API response. */
interface ProductionCheckoutResponse {
    checkout: ProductionCheckoutStatus;
}

/** Represents the pull request action API response. */
interface PullRequestActionResponse {
    isOk: boolean;
    message: string;
    deployment?: DeploymentJob;
    deployError?: string;
    cleanup?: WorktreeCleanupResult;
    pullRequest?: PullRequestSummary;
}

/** Defines pull request keys. */
export const pullRequestKeys = {
    all: ["pull-requests"] as const,
    list: () => [...pullRequestKeys.all, "list"] as const,
    deployments: () => [...pullRequestKeys.all, "deployments"] as const,
    productionCheckout: () => [...pullRequestKeys.all, "production-checkout"] as const,
};

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

/** Performs approve pull request. */
async function approvePullRequest(
    number: number,
    shouldDeploy: boolean
): Promise<PullRequestActionResponse> {
    return apiPostRequired<PullRequestActionResponse>(
        `/pull-requests/${number}/approve`,
        {
            shouldDeploy,
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

/** Performs shouldDeploy dashboard. */
async function deployDashboard(): Promise<{ isOk: boolean; deployment: DeploymentJob }> {
    return apiPostRequired<{ isOk: boolean; deployment: DeploymentJob }>(
        "/pull-requests/shouldDeploy"
    );
}

/** Provides pull requests. */
export function usePullRequests() {
    return useQuery({
        queryKey: pullRequestKeys.list(),
        queryFn: fetchPullRequests,
        staleTime: 10_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides pull request deployments. */
export function usePullRequestDeployments() {
    return useQuery({
        queryKey: pullRequestKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides production checkout. */
export function useProductionCheckout() {
    return useQuery({
        queryKey: pullRequestKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides approve pull request. */
export function useApprovePullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            number,
            shouldDeploy,
        }: {
            number: number;
            shouldDeploy: boolean;
        }) => approvePullRequest(number, shouldDeploy),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: pullRequestKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.productionCheckout(),
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
                    pullRequestKeys.list(),
                    (current = []) =>
                        current.map((pullRequest) =>
                            pullRequest.number === updatedPullRequest.number
                                ? updatedPullRequest
                                : pullRequest
                        )
                );
            }
            void queryClient.invalidateQueries({ queryKey: pullRequestKeys.list() });
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
                    pullRequestKeys.list(),
                    (current = []) =>
                        current.map((pullRequest) =>
                            pullRequest.number === updatedPullRequest.number
                                ? updatedPullRequest
                                : pullRequest
                        )
                );
            }
            void queryClient.invalidateQueries({ queryKey: pullRequestKeys.list() });
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
            void queryClient.invalidateQueries({ queryKey: pullRequestKeys.list() });
        },
    });
}

/** Provides shouldDeploy dashboard. */
export function useDeployDashboard() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: deployDashboard,
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.productionCheckout(),
            });
        },
    });
}
