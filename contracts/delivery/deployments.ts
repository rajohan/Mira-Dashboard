import * as v from "valibot";

import { finiteNumberSchema, parseContract, strictJsonObjectSchema } from "../runtime";
import { fullCommitShaSchema, trimmedNonEmptyStringSchema } from "./shared";

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

export const dashboardRollbackRequestSchema = strictJsonObjectSchema({
    targetCommit: fullCommitShaSchema,
});

export type DeploymentJob = v.InferOutput<typeof deploymentJobSchema>;
export type DashboardReleaseSummary = v.InferOutput<typeof dashboardReleaseSummarySchema>;
export type DashboardReleaseStatus = v.InferOutput<typeof dashboardReleaseStatusSchema>;
export type ProductionCheckoutStatus = v.InferOutput<
    typeof productionCheckoutStatusSchema
>;
export type DashboardRollbackRequest = v.InferOutput<
    typeof dashboardRollbackRequestSchema
>;

/**
 * Parses a managed-release rollback request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed managed-release rollback request.
 */
export function parseDashboardRollbackRequest(value: unknown): DashboardRollbackRequest {
    return parseContract(dashboardRollbackRequestSchema, value);
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
