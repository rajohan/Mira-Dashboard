import * as v from "valibot";

import {
    boundedControlSafeTextSchema,
    fullCommitShaSchema,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";

/** Stable cache identity for the bounded managed-repository projection. */
export const gitWorkspaceCacheKey = "git.workspace";
/** Exact schema identity retained with the Git cache row. */
export const gitWorkspaceCacheSchemaId = "git.workspace.v1";
/** Fixed worker-owned Git process source. */
export const gitWorkspaceCacheSource = "git.managed-workspace";
/** Maximum fresh lifetime retained by the Dashboard cache. */
export const gitWorkspaceCacheTtlMs = 5 * 60_000;

export const managedGitRepositoryIdSchema = v.picklist(
    ["dashboard", "docker", "openclaw"],
    "Managed Git repository is invalid"
);

export const managedGitRepositorySchema = v.pipe(
    v.strictObject({
        branch: v.optional(boundedControlSafeTextSchema(255, "Git branch is invalid")),
        changedFileCount: nonnegativeSafeIntegerSchema(
            "Git changed-file count is invalid"
        ),
        detached: v.boolean("Git detached state is invalid"),
        headSha: v.optional(fullCommitShaSchema("Git head SHA is invalid")),
        id: managedGitRepositoryIdSchema,
        stagedFileCount: nonnegativeSafeIntegerSchema("Git staged-file count is invalid"),
        state: v.picklist(
            ["available", "missing", "unavailable"],
            "Git repository state is invalid"
        ),
        untrackedFileCount: nonnegativeSafeIntegerSchema(
            "Git untracked-file count is invalid"
        ),
    }),
    v.check(
        (repository) =>
            repository.state === "available"
                ? repository.headSha !== undefined &&
                  (repository.detached
                      ? repository.branch === undefined
                      : repository.branch !== undefined)
                : repository.branch === undefined &&
                  repository.changedFileCount === 0 &&
                  !repository.detached &&
                  repository.headSha === undefined &&
                  repository.stagedFileCount === 0 &&
                  repository.untrackedFileCount === 0,
        "Git repository projection is inconsistent"
    )
);

export const gitWorkspaceCachePayloadSchema = v.pipe(
    v.strictObject({
        observedAtMs: nonnegativeSafeIntegerSchema("Git timestamp is invalid"),
        repositories: v.pipe(
            v.array(managedGitRepositorySchema, "Git repositories are invalid"),
            v.length(3, "Git projection must contain every managed repository")
        ),
    }),
    v.check(
        ({ repositories }) =>
            repositories.every(
                (repository, index) =>
                    repository.id ===
                    (["dashboard", "docker", "openclaw"] as const)[index]
            ),
        "Git repositories must be unique and canonically ordered"
    )
);

export type ManagedGitRepository = v.InferOutput<typeof managedGitRepositorySchema>;
export type GitWorkspaceCachePayload = v.InferOutput<
    typeof gitWorkspaceCachePayloadSchema
>;
