import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { deliveryOperationWarningsSchema } from "../shared/deliveryOperationWarnings.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    fullCommitShaSchema,
    hasUniqueArrayItems,
    lowercaseSha256Schema,
    lowercaseUuidV7Schema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { jobIdempotencyKeySchema, jobRunIdSchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";

/** Scheduled action payload identity; section rows below remain domain-only. */
export const deliveryOverviewCacheKey = "delivery.overview";
export const deliveryOverviewSectionIds = [
    "pull-requests",
    "preview",
    "checkout",
    "releases",
] as const;
export type DeliveryOverviewSectionId = (typeof deliveryOverviewSectionIds)[number];
export const deliveryOverviewSectionKeys = Object.freeze({
    checkout: "delivery.overview.checkout",
    preview: "delivery.overview.preview",
    "pull-requests": "delivery.overview.pull-requests",
    releases: "delivery.overview.releases",
} as const satisfies Readonly<Record<DeliveryOverviewSectionId, string>>);
export const deliveryOverviewCacheKeys = Object.freeze(
    deliveryOverviewSectionIds.map((section) => deliveryOverviewSectionKeys[section])
);
export const deliveryOverviewSectionSchemaIds = Object.freeze({
    checkout: "delivery.overview.checkout.v1",
    preview: "delivery.overview.preview.v1",
    "pull-requests": "delivery.overview.pull-requests.v1",
    releases: "delivery.overview.releases.v1",
} as const satisfies Readonly<Record<DeliveryOverviewSectionId, string>>);
export const deliveryOverviewSectionSources = Object.freeze({
    checkout: "git.delivery.checkout",
    preview: "delivery.preview.host",
    "pull-requests": "github.delivery.pull-requests",
    releases: "delivery.production.releases",
} as const satisfies Readonly<Record<DeliveryOverviewSectionId, string>>);

export const deliveryPullRequestMaximum = 500;
export const deliveryPullRequestGroupMaximum = 500;
export const deliveryStackMemberMaximum = 100;
export const deliveryDeploymentMaximum = 10;
export const deliveryPullRequestBodyMaximumBytes = 64 * 1024;
/** Reviewed provider-specific ceiling for the complete 500-PR Delivery inventory. */
export const deliveryPullRequestsPayloadMaximumBytes = 2_359_296;

const deliveryTimestampSchema = timestampMillisecondsSchema(
    "Delivery timestamp is invalid"
);
const deliveryCountSchema = nonnegativeSafeIntegerSchema("Delivery count is invalid");
const pullRequestNumberSchema = positiveSafeIntegerSchema(
    "Pull request number is invalid"
);
const deliveryTextSchema = boundedControlSafeTextSchema(500, "Delivery text is invalid");
const deliveryTitleSchema = boundedControlSafeTextSchema(
    500,
    "Delivery title is invalid"
);
const deliveryRefSchema = boundedControlSafeTextSchema(255, "Delivery ref is invalid");
const deliveryLoginSchema = v.pipe(
    boundedControlSafeTextSchema(39, "GitHub login is invalid"),
    v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, "GitHub login is invalid")
);
export function deliveryUrlUsesHttps(value: string): boolean {
    return value.startsWith("https://");
}
const deliveryHttpsUrlSchema = v.pipe(
    boundedControlSafeTextSchema(2048, "Delivery URL is invalid"),
    v.url("Delivery URL is invalid"),
    v.check(deliveryUrlUsesHttps, "Delivery URL is invalid")
);

/** Strong revision of one complete GitHub/preview/production authority snapshot. */
export const deliverySourceRevisionSchema = lowercaseSha256Schema(
    "Delivery source revision is invalid"
);
/** Strong revision of one independently mutable Delivery sub-resource. */
export const deliveryResourceRevisionSchema = lowercaseSha256Schema(
    "Delivery resource revision is invalid"
);
/** Exact lowercase Git commit used for every GitHub and release CAS. */
export const deliveryCommitShaSchema = fullCommitShaSchema(
    "Delivery commit SHA is invalid"
);

export function deliveryPullRequestBodyFitsUtf8Budget(value: string): boolean {
    return utf8ByteLength(value) <= deliveryPullRequestBodyMaximumBytes;
}

const deliveryPullRequestBodySchema = v.pipe(
    v.string("Pull request body is invalid"),
    v.maxLength(
        deliveryPullRequestBodyMaximumBytes,
        "Pull request body is outside its budget"
    ),
    v.check(
        deliveryPullRequestBodyFitsUtf8Budget,
        "Pull request body is outside its budget"
    )
);

export const deliveryExpectedHeadSchema = v.strictObject({
    headSha: deliveryCommitShaSchema,
    number: pullRequestNumberSchema,
});
export type DeliveryExpectedHead = v.InferOutput<typeof deliveryExpectedHeadSchema>;

export function expectedHeadsAreUnique(heads: DeliveryExpectedHead[]): boolean {
    return hasUniqueArrayItems(heads.map(({ number }) => number));
}

export const deliveryExpectedHeadsSchema = v.pipe(
    v.array(deliveryExpectedHeadSchema, "Delivery pull request scope is invalid"),
    v.minLength(1, "Delivery pull request scope is invalid"),
    v.maxLength(
        deliveryStackMemberMaximum,
        "Delivery pull request scope is outside its budget"
    ),
    v.check(expectedHeadsAreUnique, "Delivery pull request scope contains duplicates")
);

