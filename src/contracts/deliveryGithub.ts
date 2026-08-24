import * as v from "valibot";

import { publishedReleaseAuthoritySchema } from "../shared/publishedReleaseAuthority.ts";
import { fullCommitShaSchema } from "../shared/validation.ts";

export const deliveryGitHubRepositoryOwner = "rajohan" as const;
export const deliveryGitHubRepositoryName = "Mira-Dashboard" as const;
export const deliveryGitHubBaseBranch = "main" as const;
export const deliveryGitHubMiraLogin = "mira-2026" as const;
export const deliveryGitHubReviewerLogin = "rajohan" as const;
export const deliveryGitHubPullRequestMaximum = 500;
export const deliveryGitHubStackMaximum = 100;
export const deliveryGitHubPullRequestBodyMaximumBytes = 64 * 1024;

const safeText = (maximum: number, message: string) =>
    v.pipe(
        v.string(message),
        v.minLength(1, message),
        v.maxLength(maximum, message),
        v.check((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), message)
    );

export const deliveryGitHubCommitShaSchema = fullCommitShaSchema(
    "Delivery requires a full lowercase commit SHA"
);
export const deliveryGitHubPullRequestNumberSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER)
);
export const deliveryGitHubLoginSchema = safeText(100, "GitHub login is invalid");
export const deliveryGitHubBranchSchema = safeText(255, "GitHub branch is invalid");
export const deliveryGitHubUrlSchema = v.pipe(
    v.string(),
    v.maxLength(2048),
    v.url(),
    v.check((value) => {
        try {
            const url = new URL(value);
            return (
                url.protocol === "https:" &&
                url.hostname === "github.com" &&
                url.port === "" &&
                url.username === "" &&
                url.password === ""
            );
        } catch {
            return false;
        }
    }, "GitHub URL is invalid")
);

export const deliveryGitHubActorSchema = v.strictObject({
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    login: deliveryGitHubLoginSchema,
    type: v.literal("User"),
});

export const deliveryGitHubCheckSchema = v.strictObject({
    completedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    conclusion: v.optional(safeText(64, "Check conclusion is invalid")),
    createdAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    identity: safeText(512, "Check identity is invalid"),
    startedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    status: safeText(64, "Check status is invalid"),
});

