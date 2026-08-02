import * as v from "valibot";

import { parseContract, successLiteralSchema } from "../runtime";
import {
    dashboardReleaseStatusSchema,
    deploymentJobSchema,
    productionCheckoutStatusSchema,
} from "./deployments";
import {
    pullRequestPreviewCleanupResultSchema,
    pullRequestPreviewStatusSchema,
    worktreeCleanupResultSchema,
} from "./previews";
import { pullRequestSummarySchema } from "./pullRequests";

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
