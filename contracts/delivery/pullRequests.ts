import * as v from "valibot";

import { finiteNumberSchema, parseContract, positiveIntegerSchema } from "../runtime";
import { fullCommitShaSchema, trimmedNonEmptyStringSchema } from "./shared";

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

export const pullRequestExpectedHeadSchema = v.strictObject({
    headSha: fullCommitShaSchema,
    number: positiveIntegerSchema,
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
    isCrossRepository: v.optional(v.boolean()),
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
    headRefOid: v.optional(fullCommitShaSchema),
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

export type PullRequestAuthor = v.InferOutput<typeof pullRequestAuthorSchema>;
export type PullRequestReview = v.InferOutput<typeof pullRequestReviewSchema>;
export type PullRequestReviewConnection = v.InferOutput<
    typeof pullRequestReviewConnectionSchema
>;
export type PullRequestExpectedHead = v.InferOutput<typeof pullRequestExpectedHeadSchema>;
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