export const deliveryActorSchema = v.picklist(
    ["mira", "raymond"],
    "Delivery actor is invalid"
);
export type DeliveryActor = v.InferOutput<typeof deliveryActorSchema>;

export const deliveryActionCapabilityReasons = [
    "action-active",
    "already-approved",
    "ambiguous-chain",
    "checkout-unsafe",
    "checks-blocked",
    "credential-missing",
    "draft",
    "merge-conflict",
    "native-stacks-unavailable",
    "not-behind",
    "not-main-rooted",
    "preview-owned-by-other",
    "review-required",
    "self-review",
    "source-unavailable",
    "untrusted-author",
] as const;

export const deliveryActionCapabilityReasonSchema = v.picklist(
    deliveryActionCapabilityReasons,
    "Delivery action capability reason is invalid"
);
export type DeliveryActionCapabilityReason = v.InferOutput<
    typeof deliveryActionCapabilityReasonSchema
>;

export const deliveryPullRequestActionIds = [
    "approve-review",
    "create-stack",
    "merge",
    "merge-and-deploy",
    "preview-start",
    "reject",
    "update-branch",
] as const;
export const deliveryPullRequestActionIdSchema = v.picklist(
    deliveryPullRequestActionIds,
    "Delivery pull request action is invalid"
);

export const deliveryPullRequestActionScopes = ["group", "prefix", "self"] as const;
export const deliveryPullRequestActionScopeSchema = v.picklist(
    deliveryPullRequestActionScopes,
    "Delivery pull request action scope is invalid"
);
export type DeliveryPullRequestActionScope = v.InferOutput<
    typeof deliveryPullRequestActionScopeSchema
>;

const deliveryPullRequestActionCapabilityObjectSchema = v.strictObject({
    action: deliveryPullRequestActionIdSchema,
    actor: deliveryActorSchema,
    available: v.boolean("Delivery action availability is invalid"),
    reason: v.optional(deliveryActionCapabilityReasonSchema),
    scope: deliveryPullRequestActionScopeSchema,
});
export type DeliveryPullRequestActionCapability = v.InferOutput<
    typeof deliveryPullRequestActionCapabilityObjectSchema
>;

export function actionCapabilityIsConsistent(
    capability: DeliveryPullRequestActionCapability
): boolean {
    let expectedScope: DeliveryPullRequestActionScope = "self";
    if (capability.action === "create-stack") expectedScope = "group";
    if (
        capability.action === "merge" ||
        capability.action === "merge-and-deploy" ||
        capability.action === "preview-start"
    ) {
        expectedScope = "prefix";
    }
    return (
        capability.available === (capability.reason === undefined) &&
        capability.actor ===
            (capability.action === "approve-review" ? "raymond" : "mira") &&
        capability.scope === expectedScope
    );
}

export const deliveryPullRequestActionCapabilitySchema = v.pipe(
    deliveryPullRequestActionCapabilityObjectSchema,
    v.check(actionCapabilityIsConsistent, "Delivery action capability is inconsistent")
);

export function pullRequestActionsAreCanonical(
    actions: DeliveryPullRequestActionCapability[]
): boolean {
    return (
        hasUniqueArrayItems(actions.map(({ action }) => action)) &&
        actions.every(
            (action, index) =>
                index === 0 ||
                compareStrings(actions[index - 1]!.action, action.action) < 0
        )
    );
}

const deliveryPullRequestActionsSchema = v.pipe(
    v.array(
        deliveryPullRequestActionCapabilitySchema,
        "Delivery pull request actions are invalid"
    ),
    v.maxLength(
        deliveryPullRequestActionIds.length,
        "Delivery pull request actions are outside their budget"
    ),
    v.check(
        pullRequestActionsAreCanonical,
        "Delivery pull request actions are not canonical"
    )
);

export const deliveryChecksStateSchema = v.picklist(
    ["attention", "failed", "none", "passed", "running", "skipped", "unknown"],
    "Delivery checks state is invalid"
);
export const deliveryReviewStateSchema = v.picklist(
    ["approved", "changes-requested", "pending", "required", "unknown"],
    "Delivery review state is invalid"
);
export const deliveryMergeabilitySchema = v.picklist(
    ["conflicting", "mergeable", "unknown"],
    "Delivery mergeability is invalid"
);

export const deliveryPullRequestSchema = v.strictObject({
    actions: deliveryPullRequestActionsSchema,
    additions: deliveryCountSchema,
    author: deliveryLoginSchema,
    baseRef: deliveryRefSchema,
    body: v.optional(deliveryPullRequestBodySchema),
    changedFiles: deliveryCountSchema,
    checksState: deliveryChecksStateSchema,
    createdAtMs: deliveryTimestampSchema,
    deletions: deliveryCountSchema,
    headRef: deliveryRefSchema,
    headSha: deliveryCommitShaSchema,
    isCrossRepository: v.boolean("Pull request repository state is invalid"),
    isDraft: v.boolean("Pull request draft state is invalid"),
    mergeState: boundedControlSafeTextSchema(64, "Pull request merge state is invalid"),
    mergeability: deliveryMergeabilitySchema,
    number: pullRequestNumberSchema,
    reviewState: deliveryReviewStateSchema,
    title: deliveryTitleSchema,
    updatedAtMs: deliveryTimestampSchema,
    url: deliveryHttpsUrlSchema,
});
export type DeliveryPullRequest = v.InferOutput<typeof deliveryPullRequestSchema>;

