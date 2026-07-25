const FULL_GIT_COMMIT_PATTERN = /^[\da-f]{40}$/u;

function gitOutput(repoDirectory: string, arguments_: string[]): string | undefined {
    try {
        const result = Bun.spawnSync({
            cmd: ["git", "-C", repoDirectory, ...arguments_],
            stderr: "ignore",
            stdin: "ignore",
            stdout: "pipe",
        });
        if (result.exitCode !== 0) {
            return undefined;
        }
        return new TextDecoder().decode(result.stdout).trim();
    } catch {
        return undefined;
    }
}

export function isReleaseBuildCommit(value: string): boolean {
    return FULL_GIT_COMMIT_PATTERN.test(value);
}

/**
 * Returns a full release commit only for a clean source tree. Dirty builds stay
 * usable for local verification but cannot be accepted by release:manifest.
 */
export function resolveBuildSourceIdentity(repoDirectory = process.cwd()): string {
    const commit = gitOutput(repoDirectory, ["rev-parse", "HEAD"]);
    if (!commit || !isReleaseBuildCommit(commit)) {
        return "unknown";
    }
    const status = gitOutput(repoDirectory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    ]);
    if (status === undefined) {
        return "unknown";
    }
    return status ? `${commit}-dirty` : commit;
}
