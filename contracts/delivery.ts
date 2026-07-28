export interface PullRequestAuthor {
    login?: string;
    name?: string;
}

export interface PullRequestReview {
    author?: PullRequestAuthor;
    state?: string;
    submittedAt?: string;
}

export interface PullRequestReviewConnection {
    nodes?: PullRequestReview[];
}

export interface PullRequestSummary {
    additions?: number;
    author: PullRequestAuthor;
    baseRefName: string;
    body?: string;
    canReviewerApprove?: boolean;
    changedFiles?: number;
    createdAt: string;
    deletions?: number;
    headRefName: string;
    headRefOid?: string;
    isDraft: boolean;
    latestOpinionatedReviews?: PullRequestReviewConnection;
    mergeable?: string;
    mergeStateStatus?: string;
    number: number;
    previewEligible?: boolean;
    reviewDecision?: string;
    reviewerApproved?: boolean;
    reviews?: PullRequestReview[];
    statusCheckRollup?: unknown[];
    title: string;
    updatedAt: string;
    url: string;
}

export interface DeploymentJob {
    commit?: string;
    commitTitle?: string;
    commitUrl?: string;
    id: string;
    note?: string;
    startedAt: string;
    status: "building" | "verifying" | "isOk" | "failed";
    stderr?: string;
    stdout?: string;
    updatedAt: string;
}

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

export interface DashboardReleaseStatus {
    current?: DashboardReleaseSummary;
    previous?: DashboardReleaseSummary;
    rollback: {
        available: boolean;
        reason?: string;
    };
}

export interface ProductionCheckoutStatus {
    branch: string;
    expectedBranch: string;
    expectedRoot: string;
    head: string;
    headCommit: string;
    isClean: boolean;
    isProductionRoot: boolean;
    isSafeForDeploy: boolean;
    root: string;
    statusShort?: string;
    upstream?: string;
    worktreeRoot: string;
}

export type PullRequestPreviewLifecycle =
    "failed" | "running" | "starting" | "stopped" | "stopping";

export interface PullRequestPreviewStatus {
    backendPort?: number;
    commitSha?: string;
    controlsAvailable?: boolean;
    frontendPort?: number;
    message?: string;
    number?: number;
    startedAt?: string;
    status: PullRequestPreviewLifecycle;
    title?: string;
    updatedAt?: string;
    url?: string;
}

export interface PullRequestPreviewCleanupResult {
    message: string;
    number: number;
    status: "removed" | "skipped" | "warning";
}

export interface WorktreeCleanupResult {
    branch: string;
    message: string;
    path?: string;
    status: "removed" | "skipped" | "warning";
}

export interface PullRequestsResponse {
    pullRequests: PullRequestSummary[];
}

export interface DeploymentsResponse {
    deployments: DeploymentJob[];
}

export interface DashboardReleaseStatusResponse {
    release: DashboardReleaseStatus;
}

export interface ProductionCheckoutResponse {
    checkout: ProductionCheckoutStatus;
}

export interface PullRequestPreviewResponse {
    preview: PullRequestPreviewStatus;
}

export interface PullRequestPreviewMutationResponse extends PullRequestPreviewResponse {
    isOk: true;
}

export interface PullRequestActionResponse {
    cleanup?: WorktreeCleanupResult;
    deployError?: string;
    deployment?: DeploymentJob;
    isOk: boolean;
    message: string;
    previewCleanup?: PullRequestPreviewCleanupResult;
    pullRequest?: PullRequestSummary;
}

export interface DeploymentActionResponse {
    deployment: DeploymentJob;
    isOk: true;
}