export const deliveryPullRequestGroupKinds = [
    "candidate-stack",
    "native-stack",
    "read-only-chain",
    "standalone-external",
    "standalone-mira",
] as const;
export const deliveryPullRequestGroupKindSchema = v.picklist(
    deliveryPullRequestGroupKinds,
    "Delivery pull request group kind is invalid"
);
export type DeliveryPullRequestGroupKind = v.InferOutput<
    typeof deliveryPullRequestGroupKindSchema
>;

const deliveryPullRequestGroupObjectSchema = v.strictObject({
    id: lowercaseSha256Schema("Delivery pull request group id is invalid"),
    kind: deliveryPullRequestGroupKindSchema,
    members: v.pipe(
        v.array(deliveryPullRequestSchema, "Delivery pull request group is invalid"),
        v.minLength(1, "Delivery pull request group is invalid"),
        v.maxLength(
            deliveryStackMemberMaximum,
            "Delivery pull request group is outside its budget"
        )
    ),
});
export type DeliveryPullRequestGroup = v.InferOutput<
    typeof deliveryPullRequestGroupObjectSchema
>;

export function pullRequestGroupIsConsistent(group: DeliveryPullRequestGroup): boolean {
    return (
        hasUniqueArrayItems(group.members.map(({ number }) => number)) &&
        (group.kind === "candidate-stack"
            ? group.members.length >= 2
            : group.kind === "native-stack" ||
              group.kind === "read-only-chain" ||
              group.members.length === 1)
    );
}

export const deliveryPullRequestGroupSchema = v.pipe(
    deliveryPullRequestGroupObjectSchema,
    v.check(pullRequestGroupIsConsistent, "Delivery pull request group is inconsistent")
);

export function pullRequestGroupsAreCanonical(
    groups: DeliveryPullRequestGroup[]
): boolean {
    const numbers = groups.flatMap(({ members }) => members.map(({ number }) => number));
    return (
        hasUniqueArrayItems(numbers) &&
        groups.every(
            (group, index) =>
                index === 0 || compareStrings(groups[index - 1]!.id, group.id) < 0
        ) &&
        numbers.length <= deliveryPullRequestMaximum
    );
}

export const deliveryPullRequestGroupsSchema = v.pipe(
    v.array(deliveryPullRequestGroupSchema, "Delivery pull request groups are invalid"),
    v.maxLength(
        deliveryPullRequestGroupMaximum,
        "Delivery pull request groups are outside their budget"
    ),
    v.check(
        pullRequestGroupsAreCanonical,
        "Delivery pull request groups are not canonical"
    )
);

export const deliveryReviewerCapabilitySchema = v.variant("available", [
    v.strictObject({
        actor: v.literal("raymond"),
        available: v.literal(true),
        revision: deliveryResourceRevisionSchema,
    }),
    v.strictObject({
        actor: v.literal("raymond"),
        available: v.literal(false),
        reason: v.picklist(
            ["credential-missing", "identity-mismatch", "provider-unavailable"],
            "Delivery reviewer capability reason is invalid"
        ),
        revision: deliveryResourceRevisionSchema,
    }),
]);
export type DeliveryReviewerCapability = v.InferOutput<
    typeof deliveryReviewerCapabilitySchema
>;

export const deliveryPreviewStatusSchema = v.picklist(
    ["failed", "running", "starting", "stopped", "stopping", "view-only"],
    "Delivery preview status is invalid"
);
const deliveryPreviewObjectSchema = v.strictObject({
    controlsAvailable: v.boolean("Delivery preview control state is invalid"),
    headSha: v.optional(deliveryCommitShaSchema),
    number: v.optional(pullRequestNumberSchema),
    reason: v.optional(deliveryTextSchema),
    revision: deliveryResourceRevisionSchema,
    startedAtMs: v.optional(deliveryTimestampSchema),
    status: deliveryPreviewStatusSchema,
    title: v.optional(deliveryTitleSchema),
    updatedAtMs: deliveryTimestampSchema,
    url: v.optional(deliveryHttpsUrlSchema),
});
export type DeliveryPreview = v.InferOutput<typeof deliveryPreviewObjectSchema>;

export function deliveryPreviewIsConsistent(preview: DeliveryPreview): boolean {
    const hasOwner = preview.number !== undefined && preview.headSha !== undefined;
    return (
        (preview.number === undefined) === (preview.headSha === undefined) &&
        (preview.url === undefined || hasOwner) &&
        (preview.status !== "view-only" || !preview.controlsAvailable) &&
        (preview.status === "stopped" || preview.status === "view-only" || hasOwner)
    );
}

export const deliveryPreviewSchema = v.pipe(
    deliveryPreviewObjectSchema,
    v.check(deliveryPreviewIsConsistent, "Delivery preview is inconsistent")
);

