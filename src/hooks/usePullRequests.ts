import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { apiFetch, apiPost } from "./useApi";

/** Describes pull request author. */
export interface PullRequestAuthor {
    login?: string;
    name?: string;
}

/** Describes pull request summary. */
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
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    statusCheckRollup?: unknown[];
    additions?: number;
    deletions?: number;
    changedFiles?: number;
}

/** Describes deployment job. */
export interface DeploymentJob {
    id: string;
    status: "building" | "restart-scheduled" | "ok" | "failed";
    startedAt: string;
    updatedAt: string;
    commit?: string;
    note?: string;
    stdout?: string;
    stderr?: string;
}

/** Describes production checkout status. */
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

/** Describes worktree cleanup result. */
export interface WorktreeCleanupResult {
    status: "removed" | "skipped" | "warning";
    branch: string;
    path?: string;
    message: string;
}

/** Describes pull requests response. */
interface PullRequestsResponse {
    pullRequests: PullRequestSummary[];
}

/** Describes deployments response. */
interface DeploymentsResponse {
    deployments: DeploymentJob[];
}

/** Describes production checkout response. */
interface ProductionCheckoutResponse {
    checkout: ProductionCheckoutStatus;
}

/** Describes pull request action response. */
interface PullRequestActionResponse {
    ok: boolean;
    message: string;
    deployment?: DeploymentJob;
    cleanup?: WorktreeCleanupResult;
}

/** Stores pull request keys. */
export const pullRequestKeys = {
    all: ["pull-requests"] as const,
    list: () => [...pullRequestKeys.all, "list"] as const,
    deployments: () => [...pullRequestKeys.all, "deployments"] as const,
    productionCheckout: () => [...pullRequestKeys.all, "production-checkout"] as const,
};

/** Handles fetch pull requests. */
async function fetchPullRequests(): Promise<PullRequestSummary[]> {
    const response = await apiFetch<PullRequestsResponse>("/pull-requests");
    return response.pullRequests;
}

/** Handles fetch deployments. */
async function fetchDeployments(): Promise<DeploymentJob[]> {
    const response = await apiFetch<DeploymentsResponse>("/pull-requests/deployments");
    return response.deployments;
}

/** Handles fetch production checkout. */
async function fetchProductionCheckout(): Promise<ProductionCheckoutStatus> {
    const response = await apiFetch<ProductionCheckoutResponse>(
        "/pull-requests/production-checkout"
    );
    return response.checkout;
}

/** Handles approve pull request. */
async function approvePullRequest(
    number: number,
    deploy: boolean
): Promise<PullRequestActionResponse> {
    return apiPost<PullRequestActionResponse>(`/pull-requests/${number}/approve`, {
        deploy,
    });
}

/** Handles reject pull request. */
async function rejectPullRequest(
    number: number,
    comment?: string
): Promise<PullRequestActionResponse> {
    return apiPost<PullRequestActionResponse>(`/pull-requests/${number}/reject`, {
        comment,
    });
}

/** Handles deploy dashboard. */
async function deployDashboard(): Promise<{ ok: boolean; deployment: DeploymentJob }> {
    return apiPost<{ ok: boolean; deployment: DeploymentJob }>("/pull-requests/deploy");
}

/** Handles use pull requests. */
export function usePullRequests() {
    return useQuery({
        queryKey: pullRequestKeys.list(),
        queryFn: fetchPullRequests,
        staleTime: 10_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Handles use pull request deployments. */
export function usePullRequestDeployments() {
    return useQuery({
        queryKey: pullRequestKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Handles use production checkout. */
export function useProductionCheckout() {
    return useQuery({
        queryKey: pullRequestKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Handles use approve pull request. */
export function useApprovePullRequest() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, deploy }: { number: number; deploy: boolean }) =>
            approvePullRequest(number, deploy),
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

/** Handles use reject pull request. */
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

/** Handles use deploy dashboard. */
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
