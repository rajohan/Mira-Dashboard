import * as v from "valibot";

import {
    finiteNumberSchema,
    parseContract,
    positiveIntegerSchema,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const fullCommitShaSchema = v.pipe(v.string(), v.regex(/^[\da-f]{40}$/u));

export const pullRequestAuthorSchema = v.object({
    login: v.optional(v.string()),
    name: v.optional(v.string()),
});

const optionalPullRequestAuthorSchema = v.optional(
    v.pipe(
        v.nullable(pullRequestAuthorSchema),
        v.transform((value) => value ?? undefined)
    )
);

export const pullRequestReviewSchema = v.object({
    author: optionalPullRequestAuthorSchema,
    state: v.optional(v.string()),
    submittedAt: v.optional(v.string()),
});

export const pullRequestReviewConnectionSchema = v.object({
    nodes: v.optional(v.array(pullRequestReviewSchema)),
});

export const pullRequestStackSchema = v.strictObject({
    baseRefName: trimmedNonEmptyStringSchema,
    number: positiveIntegerSchema,
    position: positiveIntegerSchema,
    size: positiveIntegerSchema,
});

const optionalPullRequestStackSchema = v.optional(
    v.pipe(
        v.nullable(pullRequestStackSchema),
        v.transform((value) => value ?? undefined)
    )
);

/** GitHub owns this evolving payload, so only Dashboard-consumed fields are retained. */
export const pullRequestSummarySchema = v.object({
    additions: v.optional(finiteNumberSchema),
    author: optionalPullRequestAuthorSchema,
    baseRefName: trimmedNonEmptyStringSchema,
    body: v.optional(v.string()),
    canReviewerApprove: v.optional(v.boolean()),
    changedFiles: v.optional(finiteNumberSchema),
    createdAt: trimmedNonEmptyStringSchema,
    deletions: v.optional(finiteNumberSchema),
    headRefName: trimmedNonEmptyStringSchema,
    headRefOid: v.optional(trimmedNonEmptyStringSchema),
    isDraft: v.boolean(),
    latestOpinionatedReviews: v.optional(pullRequestReviewConnectionSchema),
    mergeable: v.optional(v.string()),
    mergeStateStatus: v.optional(v.string()),
    number: finiteNumberSchema,
    previewEligible: v.optional(v.boolean()),
    reviewDecision: v.optional(
        v.pipe(
            v.nullable(v.string()),
            v.transform((value) => value ?? undefined)
        )
    ),
    reviewerApproved: v.optional(v.boolean()),
    reviews: v.optional(v.array(pullRequestReviewSchema)),
    stack: optionalPullRequestStackSchema,
    statusCheckRollup: v.optional(v.array(v.unknown())),
    title: trimmedNonEmptyStringSchema,
    updatedAt: trimmedNonEmptyStringSchema,
    url: trimmedNonEmptyStringSchema,
});

const publicGitHubPullRequestStackSchema = v.object({
    base: v.object({ ref: trimmedNonEmptyStringSchema }),
    number: positiveIntegerSchema,
    position: positiveIntegerSchema,
    size: positiveIntegerSchema,
});

/** Bounded public GitHub REST shape used by credential-free development previews. */
export const publicGitHubPullRequestSchema = v.object({
    base: v.object({ ref: trimmedNonEmptyStringSchema }),
    body: v.optional(v.nullable(v.string())),
    created_at: trimmedNonEmptyStringSchema,
    draft: v.boolean(),
    head: v.object({
        ref: trimmedNonEmptyStringSchema,
        sha: fullCommitShaSchema,
    }),
    html_url: trimmedNonEmptyStringSchema,
    number: positiveIntegerSchema,
    stack: v.optional(v.nullable(publicGitHubPullRequestStackSchema)),
    title: trimmedNonEmptyStringSchema,
    updated_at: trimmedNonEmptyStringSchema,
    user: v.object({ login: trimmedNonEmptyStringSchema }),
});

export const publicGitHubPullRequestsSchema = v.pipe(
    v.array(publicGitHubPullRequestSchema),
    v.maxLength(100)
);

export const gitHubPullRequestStateSchema = v.object({
    state: v.picklist(["CLOSED", "MERGED", "OPEN"]),
});

export const gitHubPullRequestStackResourceSchema = v.object({
    base: v.object({ ref: trimmedNonEmptyStringSchema }),
    created_at: trimmedNonEmptyStringSchema,
    id: positiveIntegerSchema,
    node_id: trimmedNonEmptyStringSchema,
    number: positiveIntegerSchema,
    open: v.boolean(),
    pull_requests: v.pipe(
        v.array(
            v.object({
                draft: v.boolean(),
                head: v.object({
                    ref: trimmedNonEmptyStringSchema,
                    sha: fullCommitShaSchema,
                }),
                merged_at: v.nullable(trimmedNonEmptyStringSchema),
                number: positiveIntegerSchema,
                state: v.picklist(["closed", "open"]),
            })
        ),
        v.maxLength(100)
    ),
    url: trimmedNonEmptyStringSchema,
});

export const gitHubPullRequestStacksSchema = v.pipe(
    v.array(gitHubPullRequestStackResourceSchema),
    v.maxLength(100)
);

export const gitHubAsyncPullRequestMergeResultSchema = v.object({
    details: v.object({
        expected_head_sha: v.optional(fullCommitShaSchema),
        merge_action: v.optional(v.picklist(["default", "direct_merge", "merge_queue"])),
        merge_method: v.optional(v.picklist(["merge", "rebase", "squash"])),
        message: v.string(),
        sha: v.optional(fullCommitShaSchema),
        uuid: v.optional(trimmedNonEmptyStringSchema),
    }),
    status: v.picklist(["enqueued", "failed", "merged", "pending"]),
});

export const deploymentJobSchema = v.strictObject({
    commit: v.optional(v.string()),
    commitTitle: v.optional(v.string()),
    commitUrl: v.optional(v.string()),
    id: trimmedNonEmptyStringSchema,
    note: v.optional(v.string()),
    startedAt: trimmedNonEmptyStringSchema,
    status: v.picklist(["building", "verifying", "isOk", "failed"]),
    stderr: v.optional(v.string()),
    stdout: v.optional(v.string()),
    updatedAt: trimmedNonEmptyStringSchema,
});

export const dashboardReleaseSummarySchema = v.strictObject({
    builtAt: trimmedNonEmptyStringSchema,
    commitSha: trimmedNonEmptyStringSchema,
    commitTitle: v.string(),
    commitUrl: trimmedNonEmptyStringSchema,
    schema: v.strictObject({
        maximumCompatible: finiteNumberSchema,
        minimumCompatible: finiteNumberSchema,
        target: finiteNumberSchema,
    }),
});

export const dashboardReleaseStatusSchema = v.strictObject({
    current: v.optional(dashboardReleaseSummarySchema),
    previous: v.optional(dashboardReleaseSummarySchema),
    rollback: v.strictObject({
        available: v.boolean(),
        reason: v.optional(v.string()),
    }),
});

export const productionCheckoutStatusSchema = v.strictObject({
    branch: v.string(),
    expectedBranch: trimmedNonEmptyStringSchema,
    expectedRoot: trimmedNonEmptyStringSchema,
    head: v.string(),
    headCommit: v.string(),
    isClean: v.boolean(),
    isProductionRoot: v.boolean(),
    isSafeForDeploy: v.boolean(),
    root: trimmedNonEmptyStringSchema,
    statusShort: v.optional(v.string()),
    upstream: v.optional(v.string()),
    worktreeRoot: trimmedNonEmptyStringSchema,
});

export const pullRequestPreviewLifecycleSchema = v.picklist([
    "failed",
    "running",
    "starting",
    "stopped",
    "stopping",
]);

export const pullRequestPreviewStatusSchema = v.strictObject({
    backendPort: v.optional(finiteNumberSchema),
    commitSha: v.optional(v.string()),
    controlsAvailable: v.optional(v.boolean()),
    frontendPort: v.optional(finiteNumberSchema),
    message: v.optional(v.string()),
    number: v.optional(finiteNumberSchema),
    startedAt: v.optional(v.string()),
    status: pullRequestPreviewLifecycleSchema,
    title: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    url: v.optional(v.string()),
});

const cleanupStatusSchema = v.picklist(["removed", "skipped", "warning"]);

export const pullRequestPreviewCleanupResultSchema = v.strictObject({
    message: v.string(),
    number: finiteNumberSchema,
    status: cleanupStatusSchema,
});

export const worktreeCleanupResultSchema = v.strictObject({
    branch: v.string(),
    message: v.string(),
    path: v.optional(v.string()),
    status: cleanupStatusSchema,
});

export const pullRequestsResponseSchema = v.strictObject({
    pullRequests: v.array(pullRequestSummarySchema),
});
export const deploymentsResponseSchema = v.strictObject({
    deployments: v.array(deploymentJobSchema),
});
export const dashboardReleaseStatusResponseSchema = v.strictObject({
    release: dashboardReleaseStatusSchema,
});
export const productionCheckoutResponseSchema = v.strictObject({
    checkout: productionCheckoutStatusSchema,
});
export const pullRequestPreviewResponseSchema = v.strictObject({
    preview: pullRequestPreviewStatusSchema,
});
export const pullRequestPreviewMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    preview: pullRequestPreviewStatusSchema,
});
export const pullRequestActionResponseSchema = v.strictObject({
    cleanup: v.optional(worktreeCleanupResultSchema),
    cleanups: v.optional(v.array(worktreeCleanupResultSchema)),
    deployError: v.optional(v.string()),
    deployment: v.optional(deploymentJobSchema),
    isOk: v.boolean(),
    mergeStatus: v.optional(v.picklist(["enqueued", "merged"])),
    message: v.string(),
    previewCleanup: v.optional(pullRequestPreviewCleanupResultSchema),
    previewCleanups: v.optional(v.array(pullRequestPreviewCleanupResultSchema)),
    pullRequest: v.optional(pullRequestSummarySchema),
    syncError: v.optional(v.string()),
});
export const deploymentActionResponseSchema = v.strictObject({
    deployment: deploymentJobSchema,
    isOk: successLiteralSchema,
});