export const deliveryCheckoutConditionSchema = v.picklist(
    ["dirty", "off-main", "ready", "unavailable", "wrong-root"],
    "Delivery checkout condition is invalid"
);
const deliveryCheckoutObjectSchema = v.strictObject({
    branch: deliveryRefSchema,
    condition: deliveryCheckoutConditionSchema,
    expectedBranch: v.literal("main", "Delivery expected branch is invalid"),
    headSha: deliveryCommitShaSchema,
    remoteHeadSha: deliveryCommitShaSchema,
    revision: deliveryResourceRevisionSchema,
    safeForDeploy: v.boolean("Delivery checkout safety is invalid"),
    upstream: v.optional(deliveryRefSchema),
});
export type DeliveryCheckout = v.InferOutput<typeof deliveryCheckoutObjectSchema>;
export function deliveryCheckoutSafetyIsConsistent(checkout: DeliveryCheckout): boolean {
    return checkout.safeForDeploy === (checkout.condition === "ready");
}
export const deliveryCheckoutSchema = v.pipe(
    deliveryCheckoutObjectSchema,
    v.check(
        deliveryCheckoutSafetyIsConsistent,
        "Delivery checkout safety is inconsistent"
    )
);

export const deliveryReleaseSchema = v.strictObject({
    builtAtMs: deliveryTimestampSchema,
    commitTitle: deliveryTitleSchema,
    commitUrl: deliveryHttpsUrlSchema,
    releaseId: deliveryCommitShaSchema,
    runtimeRevision: deliveryCommitShaSchema,
    schemaTarget: nonnegativeSafeIntegerSchema("Delivery schema target is invalid"),
});
export type DeliveryRelease = v.InferOutput<typeof deliveryReleaseSchema>;

export const deliveryRollbackTargetSchema = v.strictObject({
    databaseSnapshotTransitionId: lowercaseUuidV7Schema(
        "Delivery rollback snapshot identity is invalid"
    ),
    releaseId: deliveryCommitShaSchema,
    runtimeRevision: deliveryCommitShaSchema,
});
export type DeliveryRollbackTarget = v.InferOutput<typeof deliveryRollbackTargetSchema>;

const deliveryReleasesObjectSchema = v.strictObject({
    activationRevision: deliveryResourceRevisionSchema,
    current: v.optional(deliveryReleaseSchema),
    previous: v.optional(deliveryReleaseSchema),
    rollback: v.variant("available", [
        v.strictObject({
            actor: v.literal("mira"),
            available: v.literal(true),
            target: deliveryRollbackTargetSchema,
        }),
        v.strictObject({
            actor: v.literal("mira"),
            available: v.literal(false),
            reason: v.picklist(
                [
                    "action-active",
                    "incompatible",
                    "no-previous-release",
                    "source-unavailable",
                ],
                "Delivery rollback reason is invalid"
            ),
        }),
    ]),
});
export type DeliveryReleases = v.InferOutput<typeof deliveryReleasesObjectSchema>;

export function deliveryReleasesAreConsistent(releases: DeliveryReleases): boolean {
    const distinctSlots =
        releases.current === undefined ||
        releases.previous === undefined ||
        releases.current.releaseId !== releases.previous.releaseId;
    if (!distinctSlots) return false;
    if (!releases.rollback.available) return true;
    return (
        releases.previous !== undefined &&
        releases.rollback.target.releaseId === releases.previous.releaseId &&
        releases.rollback.target.runtimeRevision === releases.previous.runtimeRevision
    );
}

export const deliveryReleasesSchema = v.pipe(
    deliveryReleasesObjectSchema,
    v.check(deliveryReleasesAreConsistent, "Delivery release slots are inconsistent")
);

const deliveryOperationAuthoritySnapshotObjectSchema = v.strictObject({
    checkout: deliveryCheckoutSchema,
    observedAtMs: deliveryTimestampSchema,
    preview: deliveryPreviewSchema,
    pullRequestGroups: deliveryPullRequestGroupsSchema,
    releases: deliveryReleasesSchema,
    reviewerCapability: deliveryReviewerCapabilitySchema,
    sourceRevision: deliverySourceRevisionSchema,
});
export type DeliveryOperationAuthoritySnapshot = v.InferOutput<
    typeof deliveryOperationAuthoritySnapshotObjectSchema
>;

/** @returns Whether the ephemeral operation authority remains bounded in memory. */
export function deliveryOperationAuthoritySnapshotFitsBudget(
    payload: DeliveryOperationAuthoritySnapshot
): boolean {
    return (
        utf8ByteLength(JSON.stringify(payload)) <= deliveryPullRequestsPayloadMaximumBytes
    );
}

/** @returns Whether every action scope references exact heads in this same snapshot. */
export function deliveryOperationAuthoritySnapshotReferencesAreConsistent(
    payload: DeliveryOperationAuthoritySnapshot
): boolean {
    return payload.pullRequestGroups.every(({ members }) =>
        members.every((pullRequest, index) =>
            pullRequest.actions.every(({ scope }) => {
                if (scope === "self") return true;
                if (scope === "prefix") return index < members.length;
                return members.length >= 2;
            })
        )
    );
}

export const deliveryOperationAuthoritySnapshotSchema = v.pipe(
    deliveryOperationAuthoritySnapshotObjectSchema,
    v.check(
        deliveryOperationAuthoritySnapshotFitsBudget,
        "Delivery operation authority is outside its budget"
    ),
    v.check(
        deliveryOperationAuthoritySnapshotReferencesAreConsistent,
        "Delivery operation authority references are inconsistent"
    )
);

