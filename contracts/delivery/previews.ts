import * as v from "valibot";

import { finiteNumberSchema, parseContract, strictJsonObjectSchema } from "../runtime";
import { fullCommitShaSchema } from "./shared";

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

export const pullRequestPreviewStartRequestSchema = strictJsonObjectSchema({
    expectedHeadSha: fullCommitShaSchema,
});

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
export type PullRequestPreviewStartRequest = v.InferOutput<
    typeof pullRequestPreviewStartRequestSchema
>;

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