export const pullRequestApproveRequestSchema = strictJsonObjectSchema({
    deploy: v.optional(v.boolean()),
    expectedHeadSha: fullCommitShaSchema,
    mergeStack: v.optional(v.boolean()),
});

export const pullRequestStackCreateRequestSchema = strictJsonObjectSchema({
    pullRequests: v.pipe(
        v.array(positiveIntegerSchema),
        v.minLength(2),
        v.maxLength(100)
    ),
});

export const pullRequestPreviewStartRequestSchema = strictJsonObjectSchema({
    expectedHeadSha: fullCommitShaSchema,
});

export const pullRequestRejectRequestSchema = strictJsonObjectSchema({
    comment: v.optional(v.string()),
});

export const dashboardRollbackRequestSchema = strictJsonObjectSchema({
    targetCommit: fullCommitShaSchema,
});

export type PullRequestAuthor = v.InferOutput<typeof pullRequestAuthorSchema>;
export type PullRequestReview = v.InferOutput<typeof pullRequestReviewSchema>;
export type PullRequestReviewConnection = v.InferOutput<
    typeof pullRequestReviewConnectionSchema
>;
export type PullRequestStack = v.InferOutput<typeof pullRequestStackSchema>;
export type PullRequestSummary = v.InferOutput<typeof pullRequestSummarySchema>;
export type PublicGitHubPullRequest = v.InferOutput<typeof publicGitHubPullRequestSchema>;
export type GitHubPullRequestState = v.InferOutput<typeof gitHubPullRequestStateSchema>;
export type GitHubPullRequestStackResource = v.InferOutput<
    typeof gitHubPullRequestStackResourceSchema