const deliverySectionBaseEntries = {
    observedAtMs: deliveryTimestampSchema,
    sourceRevision: deliverySourceRevisionSchema,
} as const;
const deliveryPullRequestsCachePayloadObjectSchema = v.strictObject({
    ...deliverySectionBaseEntries,
    groups: deliveryPullRequestGroupsSchema,
    reviewerCapability: deliveryReviewerCapabilitySchema,
});
export const deliveryPreviewCachePayloadSchema = v.strictObject({
    ...deliverySectionBaseEntries,
    actionActive: v.boolean("Delivery action activity is invalid"),
    preview: deliveryPreviewSchema,
});
export const deliveryCheckoutCachePayloadSchema = v.strictObject({
    ...deliverySectionBaseEntries,
    checkout: deliveryCheckoutSchema,
});
export const deliveryReleasesCachePayloadSchema = v.strictObject({
    ...deliverySectionBaseEntries,
    actionActive: v.boolean("Delivery action activity is invalid"),
    releases: deliveryReleasesSchema,
});
export type DeliveryPullRequestsCachePayload = v.InferOutput<
    typeof deliveryPullRequestsCachePayloadObjectSchema
>;
export type DeliveryPreviewCachePayload = v.InferOutput<
    typeof deliveryPreviewCachePayloadSchema
>;
export type DeliveryCheckoutCachePayload = v.InferOutput<
    typeof deliveryCheckoutCachePayloadSchema
>;
export type DeliveryReleasesCachePayload = v.InferOutput<
    typeof deliveryReleasesCachePayloadSchema
>;

/** @returns Whether the independently retained PR inventory fits its reviewed row budget. */
export function deliveryPullRequestsCachePayloadFitsBudget(
    payload: DeliveryPullRequestsCachePayload
): boolean {
    return (
        utf8ByteLength(JSON.stringify(payload)) <= deliveryPullRequestsPayloadMaximumBytes
    );
}

/** @returns Whether every action scope is representable by its owning canonical group. */
export function deliveryPullRequestsCachePayloadReferencesAreConsistent(
    payload: DeliveryPullRequestsCachePayload
): boolean {
    return payload.groups.every(({ members }) =>
        members.every((pullRequest, index) =>
            pullRequest.actions.every(({ scope }) => {
                if (scope === "self") return true;
                if (scope === "prefix") return index < members.length;
                return members.length >= 2;
            })
        )
    );
}

export const deliveryPullRequestsCachePayloadSchema = v.pipe(
    deliveryPullRequestsCachePayloadObjectSchema,
    v.check(
        deliveryPullRequestsCachePayloadFitsBudget,
        "Delivery pull request cache payload is outside its budget"
    ),
    v.check(
        deliveryPullRequestsCachePayloadReferencesAreConsistent,
        "Delivery pull request cache references are inconsistent"
    )
);

export const deliveryOverviewSectionPayloadSchemas = Object.freeze({
    checkout: deliveryCheckoutCachePayloadSchema,
    preview: deliveryPreviewCachePayloadSchema,
    "pull-requests": deliveryPullRequestsCachePayloadSchema,
    releases: deliveryReleasesCachePayloadSchema,
});
export type DeliveryOverviewSectionPayload =
    | DeliveryPullRequestsCachePayload
    | DeliveryPreviewCachePayload
    | DeliveryCheckoutCachePayload
    | DeliveryReleasesCachePayload;
export interface DeliveryOverviewSectionPayloadById {
    readonly checkout: DeliveryCheckoutCachePayload;
    readonly preview: DeliveryPreviewCachePayload;
    readonly "pull-requests": DeliveryPullRequestsCachePayload;
    readonly releases: DeliveryReleasesCachePayload;
}

const unavailableReadEntries = {
    checkedAtMs: deliveryTimestampSchema,
    state: v.literal("unavailable"),
} as const;
const freshReadEntries = {
    checkedAtMs: deliveryTimestampSchema,
    observedAtMs: deliveryTimestampSchema,
    sourceRevision: deliverySourceRevisionSchema,
    state: v.literal("fresh"),
} as const;
const retainedReadEntries = {
    ...freshReadEntries,
    staleSinceMs: deliveryTimestampSchema,
    state: v.literal("last-known-good"),
} as const;

function readResultSchema<TEntries extends v.ObjectEntries>(entries: TEntries) {
    return v.variant("state", [
        v.strictObject(unavailableReadEntries),
        v.strictObject({ ...entries, ...freshReadEntries }),
        v.strictObject({ ...entries, ...retainedReadEntries }),
    ]);
}

const deliveryPullRequestsResultVariantSchema = readResultSchema({
    groups: deliveryPullRequestGroupsSchema,
    reviewerCapability: deliveryReviewerCapabilitySchema,
});
const deliveryPreviewResultVariantSchema = readResultSchema({
    actionActive: v.boolean("Delivery action activity is invalid"),
    preview: deliveryPreviewSchema,
});
const deliveryProductionCheckoutResultVariantSchema = readResultSchema({
    checkout: deliveryCheckoutSchema,
});
const deliveryReleasesResultVariantSchema = readResultSchema({
    actionActive: v.boolean("Delivery action activity is invalid"),
    releases: deliveryReleasesSchema,
});

export function readFreshnessIsCausal<
    T extends {
        readonly checkedAtMs: number;
        readonly observedAtMs?: number;
        readonly staleSinceMs?: number;
        readonly state: string;
    },
