import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBuildSourceIdentity } from "./buildSourceIdentity.ts";

const maximumGitFixtureOutputBytes = 1024 * 1024;
const temporaryRepositories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRepositories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function runGit(repositoryRoot: string, ...arguments_: string[]): Promise<string> {
    const child = Bun.spawn(
        ["git", "--no-optional-locks", "-C", repositoryRoot, ...arguments_],
        {
            maxBuffer: maximumGitFixtureOutputBytes,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(stderr || "Git fixture command failed");
    }
    return stdout.trim();
}

async function createRepository(): Promise<{ commitSha: string; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-source-identity-"));
    temporaryRepositories.push(root);
    await runGit(root, "init", "--quiet");
    await runGit(root, "config", "user.name", "Mira Test");
    await runGit(root, "config", "user.email", "mira-test@example.invalid");
    await writeFile(path.join(root, "tracked.txt"), "initial\n", {
        encoding: "utf8",
        mode: 0o600,
    });
    await runGit(root, "add", "tracked.txt");
    await runGit(root, "commit", "--quiet", "--message", "initial");
    return { commitSha: await runGit(root, "rev-parse", "HEAD"), root };
}

describe("build source identity", () => {
    test("returns the full commit for a clean repository", async () => {
        const { commitSha, root } = await createRepository();

        const identity = await resolveBuildSourceIdentity(root);

        expect(identity).toEqual({
            commitSha,
            commitTitle: "initial",
            state: "clean",
        });
        expect(Object.isFrozen(identity)).toBe(true);
    });

    test("detects tracked, staged, and untracked changes", async () => {
        const { commitSha, root } = await createRepository();
        const trackedPath = path.join(root, "tracked.txt");
        const untrackedPath = path.join(root, "untracked.txt");

        await writeFile(trackedPath, "changed\n", { encoding: "utf8", mode: 0o600 });
        expect(await resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            commitTitle: "initial",
            state: "dirty",
        });

        await runGit(root, "add", "tracked.txt");
        expect(await resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            commitTitle: "initial",
            state: "dirty",
        });

        await writeFile(untrackedPath, "new\n", { encoding: "utf8", mode: 0o600 });
        expect(await resolveBuildSourceIdentity(root)).toEqual({
            commitSha,
            commitTitle: "initial",
            state: "dirty",
        });
        await unlink(untrackedPath);
    });

    test("fails closed outside a committed Git repository", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-source-identity-"));
        temporaryRepositories.push(root);

        expect(await resolveBuildSourceIdentity(root)).toEqual({ state: "unknown" });
        expect(await resolveBuildSourceIdentity("relative/path")).toEqual({
            state: "unknown",
        });
    });
});
