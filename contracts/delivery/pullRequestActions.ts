import * as v from "valibot";

import { parseContract, positiveIntegerSchema, strictJsonObjectSchema } from "../runtime";
import { pullRequestExpectedHeadSchema } from "./pullRequests";
import { fullCommitShaSchema } from "./shared";

export const pullRequestApproveRequestSchema = strictJsonObjectSchema({
    deploy: v.optional(v.boolean()),
    expectedHeadSha: fullCommitShaSchema,
    expectedStackHeads: v.optional(
        v.pipe(v.array(pullRequestExpectedHeadSchema), v.minLength(1), v.maxLength(100))
    ),
    mergeStack: v.optional(v.boolean()),
});

export const pullRequestStackCreateRequestSchema = strictJsonObjectSchema({
    pullRequests: v.pipe(
        v.array(positiveIntegerSchema),
        v.minLength(2),
        v.maxLength(100)
    ),
});

export const pullRequestRejectRequestSchema = strictJsonObjectSchema({
    comment: v.optional(v.string()),
});

export type PullRequestApproveRequest = v.InferOutput<
    typeof pullRequestApproveRequestSchema
>;
export type PullRequestStackCreateRequest = v.InferOutput<
    typeof pullRequestStackCreateRequestSchema
>;
export type PullRequestRejectRequest = v.InferOutput<
    typeof pullRequestRejectRequestSchema
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
 * Parses a pull-request rejection request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed pull-request rejection request.
 */
export function parsePullRequestRejectRequest(value: unknown): PullRequestRejectRequest {
    return parseContract(pullRequestRejectRequestSchema, value);
}
