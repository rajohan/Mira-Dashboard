import path from "node:path";

import * as v from "valibot";

import { fullCommitShaSchema } from "../src/shared/validation.ts";

/** Stable source identity resolved from one local Git checkout. */
export type BuildSourceIdentity =
    | Readonly<{ commitSha: string; state: "clean" | "dirty" }>
    | Readonly<{ state: "unknown" }>;

const maximumGitOutputBytes = 1024 * 1024;
const commitShaSchema = fullCommitShaSchema();

async function gitOutput(
    repositoryRoot: string,
    arguments_: readonly string[]
): Promise<string | undefined> {
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
        child = Bun.spawn(
            ["git", "--no-optional-locks", "-C", repositoryRoot, ...arguments_],
            {
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

    const commitOutput = await gitOutput(repositoryRoot, [
        "rev-parse",
        "--verify",
        "HEAD",
    ]);
    const commit = v.safeParse(commitShaSchema, commitOutput, { abortEarly: true });
    if (!commit.success) return Object.freeze({ state: "unknown" });

    const status = await gitOutput(repositoryRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ]);
    if (status === undefined) return Object.freeze({ state: "unknown" });
    return Object.freeze({
        commitSha: commit.output,
        state: status.length === 0 ? "clean" : "dirty",
    });
}