>(value: T): boolean {
    if (value.state === "unavailable") return true;
    if (value.observedAtMs === undefined || value.observedAtMs > value.checkedAtMs) {
        return false;
    }
    return (
        value.state === "fresh" ||
        (value.staleSinceMs !== undefined &&
            value.staleSinceMs >= value.observedAtMs &&
            value.staleSinceMs <= value.checkedAtMs)
    );
}

export const deliveryPreviewResultSchema = v.pipe(
    deliveryPreviewResultVariantSchema,
    v.check(readFreshnessIsCausal, "Delivery read freshness is inconsistent")
);
export const deliveryPullRequestsResultSchema = v.pipe(
    deliveryPullRequestsResultVariantSchema,
    v.check(readFreshnessIsCausal, "Delivery read freshness is inconsistent")
);
export const deliveryProductionCheckoutResultSchema = v.pipe(
    deliveryProductionCheckoutResultVariantSchema,
    v.check(readFreshnessIsCausal, "Delivery read freshness is inconsistent")
);
export const deliveryReleasesResultSchema = v.pipe(
    deliveryReleasesResultVariantSchema,
    v.check(readFreshnessIsCausal, "Delivery read freshness is inconsistent")
);

export const deliveryDeploymentOperations = [
    "deploy",
    "merge-and-deploy",
    "rollback-release",
] as const;
export const deliveryDeploymentOperationSchema = v.picklist(
    deliveryDeploymentOperations,
    "Delivery deployment operation is invalid"
);
const deliveryDeploymentBaseSchema = {
    commitSha: v.optional(deliveryCommitShaSchema),
    commitTitle: v.optional(deliveryTitleSchema),
    commitUrl: v.optional(deliveryHttpsUrlSchema),
    jobRunId: jobRunIdSchema,
    note: v.optional(deliveryTextSchema),
    operation: deliveryDeploymentOperationSchema,
    queuedAtMs: deliveryTimestampSchema,
    updatedAtMs: deliveryTimestampSchema,
} as const;
const deliveryDeploymentPostSettlementWarningsSchema = v.optional(
    v.tuple([v.literal("delivery-overview-refresh-failed")])
);
const deliveryDeploymentSucceededBaseSchema = {
    ...deliveryDeploymentBaseSchema,
    postSettlementWarnings: deliveryDeploymentPostSettlementWarningsSchema,
    state: v.literal("succeeded"),
} as const;
export const deliveryDeploymentSchema = v.union([
    v.strictObject({
        ...deliveryDeploymentSucceededBaseSchema,
        outcome: v.literal("completed"),
    }),
    v.strictObject({
        ...deliveryDeploymentSucceededBaseSchema,
        outcome: v.literal("completed-with-warnings"),
        warnings: deliveryOperationWarningsSchema(
            "Delivery deployment warnings are invalid"
        ),
    }),
    v.strictObject({
        ...deliveryDeploymentSucceededBaseSchema,
        outcome: v.literal("enqueued"),
    }),
    v.strictObject({
        ...deliveryDeploymentSucceededBaseSchema,
        outcome: v.literal("unknown-outcome"),
    }),
    v.strictObject({
        ...deliveryDeploymentBaseSchema,
        state: v.picklist(
            ["cancelled", "failed", "queued", "running", "timed-out"],
            "Delivery deployment state is invalid"
        ),
    }),
]);
export type DeliveryDeployment = v.InferOutput<typeof deliveryDeploymentSchema>;

function compareDeployments(left: DeliveryDeployment, right: DeliveryDeployment): number {
    return (
        right.updatedAtMs - left.updatedAtMs ||
        compareStrings(left.jobRunId, right.jobRunId)
    );
}
export function deliveryDeploymentsAreCanonical(items: DeliveryDeployment[]): boolean {
    return (
        hasUniqueArrayItems(items.map(({ jobRunId }) => jobRunId)) &&
        items.every(
            (item, index) =>
                index === 0 || compareDeployments(items[index - 1]!, item) < 0
        )
    );
}
export const deliveryDeploymentsSchema = v.pipe(
    v.array(deliveryDeploymentSchema, "Delivery deployments are invalid"),
    v.maxLength(
        deliveryDeploymentMaximum,
        "Delivery deployments are outside their budget"
    ),
    v.check(deliveryDeploymentsAreCanonical, "Delivery deployments are not canonical")
);
export const deliveryDeploymentsResultSchema = v.variant("state", [
    v.strictObject(unavailableReadEntries),
    v.strictObject({
        checkedAtMs: deliveryTimestampSchema,
        deployments: deliveryDeploymentsSchema,
        state: v.literal("fresh"),
    }),
]);

export const deliveryOperationIds = [
    "approve-review",
    "create-pull-request-stack",
    "deploy",
    "merge-pull-request",
    "reject-pull-request",
    "rollback-release",
    "start-preview",
    "stop-preview",
    "update-branch",
] as const;
export const deliveryOperationIdSchema = v.picklist(
    deliveryOperationIds,
    "Delivery operation is invalid"
);
export type DeliveryOperationId = v.InferOutput<typeof deliveryOperationIdSchema>;

const deliveryOperationBase = {
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: deliverySourceRevisionSchema,
} as const;
const exactPullRequest = {
    expectedHeadSha: deliveryCommitShaSchema,
    number: pullRequestNumberSchema,
} as const;

