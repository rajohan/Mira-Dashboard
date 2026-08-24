import path from "node:path";

import * as v from "valibot";

import { fullCommitShaSchema } from "../src/shared/validation.ts";

/** Stable source identity resolved from one local Git checkout. */
export type BuildSourceIdentity =
    | Readonly<{
          commitSha: string;
          commitTitle: string;
          state: "clean" | "dirty";
      }>
    | Readonly<{ state: "unknown" }>;

const maximumGitOutputBytes = 1024 * 1024;
const commitShaSchema = fullCommitShaSchema();
const commitTitleSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(500),
    v.check((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
);

async function gitOutput(
    repositoryRoot: string,
    arguments_: readonly string[]
): Promise<string | undefined> {
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
        child = Bun.spawn(
            ["/usr/bin/git", "--no-optional-locks", "-C", repositoryRoot, ...arguments_],
            {
                env: {
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_NOSYSTEM: "1",
                    HOME: "/nonexistent",
                    LANG: "C",
                    PATH: "/usr/bin:/bin",
                },
                maxBuffer: maximumGitOutputBytes,
                stderr: "ignore",
                stdin: "ignore",
                stdout: "pipe",
            }
        );
    } catch {
        return undefined;
    }

    try {
        const [exitCode, stdout] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
        ]);
        if (exitCode !== 0) return undefined;
        return stdout.trim();
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        return undefined;
    }
}

/**
 * Resolves the full commit and clean-tree state for an explicit repository root.
 * Git failures and malformed identities fail closed without inventing release metadata.
 * @param repositoryRoot Absolute repository root to inspect.
 * @returns Clean, dirty, or unknown source identity.
 */
export async function resolveBuildSourceIdentity(
    repositoryRoot: string
): Promise<BuildSourceIdentity> {
    if (!path.isAbsolute(repositoryRoot) || repositoryRoot.includes("\0")) {
        return Object.freeze({ state: "unknown" });
    }

    const identityOutput = await gitOutput(repositoryRoot, [
        "show",
        "--no-patch",
        "--format=%H%x00%s",
        "HEAD",
    ]);
    const identityParts = identityOutput?.split("\0");
    const commit = v.safeParse(commitShaSchema, identityParts?.[0], {
        abortEarly: true,
    });
    const commitTitle = v.safeParse(commitTitleSchema, identityParts?.[1], {
        abortEarly: true,
    });
    if (!commit.success || !commitTitle.success || identityParts?.length !== 2) {
        return Object.freeze({ state: "unknown" });
    }

    const status = await gitOutput(repositoryRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ]);
    if (status === undefined) return Object.freeze({ state: "unknown" });
    return Object.freeze({
        commitSha: commit.output,
        commitTitle: commitTitle.output,
        state: status.length === 0 ? "clean" : "dirty",
    });
}
