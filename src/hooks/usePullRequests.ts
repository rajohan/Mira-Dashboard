import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { apiFetch, apiPost } from "./useApi";

export interface PullRequestAuthor {
    login?: string;
    name?: string;
}

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

interface PullRequestsResponse {
    pullRequests: PullRequestSummary[];
}

interface DeploymentsResponse {
    deployments: DeploymentJob[];
}

interface ProductionCheckoutResponse {
    checkout: ProductionCheckoutStatus;
}

interface PullRequestActionResponse {
    ok: boolean;
    message: string;
    deployment?: DeploymentJob;
}

export const pullRequestKeys = {
    all: ["pull-requests"] as const,
    list: () => [...pullRequestKeys.all, "list"] as const,
    deployments: () => [...pullRequestKeys.all, "deployments"] as const,
    productionCheckout: () => [...pullRequestKeys.all, "production-checkout"] as const,
};

async function fetchPullRequests(): Promise<PullRequestSummary[]> {
    const response = await apiFetch<PullRequestsResponse>("/pull-requests");
    return response.pullRequests;
}

async function fetchDeployments(): Promise<DeploymentJob[]> {
    const response = await apiFetch<DeploymentsResponse>("/pull-requests/deployments");
    return response.deployments;
}

async function fetchProductionCheckout(): Promise<ProductionCheckoutStatus> {
    const response = await apiFetch<ProductionCheckoutResponse>(
        "/pull-requests/production-checkout"
    );
    return response.checkout;
}

async function approvePullRequest(
    number: number,
    deploy: boolean
): Promise<PullRequestActionResponse> {
    return apiPost<PullRequestActionResponse>(`/pull-requests/${number}/approve`, {
        deploy,
    });
}

async function rejectPullRequest(
    number: number,
    comment?: string
): Promise<PullRequestActionResponse> {
    return apiPost<PullRequestActionResponse>(`/pull-requests/${number}/reject`, {
        comment,
    });
}

async function deployDashboard(): Promise<{ ok: boolean; deployment: DeploymentJob }> {
    return apiPost<{ ok: boolean; deployment: DeploymentJob }>("/pull-requests/deploy");
}

export function usePullRequests() {
    return useQuery({
        queryKey: pullRequestKeys.list(),
        queryFn: fetchPullRequests,
        staleTime: 10_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

export function usePullRequestDeployments() {
    return useQuery({
        queryKey: pullRequestKeys.deployments(),
        queryFn: fetchDeployments,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

export function useProductionCheckout() {
    return useQuery({
        queryKey: pullRequestKeys.productionCheckout(),
        queryFn: fetchProductionCheckout,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

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
