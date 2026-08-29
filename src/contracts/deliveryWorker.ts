import * as v from "valibot";

import { deliveryOperationWarningsSchema } from "../shared/deliveryOperationWarnings.ts";
import { deliveryProductionJobPayloadSchema } from "../shared/deliveryProductionOperation.ts";
import {
    type DeliveryCheckoutCachePayload,
    type DeliveryExpectedHead,
    type DeliveryOverviewSectionId,
    type DeliveryPreviewCachePayload,
    type DeliveryPullRequestsCachePayload,
    type DeliveryReleasesCachePayload,
    deliveryCommitShaSchema,
    deliveryExpectedHeadsSchema,
    deliveryOperationIdSchema,
    deliveryResourceRevisionSchema,
    deliverySourceRevisionSchema,
} from "./delivery.ts";
import type { JobExecutionRunIdentity } from "./jobModel.ts";

export type DeliveryJobProgressReporter = (
    progress: Readonly<Record<string, string | number | boolean>>
) => Promise<void>;

export const deliveryGitHubActionKey = "delivery.github";
export const deliveryPreviewActionKey = "delivery.preview";
/** Versioned cross-release protocol key proved by both cutover releases. */
export const deliveryProductionActionKey = "delivery.production.v1";

export {
    deliveryOperationWarningCodes,
    type DeliveryOperationWarningCode,
} from "../shared/deliveryOperationWarnings.ts";
export type { DeliveryProductionJobPayload } from "../shared/deliveryProductionOperation.ts";

const workerOperationBase = {
    sourceRevision: deliverySourceRevisionSchema,
} as const;
const exactPullRequest = {
    expectedHeadSha: deliveryCommitShaSchema,
    number: v.pipe(
        v.number("Pull request number is invalid"),
        v.safeInteger("Pull request number is invalid"),
        v.minValue(1, "Pull request number is invalid")
    ),
} as const;

const mergePayloadSchema = v.strictObject({
    checkoutRevision: deliveryResourceRevisionSchema,
    expectedHeads: deliveryExpectedHeadsSchema,
    mergeStack: v.boolean("Delivery stack merge state is invalid"),
    number: exactPullRequest.number,
    operation: v.literal("merge-pull-request"),
    ...workerOperationBase,
});

function selectedPullRequestEndsScope(value: {
    readonly expectedHeads: DeliveryExpectedHead[];
    readonly number: number;
}): boolean {
    return value.expectedHeads.at(-1)?.number === value.number;
}

const startPreviewPayloadObjectSchema = v.strictObject({
    expectedHeads: deliveryExpectedHeadsSchema,
    number: exactPullRequest.number,
    operation: v.literal("start-preview"),
    previewRevision: deliveryResourceRevisionSchema,
    ...workerOperationBase,
});

/** Exact typed payloads accepted by the three Delivery worker actions. */
const nonProductionJobPayloadSchema = v.variant("operation", [
    v.strictObject({
        ...exactPullRequest,
        operation: v.literal("approve-review"),
        reviewerRevision: deliveryResourceRevisionSchema,
        ...workerOperationBase,
    }),
    v.strictObject({
        expectedHeads: v.pipe(
            deliveryExpectedHeadsSchema,
            v.minLength(2, "Delivery stack must contain at least two pull requests")
        ),
        operation: v.literal("create-pull-request-stack"),
        ...workerOperationBase,
    }),
    mergePayloadSchema,
    v.strictObject({
        ...exactPullRequest,
        operation: v.literal("reject-pull-request"),
        ...workerOperationBase,
    }),
    startPreviewPayloadObjectSchema,
    v.strictObject({
        number: exactPullRequest.number,
        operation: v.literal("stop-preview"),
        previewRevision: deliveryResourceRevisionSchema,
        ...workerOperationBase,
    }),
    v.strictObject({
        ...exactPullRequest,
        operation: v.literal("update-branch"),
        ...workerOperationBase,
    }),
]);