const createStackInputSchema = v.strictObject({
    confirmation: v.literal("create-delivery-stack"),
    expectedHeads: v.pipe(
        deliveryExpectedHeadsSchema,
        v.minLength(2, "Delivery stack must contain at least two pull requests")
    ),
    operation: v.literal("create-pull-request-stack"),
    ...deliveryOperationBase,
});
const mergeBase = {
    checkoutRevision: deliveryResourceRevisionSchema,
    confirmation: v.literal("merge-delivery-pull-request"),
    expectedHeads: deliveryExpectedHeadsSchema,
    mergeStack: v.boolean("Delivery stack merge state is invalid"),
    operation: v.literal("merge-pull-request"),
    ...deliveryOperationBase,
    number: pullRequestNumberSchema,
} as const;
const mergeInputSchema = v.variant("deploy", [
    v.strictObject({ ...mergeBase, deploy: v.literal(false) }),
    v.strictObject({
        ...mergeBase,
        activationRevision: deliveryResourceRevisionSchema,
        confirmation: v.literal("merge-and-deploy-delivery-pull-request"),
        deploy: v.literal(true),
    }),
]);

export function selectedPullRequestEndsScope<
    T extends {
        readonly expectedHeads: DeliveryExpectedHead[];
        readonly number: number;
    },
>(value: T): boolean {
    return value.expectedHeads.at(-1)?.number === value.number;
}

const startPreviewInputObjectSchema = v.strictObject({
    confirmation: v.literal("start-delivery-preview"),
    expectedHeads: deliveryExpectedHeadsSchema,
    number: pullRequestNumberSchema,
    operation: v.literal("start-preview"),
    previewRevision: deliveryResourceRevisionSchema,
    ...deliveryOperationBase,
});
const approveReviewInputObjectSchema = v.strictObject({
    confirmation: v.literal("approve-delivery-review"),
    ...exactPullRequest,
    operation: v.literal("approve-review"),
    reviewerRevision: deliveryResourceRevisionSchema,
    ...deliveryOperationBase,
});
const deployInputObjectSchema = v.strictObject({
    activationRevision: deliveryResourceRevisionSchema,
    checkoutRevision: deliveryResourceRevisionSchema,
    confirmation: v.literal("deploy-delivery-main"),
    expectedMainHeadSha: deliveryCommitShaSchema,
    operation: v.literal("deploy"),
    ...deliveryOperationBase,
});
const rejectPullRequestInputObjectSchema = v.strictObject({
    confirmation: v.literal("reject-delivery-pull-request"),
    ...exactPullRequest,
    operation: v.literal("reject-pull-request"),
    ...deliveryOperationBase,
});
const rollbackReleaseInputObjectSchema = v.strictObject({
    activationRevision: deliveryResourceRevisionSchema,
    confirmation: v.literal("rollback-delivery-release"),
    operation: v.literal("rollback-release"),
    ...deliveryOperationBase,
    target: deliveryRollbackTargetSchema,
});
const stopPreviewInputObjectSchema = v.strictObject({
    confirmation: v.literal("stop-delivery-preview"),
    number: pullRequestNumberSchema,
    operation: v.literal("stop-preview"),
    previewRevision: deliveryResourceRevisionSchema,
    ...deliveryOperationBase,
});
const updateBranchInputObjectSchema = v.strictObject({
    confirmation: v.literal("update-delivery-pull-request-branch"),
    ...exactPullRequest,
    operation: v.literal("update-branch"),
    ...deliveryOperationBase,
});
/** Recent-MFA, idempotent, exact-state Delivery mutation request. */
const deliveryRequestOperationInputVariantSchema = v.variant("operation", [
    approveReviewInputObjectSchema,
    createStackInputSchema,
    deployInputObjectSchema,
    mergeInputSchema,
    rejectPullRequestInputObjectSchema,
    rollbackReleaseInputObjectSchema,
    startPreviewInputObjectSchema,
    stopPreviewInputObjectSchema,
    updateBranchInputObjectSchema,
]);

export function operationScopeIsConsistent(
    input: v.InferOutput<typeof deliveryRequestOperationInputVariantSchema>
): boolean {
    return (
        (input.operation !== "merge-pull-request" &&
            input.operation !== "start-preview") ||
        selectedPullRequestEndsScope(input)
    );
}

export const deliveryRequestOperationInputSchema = v.pipe(
    deliveryRequestOperationInputVariantSchema,
    v.check(
        operationScopeIsConsistent,
        "Delivery selected pull request does not end its scope"
    )
);
export type DeliveryRequestOperationInput = v.InferOutput<
    typeof deliveryRequestOperationInputSchema
>;

export const deliveryRequestOperationResultSchema = v.strictObject({
    jobRunId: jobRunIdSchema,
    operation: deliveryOperationIdSchema,
    queued: v.literal(true, "Delivery operation queue result is invalid"),
});
export type DeliveryRequestOperationResult = v.InferOutput<
    typeof deliveryRequestOperationResultSchema
>;

export type DeliveryPullRequestsResult = v.InferOutput<
    typeof deliveryPullRequestsResultSchema
>;
export type DeliveryPreviewResult = v.InferOutput<typeof deliveryPreviewResultSchema>;
export type DeliveryProductionCheckoutResult = v.InferOutput<
    typeof deliveryProductionCheckoutResultSchema
>;
export type DeliveryReleasesResult = v.InferOutput<typeof deliveryReleasesResultSchema>;
export type DeliveryDeploymentsResult = v.InferOutput<
    typeof deliveryDeploymentsResultSchema
>;