>;
export type GitHubAsyncPullRequestMergeResult = v.InferOutput<
    typeof gitHubAsyncPullRequestMergeResultSchema
>;
export type DeploymentJob = v.InferOutput<typeof deploymentJobSchema>;
export type DashboardReleaseSummary = v.InferOutput<typeof dashboardReleaseSummarySchema>;
export type DashboardReleaseStatus = v.InferOutput<typeof dashboardReleaseStatusSchema>;
export type ProductionCheckoutStatus = v.InferOutput<
    typeof productionCheckoutStatusSchema
>;
export type PullRequestPreviewLifecycle = v.InferOutput<
    typeof pullRequestPreviewLifecycleSchema
>;
export type PullRequestPreviewStatus = v.InferOutput<
    typeof pullRequestPreviewStatusSchema
>;
export type PullRequestPreviewCleanupResult = v.InferOutput<
    typeof pullRequestPreviewCleanupResultSchema
>;
export type WorktreeCleanupResult = v.InferOutput<typeof worktreeCleanupResultSchema>;
export type PullRequestsResponse = v.InferOutput<typeof pullRequestsResponseSchema>;
export type DeploymentsResponse = v.InferOutput<typeof deploymentsResponseSchema>;
export type DashboardReleaseStatusResponse = v.InferOutput<
    typeof dashboardReleaseStatusResponseSchema