const deliveryOperationJobPayloadVariantSchema = v.union([
    nonProductionJobPayloadSchema,
    deliveryProductionJobPayloadSchema,
]);

function operationScopeIsConsistent(
    payload: v.InferOutput<typeof deliveryOperationJobPayloadVariantSchema>
): boolean {
    return (
        (payload.operation !== "merge-pull-request" &&
            payload.operation !== "start-preview") ||
        selectedPullRequestEndsScope(payload)
    );
}

export const deliveryOperationJobPayloadSchema = v.pipe(
    deliveryOperationJobPayloadVariantSchema,
    v.check(
        operationScopeIsConsistent,
        "Delivery selected pull request does not end its scope"
    )
);

export type DeliveryOperationJobPayload = v.InferOutput<
    typeof deliveryOperationJobPayloadSchema
>;
/** @returns The only registered durable action allowed for one Delivery payload. */
export function deliveryJobActionKeyForPayload(
    payload: DeliveryOperationJobPayload
):
    | typeof deliveryGitHubActionKey
    | typeof deliveryPreviewActionKey
    | typeof deliveryProductionActionKey {
    if (payload.operation === "start-preview" || payload.operation === "stop-preview") {
        return deliveryPreviewActionKey;
    }
    if (payload.operation === "deploy" || payload.operation === "rollback-release") {
        return deliveryProductionActionKey;
    }
    return deliveryGitHubActionKey;
}

export const deliveryJobOperationResultSchema = v.pipe(
    v.strictObject({
        operation: deliveryOperationIdSchema,
        outcome: v.picklist(
            ["completed", "completed-with-warnings", "enqueued", "unknown-outcome"],
            "Delivery job outcome is invalid"
        ),
        releaseId: v.optional(deliveryCommitShaSchema),
        warnings: v.optional(
            deliveryOperationWarningsSchema("Delivery job warnings are invalid")
        ),
    }),
    v.check(
        (result) =>
            result.outcome === "completed-with-warnings"
                ? result.warnings !== undefined && result.warnings.length > 0
                : result.warnings === undefined,
        "Delivery job warnings are invalid"
    )
);
export type DeliveryJobOperationResult = v.InferOutput<
    typeof deliveryJobOperationResultSchema
>;

export type DeliveryOverviewSectionRefreshResult =
    | Readonly<{
          payload: DeliveryCheckoutCachePayload;
          section: "checkout";
          state: "succeeded";
      }>
    | Readonly<{
          payload: DeliveryPreviewCachePayload;
          section: "preview";
          state: "succeeded";
      }>
    | Readonly<{
          payload: DeliveryPullRequestsCachePayload;
          section: "pull-requests";
          state: "succeeded";
      }>
    | Readonly<{
          payload: DeliveryReleasesCachePayload;
          section: "releases";
          state: "succeeded";
      }>
    | Readonly<{
          section: DeliveryOverviewSectionId;
          state: "failed";
      }>;

export type DeliveryOverviewPreviousSections = Readonly<
    Partial<Record<DeliveryOverviewSectionId, unknown>>
>;

/** Worker authority for bounded refreshes and typed Delivery effects only. */
export interface DeliveryJobExecutionPort {
    readonly execute: (
        payload: DeliveryOperationJobPayload,
        signal?: AbortSignal,
        runIdentity?: JobExecutionRunIdentity,
        reportProgress?: DeliveryJobProgressReporter
    ) => Promise<DeliveryJobOperationResult>;
    readonly readPrevious: (section: DeliveryOverviewSectionId) => unknown;
    readonly refresh: (
        previous: DeliveryOverviewPreviousSections,
        signal?: AbortSignal
    ) => Promise<readonly DeliveryOverviewSectionRefreshResult[]>;
}

/**
 * Parses the only payload shape accepted by manual Delivery worker actions.
 * @param input Untrusted durable job payload.
 * @returns One strict Delivery operation payload.
 */
export function parseDeliveryOperationJobPayload(
    input: unknown
): DeliveryOperationJobPayload {
    return v.parse(deliveryOperationJobPayloadSchema, input);
}