const deliveryEmptyInputSchema = v.optional(v.strictObject({}), {});
export const deliveryListPullRequestsInputSchema = deliveryEmptyInputSchema;
export const deliveryListDeploymentsInputSchema = deliveryEmptyInputSchema;
export const deliveryGetPreviewInputSchema = deliveryEmptyInputSchema;
export const deliveryGetProductionCheckoutInputSchema = deliveryEmptyInputSchema;
export const deliveryGetReleasesInputSchema = deliveryEmptyInputSchema;
export const deliveryApprovePullRequestInputSchema = v.pipe(
    mergeInputSchema,
    v.check(
        selectedPullRequestEndsScope,
        "Delivery selected pull request does not end its scope"
    )
);
export const deliveryStartPreviewInputSchema = v.pipe(
    startPreviewInputObjectSchema,
    v.check(
        selectedPullRequestEndsScope,
        "Delivery selected preview does not end its scope"
    )
);
export const deliveryStopPreviewInputSchema = stopPreviewInputObjectSchema;
export const deliveryRejectPullRequestInputSchema = rejectPullRequestInputObjectSchema;
export const deliveryApproveReviewInputSchema = approveReviewInputObjectSchema;
export const deliveryUpdateBranchInputSchema = updateBranchInputObjectSchema;
export const deliveryDeployInputSchema = deployInputObjectSchema;
export const deliveryRollbackReleaseInputSchema = rollbackReleaseInputObjectSchema;
export const deliveryCreatePullRequestStackInputSchema = createStackInputSchema;

const deliveryReadAccess = {
    capabilities: ["delivery:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const deliveryWriteAccess = {
    capabilities: ["delivery:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const readErrors = ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"] as const;
const mutationErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "SERVICE_UNAVAILABLE",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
] as const;
const mutationErrorReasons = [
    "mfa_enrollment_required",
    "operation_outcome_unknown",
    "step_up_required",
] as const;

function readContract(
    name: string,
    output: v.GenericSchema,
    summary: string
): ProcedureContract {
    return {
        access: deliveryReadAccess,
        domain: "delivery",
        errors: readErrors,
        input: deliveryEmptyInputSchema,
        inputSchemaId: `${name}.input`,
        kind: "query",
        name,
        output,
        outputSchemaId: `${name}.output`,
        summary,
        transport: queryTransport,
    };
}

function mutationContract(
    name: string,
    input: v.GenericSchema,
    summary: string
): ProcedureContract {
    return {
        access: deliveryWriteAccess,
        domain: "delivery",
        errorReasons: mutationErrorReasons,
        errors: mutationErrors,
        input,
        inputSchemaId: `${name}.input`,
        kind: "mutation",
        name,
        output: deliveryRequestOperationResultSchema,
        outputSchemaId: `${name}.output`,
        summary,
        transport: mutationTransport,
    };
}

/** Five isolated reads and nine exact recent-MFA Delivery mutations. */
export const deliveryProcedureContracts = [
    readContract(
        "delivery.listPullRequests",
        deliveryPullRequestsResultSchema,
        "Lists bounded server-authoritative pull request groups and action capabilities."
    ),
    readContract(
        "delivery.listDeployments",
        deliveryDeploymentsResultSchema,
        "Lists the ten latest sanitized Delivery production jobs."
    ),
    readContract(
        "delivery.getPreview",
        deliveryPreviewResultSchema,
        "Reads the single bounded pull request preview slot."
    ),
    readContract(
        "delivery.getProductionCheckout",
        deliveryProductionCheckoutResultSchema,
        "Reads sanitized production checkout safety without host paths or dirty filenames."
    ),
    readContract(
        "delivery.getReleases",
        deliveryReleasesResultSchema,
        "Reads authoritative current and previous immutable release identities."
    ),
    mutationContract(
        "delivery.approvePullRequest",
        deliveryApprovePullRequestInputSchema,
        "Queues an exact-head squash merge, optionally followed by one fenced deployment."
    ),
    mutationContract(
        "delivery.startPreview",
        deliveryStartPreviewInputSchema,
        "Queues one exact-scope isolated preview start or rebuild."
    ),
    mutationContract(
        "delivery.stopPreview",
        deliveryStopPreviewInputSchema,
        "Queues a stop for the exact owning preview revision."
    ),
    mutationContract(
        "delivery.rejectPullRequest",
        deliveryRejectPullRequestInputSchema,
        "Queues an exact-head close using the fixed Dashboard comment."
    ),
    mutationContract(
        "delivery.approveReview",
        deliveryApproveReviewInputSchema,
        "Queues only Raymond's exact-head review approval without identity fallback."
    ),
    mutationContract(
        "delivery.updateBranch",
        deliveryUpdateBranchInputSchema,
        "Queues an exact-head GitHub branch update."
    ),
    mutationContract(
        "delivery.deploy",
        deliveryDeployInputSchema,
        "Queues an exact-main immutable production deployment."
    ),
    mutationContract(
        "delivery.rollbackRelease",
        deliveryRollbackReleaseInputSchema,
        "Queues rollback to the exact authoritative previous release/runtime/snapshot tuple."
    ),
    mutationContract(
        "delivery.createPullRequestStack",
        deliveryCreatePullRequestStackInputSchema,
        "Queues native stack creation for one exact ordered pull request scope."
    ),
] as const satisfies readonly ProcedureContract[];