>;
export type ProductionCheckoutResponse = v.InferOutput<
    typeof productionCheckoutResponseSchema
>;
export type PullRequestPreviewResponse = v.InferOutput<
    typeof pullRequestPreviewResponseSchema
>;
export type PullRequestPreviewMutationResponse = v.InferOutput<
    typeof pullRequestPreviewMutationResponseSchema
>;
export type PullRequestActionResponse = v.InferOutput<
    typeof pullRequestActionResponseSchema
>;
export type DeploymentActionResponse = v.InferOutput<
    typeof deploymentActionResponseSchema
>;
export type PullRequestApproveRequest = v.InferOutput<
    typeof pullRequestApproveRequestSchema
>;
export type PullRequestStackCreateRequest = v.InferOutput<
    typeof pullRequestStackCreateRequestSchema
>;
export type PullRequestPreviewStartRequest = v.InferOutput<
    typeof pullRequestPreviewStartRequestSchema
>;
export type PullRequestRejectRequest = v.InferOutput<
    typeof pullRequestRejectRequestSchema
>;
export type DashboardRollbackRequest = v.InferOutput<
    typeof dashboardRollbackRequestSchema
>;

/**
 * Parses a pull-request approval request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed pull-request approval request.
 */
export function parsePullRequestApproveRequest(
    value: unknown
): PullRequestApproveRequest {
    return parseContract(pullRequestApproveRequestSchema, value);
}

/**
 * Parses a native GitHub stack creation request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed native GitHub stack creation request.
 */
export function parsePullRequestStackCreateRequest(
    value: unknown
): PullRequestStackCreateRequest {
    return parseContract(pullRequestStackCreateRequestSchema, value);
}

/**
 * Parses an exact-head pull request preview request.
 * @param value Value to process.
 * @returns Parsed pull request preview request.
 */
export function parsePullRequestPreviewStartRequest(
    value: unknown
): PullRequestPreviewStartRequest {
    return parseContract(pullRequestPreviewStartRequestSchema, value);
}

/**
 * Parses a pull-request rejection request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed pull-request rejection request.
 */
export function parsePullRequestRejectRequest(value: unknown): PullRequestRejectRequest {
    return parseContract(pullRequestRejectRequestSchema, value);
}

/**
 * Parses a managed-release rollback request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed managed-release rollback request.
 */
export function parseDashboardRollbackRequest(value: unknown): DashboardRollbackRequest {
    return parseContract(dashboardRollbackRequestSchema, value);
}

/**
 * Parses one GitHub pull-request summary returned by Delivery.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one GitHub pull-request summary returned by Delivery.
 */