export const deliveryGitHubReviewSchema = v.strictObject({
    authorLogin: v.optional(deliveryGitHubLoginSchema),
    state: safeText(64, "Review state is invalid"),
    submittedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

export const deliveryGitHubStackMetadataSchema = v.strictObject({
    baseRefName: deliveryGitHubBranchSchema,
    number: deliveryGitHubPullRequestNumberSchema,
    position: deliveryGitHubPullRequestNumberSchema,
    size: deliveryGitHubPullRequestNumberSchema,
});

export const deliveryGitHubPullRequestSchema = v.strictObject({
    additions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    authorLogin: v.optional(deliveryGitHubLoginSchema),
    baseRefName: deliveryGitHubBranchSchema,
    body: v.pipe(v.string(), v.maxLength(deliveryGitHubPullRequestBodyMaximumBytes)),
    changedFiles: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    checks: v.pipe(v.array(deliveryGitHubCheckSchema), v.maxLength(100)),
    checksComplete: v.boolean(),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
    deletions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    headRefName: deliveryGitHubBranchSchema,
    headSha: deliveryGitHubCommitShaSchema,
    isCrossRepository: v.boolean(),
    isDraft: v.boolean(),
    mergeable: safeText(64, "Mergeability is invalid"),
    mergeCommitSha: v.optional(deliveryGitHubCommitShaSchema),
    mergeStateStatus: safeText(64, "Merge state is invalid"),
    number: deliveryGitHubPullRequestNumberSchema,
    reviewDecision: v.optional(safeText(64, "Review decision is invalid")),
    reviews: v.pipe(v.array(deliveryGitHubReviewSchema), v.maxLength(20)),
    stack: v.optional(deliveryGitHubStackMetadataSchema),
    state: v.picklist(["CLOSED", "MERGED", "OPEN"]),
    title: safeText(512, "Pull request title is invalid"),
    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
    url: deliveryGitHubUrlSchema,
});

export const deliveryGitHubExpectedHeadSchema = v.strictObject({
    headSha: deliveryGitHubCommitShaSchema,
    number: deliveryGitHubPullRequestNumberSchema,
});

export const deliveryGitHubExpectedHeadsSchema = v.pipe(
    v.array(deliveryGitHubExpectedHeadSchema),
    v.minLength(1),
    v.maxLength(deliveryGitHubStackMaximum),
    v.check(
        (heads) => new Set(heads.map(({ number }) => number)).size === heads.length,
        "Delivery stack heads must be unique"
    )
);

export const deliveryGitHubStackMemberSchema = v.strictObject({
    draft: v.boolean(),
    headRefName: deliveryGitHubBranchSchema,
    headSha: deliveryGitHubCommitShaSchema,
    mergedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    number: deliveryGitHubPullRequestNumberSchema,
    state: v.picklist(["closed", "open"]),
});

export const deliveryGitHubStackSchema = v.strictObject({
    baseRefName: deliveryGitHubBranchSchema,
    id: deliveryGitHubPullRequestNumberSchema,
    number: deliveryGitHubPullRequestNumberSchema,
    open: v.boolean(),
    pullRequests: v.pipe(
        v.array(deliveryGitHubStackMemberSchema),
        v.minLength(1),
        v.maxLength(deliveryGitHubStackMaximum)
    ),
});

export const deliveryGitHubPublishedReleaseSchema = publishedReleaseAuthoritySchema;

export const deliveryGitHubAsyncMergeSchema = v.strictObject({
    details: v.strictObject({
        expectedHeadSha: v.optional(deliveryGitHubCommitShaSchema),
        mergeAction: v.optional(v.picklist(["default", "direct_merge", "merge_queue"])),
        mergeMethod: v.optional(v.picklist(["merge", "rebase", "squash"])),
        message: v.pipe(v.string(), v.maxLength(2048)),
        sha: v.optional(deliveryGitHubCommitShaSchema),
        uuid: v.optional(safeText(256, "Stack merge identifier is invalid")),
    }),
    status: v.picklist(["enqueued", "failed", "merged", "pending"]),
});

export type DeliveryGitHubActor = v.InferOutput<typeof deliveryGitHubActorSchema>;
export type DeliveryGitHubCheck = v.InferOutput<typeof deliveryGitHubCheckSchema>;
export type DeliveryGitHubReview = v.InferOutput<typeof deliveryGitHubReviewSchema>;
export type DeliveryGitHubPullRequest = v.InferOutput<
    typeof deliveryGitHubPullRequestSchema
>;
export type DeliveryGitHubExpectedHead = v.InferOutput<
    typeof deliveryGitHubExpectedHeadSchema
>;
export type DeliveryGitHubStack = v.InferOutput<typeof deliveryGitHubStackSchema>;
export type DeliveryGitHubPublishedRelease = v.InferOutput<
    typeof deliveryGitHubPublishedReleaseSchema
>;
export type DeliveryGitHubAsyncMerge = v.InferOutput<
    typeof deliveryGitHubAsyncMergeSchema
>;

export type DeliveryGitHubMutationOutcome =
    | Readonly<{ outcome: "completed" }>
    | Readonly<{ outcome: "enqueued" }>
    | Readonly<{
          outcome: "partial-success";
          warning: "branch-retained" | "comment-failed";
      }>
    | Readonly<{ outcome: "unknown-outcome" }>;

/** Merge-only result that binds a confirmed GitHub effect to its exact main commit. */
export type DeliveryGitHubMergeMutationOutcome =
    | Readonly<{ mainHeadSha: string; outcome: "completed" }>
    | Readonly<{ outcome: "enqueued" }>
    | Readonly<{
          mainHeadSha: string;
          outcome: "partial-success";
          warning: "branch-cleanup-unconfirmed" | "branch-retained";
      }>
    | Readonly<{ outcome: "unknown-outcome" }>;

export interface DeliveryGitHubPullRequestReadPort {
    readonly findNativeStack: (
        number: number,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubStack | undefined>;
    readonly getPullRequest: (
        number: number,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubPullRequest>;
    readonly listOpenPullRequests: (
        signal?: AbortSignal
    ) => Promise<readonly DeliveryGitHubPullRequest[]>;
    readonly readLatestPublishedRelease?: (
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubPublishedRelease>;
    readonly readMainRef: (signal?: AbortSignal) => Promise<string>;
    readonly supportsNativeStacks: (signal?: AbortSignal) => Promise<boolean>;
}

export interface DeliveryGitHubPullRequestMutationPort {
    readonly createNativeStack: (
        expectedHeads: readonly DeliveryGitHubExpectedHead[],
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubStack>;
    readonly mergeNativeStack: (
        expectedHeads: readonly DeliveryGitHubExpectedHead[],
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubMergeMutationOutcome>;
    readonly mergePullRequest: (
        expectedHead: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubMergeMutationOutcome>;
    readonly rejectPullRequest: (
        expectedHead: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubMutationOutcome>;
    readonly updatePullRequestBranch: (
        expectedHead: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubMutationOutcome>;
}

export interface DeliveryGitHubReviewApprovalPort {
    readonly approveReview: (
        expectedHead: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubMutationOutcome>;
}

export interface DeliveryDashboardMainGitSyncPort {
    readonly inspect: (signal?: AbortSignal) => Promise<{
        readonly branch?: string;
        readonly condition?: "dirty" | "off-main" | "ready" | "wrong-root";
        readonly headSha: string;
        readonly safe: boolean;
        readonly upstream?: string;
    }>;
    readonly syncMainToExactRef: (
        expectedRemoteHead: string,
        expectedLocalHead?: string,
        signal?: AbortSignal
    ) => Promise<{
        readonly headSha: string;
        readonly outcome: "completed" | "unknown-outcome";
    }>;
}

export function parseDeliveryGitHubExpectedHead(
    input: unknown
): DeliveryGitHubExpectedHead {
    return v.parse(deliveryGitHubExpectedHeadSchema, input);
}

export function parseDeliveryGitHubExpectedHeads(
    input: unknown
): readonly DeliveryGitHubExpectedHead[] {
    return v.parse(deliveryGitHubExpectedHeadsSchema, input);
}
