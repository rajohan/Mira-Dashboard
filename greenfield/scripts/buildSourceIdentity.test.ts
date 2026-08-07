import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBuildSourceIdentity } from "./buildSourceIdentity.ts";

const temporaryRepositories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRepositories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

function runGit(repositoryRoot: string, ...arguments_: string[]): string {
    const result = Bun.spawnSync(
        ["git", "--no-optional-locks", "-C", repositoryRoot, ...arguments_],
        {
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || "Git fixture command failed");
    }
    return result.stdout.toString().trim();
}

async function createRepository(): Promise<{ commitSha: string; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-source-identity-"));
    temporaryRepositories.push(root);
    runGit(root, "init", "--quiet");
    runGit(root, "config", "user.name", "Mira Test");
    runGit(root, "config", "user.email", "mira-test@example.invalid");
    await writeFile(path.join(root, "tracked.txt"), "initial\n", {
        encoding: "utf8",
        mode: 0o600,
    });
    runGit(root, "add", "tracked.txt");
    runGit(root, "commit", "--quiet", "--message", "initial");
    return { commitSha: runGit(root, "rev-parse", "HEAD"), root };
}

describe("build source identity", () => {
    test("returns the full commit for a clean repository", async () => {
        const { commitSha, root } = await createRepository();

        const identity = resolveBuildSourceIdentity(root);

        expect(identity).toEqual({ commitSha, state: "clean" });
        expect(Object.isFrozen(identity)).toBe(true);
    });

    test("detects tracked, staged, and untracked changes", async () => {
        const { commitSha, root } = await createRepository();
        const trackedPath = path.join(root, "tracked.txt");
        const untrackedPath = path.join(root, "untracked.txt");

        await writeFile(trackedPath, "changed\n", { encoding: "utf8", mode: 0o600 });
        expect(resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            state: "dirty",
        });

        runGit(root, "add", "tracked.txt");
        expect(resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            state: "dirty",
        });

        await writeFile(untrackedPath, "new\n", { encoding: "utf8", mode: 0o600 });
        expect(resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            state: "dirty",
        });
        await unlink(untrackedPath);
    });

    test("fails closed outside a committed Git repository", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-source-identity-"));
        temporaryRepositories.push(root);

        expect(resolveBuildSourceIdentity(root)).toEqual({ state: "unknown" });
        expect(resolveBuildSourceIdentity("relative/path")).toEqual({
            state: "unknown",
        });
    });
});
