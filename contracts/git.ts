import * as v from "valibot";

import { nonNegativeIntegerSchema, parseContract } from "./runtime";

export const gitStatusSummarySchema = v.strictObject({
    conflicted: nonNegativeIntegerSchema,
    deleted: nonNegativeIntegerSchema,
    modified: nonNegativeIntegerSchema,
    renamed: nonNegativeIntegerSchema,
    staged: nonNegativeIntegerSchema,
    total: nonNegativeIntegerSchema,
    untracked: nonNegativeIntegerSchema,
});

export const gitRepoSummarySchema = v.strictObject({
    branch: v.optional(v.string()),
    dirty: v.boolean(),
    error: v.optional(v.string()),
    exists: v.boolean(),
    head: v.optional(v.string()),
    key: v.pipe(v.string(), v.nonEmpty()),
    name: v.pipe(v.string(), v.nonEmpty()),
    remote: v.optional(v.string()),
    statusError: v.optional(v.string()),
    statusShort: v.optional(v.array(v.string())),
    statusSummary: gitStatusSummarySchema,
    statusTruncated: v.optional(v.boolean()),
});

export const gitWorkspaceSummarySchema = v.strictObject({
    checkedAt: v.pipe(v.string(), v.isoTimestamp()),
    dirtyCount: nonNegativeIntegerSchema,
    dirtyRepos: v.array(v.string()),
    missingRepos: v.array(v.string()),
    repos: v.array(gitRepoSummarySchema),
});

export type GitStatusSummary = v.InferOutput<typeof gitStatusSummarySchema>;
export type GitRepoSummary = v.InferOutput<typeof gitRepoSummarySchema>;
export type GitWorkspaceSummary = v.InferOutput<typeof gitWorkspaceSummarySchema>;

/**
 * Parses the cached Git workspace projection.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cached Git workspace projection.
 */
export function parseGitWorkspaceSummary(
    value: unknown,
    path = "gitWorkspace"
): GitWorkspaceSummary {
    return parseContract(gitWorkspaceSummarySchema, value, path);
}