export function parsePullRequestSummary(
    value: unknown,
    path = "pullRequest"
): PullRequestSummary {
    return parseContract(pullRequestSummarySchema, value, path);
}

/**
 * Parses the public REST response used by credential-free development previews.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the public REST response used by credential-free development previews.
 */
export function parsePublicGitHubPullRequests(
    value: unknown,
    path = "publicPullRequests"
): PublicGitHubPullRequest[] {
    return parseContract(publicGitHubPullRequestsSchema, value, path);
}

/**
 * Parses the bounded GitHub PR lifecycle response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the bounded GitHub PR lifecycle response.
 */
export function parseGitHubPullRequestState(
    value: unknown,
    path = "pullRequestState"
): GitHubPullRequestState {
    return parseContract(gitHubPullRequestStateSchema, value, path);
}

/**
 * Parses a native GitHub pull request stack resource.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed GitHub pull request stack.
 */
export function parseGitHubPullRequestStackResource(
    value: unknown,
    path = "pullRequestStack"
): GitHubPullRequestStackResource {
    return parseContract(gitHubPullRequestStackResourceSchema, value, path);
}

/**
 * Parses a bounded collection of native GitHub pull request stacks.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed GitHub pull request stacks.
 */
export function parseGitHubPullRequestStacks(
    value: unknown,
    path = "pullRequestStacks"
): GitHubPullRequestStackResource[] {
    return parseContract(gitHubPullRequestStacksSchema, value, path);
}

/**
 * Parses one asynchronous native GitHub pull request merge result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed asynchronous merge result.
 */
export function parseGitHubAsyncPullRequestMergeResult(
    value: unknown,
    path = "pullRequestStackMerge"
): GitHubAsyncPullRequestMergeResult {
    return parseContract(gitHubAsyncPullRequestMergeResultSchema, value, path);
}

/**
 * Parses one Dashboard deployment job.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Dashboard deployment job.
 */
export function parseDeploymentJob(value: unknown, path = "deployment"): DeploymentJob {
    return parseContract(deploymentJobSchema, value, path);
}

/**
 * Parses the managed PR preview state.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the managed PR preview state.
 */
export function parsePullRequestPreviewStatus(
    value: unknown,
    path = "preview"
): PullRequestPreviewStatus {
    return parseContract(pullRequestPreviewStatusSchema, value, path);
}

export function parsePullRequestsResponse(
    value: unknown,
    path = "pullRequests"
): PullRequestsResponse {
    return parseContract(pullRequestsResponseSchema, value, path);
}

export function parseDeploymentsResponse(
    value: unknown,
    path = "deployments"
): DeploymentsResponse {
    return parseContract(deploymentsResponseSchema, value, path);
}

export function parseDashboardReleaseStatusResponse(
    value: unknown,
    path = "releaseStatus"
): DashboardReleaseStatusResponse {
    return parseContract(dashboardReleaseStatusResponseSchema, value, path);
}

export function parseProductionCheckoutResponse(
    value: unknown,
    path = "productionCheckout"
): ProductionCheckoutResponse {
    return parseContract(productionCheckoutResponseSchema, value, path);
}

export function parsePullRequestPreviewResponse(
    value: unknown,
    path = "previewResponse"
): PullRequestPreviewResponse {
    return parseContract(pullRequestPreviewResponseSchema, value, path);
}

export function parsePullRequestPreviewMutationResponse(
    value: unknown,
    path = "previewMutation"
): PullRequestPreviewMutationResponse {
    return parseContract(pullRequestPreviewMutationResponseSchema, value, path);
}

export function parsePullRequestActionResponse(
    value: unknown,
    path = "pullRequestAction"
): PullRequestActionResponse {
    return parseContract(pullRequestActionResponseSchema, value, path);
}

export function parseDeploymentActionResponse(
    value: unknown,
    path = "deploymentAction"
): DeploymentActionResponse {
    return parseContract(deploymentActionResponseSchema, value, path);
}
