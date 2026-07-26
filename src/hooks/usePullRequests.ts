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

/** Represents an immutable managed Dashboard release. */
export interface DashboardReleaseSummary {
    builtAt: string;
    commitSha: string;
    commitTitle: string;
    commitUrl: string;
    schema: {
        maximumCompatible: number;
        minimumCompatible: number;
        target: number;
    };
}

/** Represents the active and immediately previous production releases. */
export interface DashboardReleaseStatus {
    current?: DashboardReleaseSummary;
    previous?: DashboardReleaseSummary;
    rollback: {
        available: boolean;
        reason?: string;
    };
}

/** Represents production checkout status. */
export interface ProductionCheckoutStatus {
    root: string;
    expectedRoot: string;
    worktreeRoot: string;
    branch: string;
    expectedBranch: string;
    head: string;
    headCommit?: string;
    upstream?: string;
    isClean: boolean;
    isProductionRoot: boolean;
    isSafeForDeploy: boolean;
    statusShort?: string;
}

export type PullRequestPreviewLifecycle =
    "failed" | "running" | "starting" | "stopped" | "stopping";

/** Represents the managed single-slot PR preview. */
export interface PullRequestPreviewStatus {
    backendPort?: number;
    commitSha?: string;
    frontendPort?: number;
    message?: string;
    number?: number;
    startedAt?: string;
    status: PullRequestPreviewLifecycle;
    title?: string;
    updatedAt?: string;
    url?: string;
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

/** Represents the managed release status API response. */
interface DashboardReleaseStatusResponse {
    release: DashboardReleaseStatus;
}

/** Represents the production checkout API response. */
interface ProductionCheckoutResponse {
    checkout: ProductionCheckoutStatus;
}

/** Represents the managed pull request preview API response. */
interface PullRequestPreviewResponse {
    isOk?: boolean;
    preview: PullRequestPreviewStatus;
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
    preview: () => [...pullRequestKeys.all, "preview"] as const,
    productionCheckout: () => [...pullRequestKeys.all, "production-checkout"] as const,
    releaseStatus: () => [...pullRequestKeys.all, "releases"] as const,
};

export const PULL_REQUEST_NAV_REFRESH_MS = 60_000;
export const PULL_REQUEST_PAGE_REFRESH_MS = AUTO_REFRESH_MS;

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
async function deployDashboard(): Promise<{ isOk: boolean; deployment: DeploymentJob }> {
    return apiPostRequired<{ isOk: boolean; deployment: DeploymentJob }>(
        "/pull-requests/deploy"
    );
}

/** Queues an atomic rollback to the previous managed release. */
async function rollbackDashboard(
    targetCommit: string
): Promise<{ isOk: boolean; deployment: DeploymentJob }> {
    return apiPostRequired<{ isOk: boolean; deployment: DeploymentJob }>(
        "/pull-requests/releases/rollback",
        { targetCommit }
    );
}

/** Starts or updates the managed preview slot. */
async function startPullRequestPreview(
    number: number
): Promise<PullRequestPreviewStatus> {
    const response = await apiPostRequired<PullRequestPreviewResponse>(
        `/pull-requests/${number}/preview/start`,
        {}
    );
    return response.preview;
}

/** Stops the managed preview slot owned by one PR. */
async function stopPullRequestPreview(number: number): Promise<PullRequestPreviewStatus> {
    const response = await apiPostRequired<PullRequestPreviewResponse>(
        `/pull-requests/${number}/preview/stop`,
        {}
    );
    return response.preview;
}

/** Provides pull requests. */
export function usePullRequests(refreshInterval = PULL_REQUEST_PAGE_REFRESH_MS) {
    return useQuery({
        queryKey: pullRequestKeys.list(),
        queryFn: fetchPullRequests,
        staleTime: 10_000,
        refetchInterval: refreshInterval,
    });
}

/** Provides pull request deployments. */
export function usePullRequestDeployments() {
    return useQuery({
        queryKey: pullRequestKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides production checkout. */
export function useProductionCheckout() {
    return useQuery({
        queryKey: pullRequestKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides active and previous managed release status. */
export function useDashboardReleaseStatus() {
    return useQuery({
        queryKey: pullRequestKeys.releaseStatus(),
        queryFn: fetchDashboardReleaseStatus,
        staleTime: 5000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides the managed single-slot PR preview status. */
export function usePullRequestPreview() {
    return useQuery({
        queryKey: pullRequestKeys.preview(),
        queryFn: fetchPullRequestPreview,
        staleTime: 2000,
        refetchInterval: 5000,
    });
}

/** Provides approve pull request. */
export function useApprovePullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, willDeploy }: { number: number; willDeploy: boolean }) =>
            approvePullRequest(number, willDeploy),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: pullRequestKeys.list() });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.productionCheckout(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.releaseStatus(),
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

/** Provides deploy dashboard. */
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
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.releaseStatus(),
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
                queryKey: pullRequestKeys.deployments(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.productionCheckout(),
            });
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.releaseStatus(),
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
            queryClient.setQueryData(pullRequestKeys.preview(), preview);
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.preview(),
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
            queryClient.setQueryData(pullRequestKeys.preview(), preview);
            void queryClient.invalidateQueries({
                queryKey: pullRequestKeys.preview(),
            });
        },
    });
}
