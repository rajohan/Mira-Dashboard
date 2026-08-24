import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";

import { Redacted } from "effect";

import {
    createDynamicDockerUpdaterGitSync,
    createDockerUpdaterGitSync,
    dockerUpdaterGitCommitMessage,
    type DockerUpdaterGitCredentials,
    type DockerUpdaterGitProcess,
    type DockerUpdaterGitProcessRequest,
    type DockerUpdaterGitSync,
    type DockerUpdaterGitSyncRequest,
} from "./gitSync.ts";

const gitExecutable = "/usr/bin/git";
const originalCompose = `services:\n  media:\n    image: example/media:1\n`;
const updatedCompose = `services:\n  media:\n    image: example/media:2\n`;
const secondUpdatedCompose = `services:\n  media:\n    image: example/media:3\n`;
const racedCompose = `services:\n  media:\n    image: example/media:operator-race\n`;
const originalNotes = "operator notes\n";
const temporaryRoots = new Set<string>();

interface GitFixture {
    readonly composePath: string;
    readonly notesPath: string;
    readonly remoteRoot: string;
    readonly repoRoot: string;
    readonly sync: DockerUpdaterGitSync;
}

function digest(value: string | Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function readBounded(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maximumBytes) throw new Error("fixture output exceeded bound");
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

const executeProcess: DockerUpdaterGitProcess = async (request) => {
    const child = Bun.spawn([request.executable, ...request.arguments], {
        cwd: request.cwd,
        env: request.environment,
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBounded(child.stdout, request.stdoutMaximumBytes),
        readBounded(child.stderr, request.stderrMaximumBytes),
    ]);
    return { exitCode, stderr, stdout };
};

async function runGit(
    cwd: string,
    arguments_: readonly string[],
    acceptedExitCodes: readonly number[] = [0]
): Promise<string> {
    const child = Bun.spawn(
        [
            gitExecutable,
            "-c",
            "protocol.file.allow=always",
            "-c",
            "user.name=Fixture Operator",
            "-c",
            "user.email=fixture@example.invalid",
            ...arguments_,
        ],
        {
            cwd,
            env: {
                GIT_CONFIG_NOSYSTEM: "1",
                HOME: "/home/ubuntu",
                LANG: "C",
                LC_ALL: "C",
                PATH: "/usr/bin:/bin",
            },
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (!acceptedExitCodes.includes(exitCode)) {
        throw new Error(`fixture git failed: ${stderr}`);
    }
    return stdout.trimEnd();
}

async function createFixture(
    process: DockerUpdaterGitProcess = executeProcess,
    credentials?: DockerUpdaterGitCredentials
): Promise<GitFixture> {
    const temporaryRoot = await mkdtemp(Path.join(tmpdir(), "mira-docker-git-"));
    temporaryRoots.add(temporaryRoot);
    const repoRoot = Path.join(temporaryRoot, "repository");
    const remoteRoot = Path.join(temporaryRoot, "remote.git");
    await mkdir(repoRoot);
    await runGit(temporaryRoot, ["init", "--bare", remoteRoot]);
    await runGit(repoRoot, ["init", "--initial-branch=main"]);
    const appRoot = Path.join(repoRoot, "apps", "media");
    await mkdir(appRoot, { recursive: true });
    const composePath = Path.join(appRoot, "compose.yaml");
    const notesPath = Path.join(repoRoot, "notes.txt");
    await Promise.all([
        writeFile(composePath, originalCompose),
        writeFile(notesPath, originalNotes),
    ]);
    await runGit(repoRoot, ["add", "--", "apps/media/compose.yaml", "notes.txt"]);
    await runGit(repoRoot, ["commit", "-m", "initial fixture"]);
    await runGit(repoRoot, [
        "remote",
        "add",
        "origin",
        Bun.pathToFileURL(remoteRoot).href,
    ]);
    await runGit(repoRoot, ["push", "--set-upstream", "origin", "main"]);
    return {
        composePath,
        notesPath,
        remoteRoot,
        repoRoot,
        sync: createDockerUpdaterGitSync({
            allowLocalUpstreamForTests: true,
            ...(credentials === undefined ? {} : { credentials }),
            process,
            repoRoot,
        }),
    };
}

async function updateRequest(
    fixture: GitFixture,
    after = updatedCompose,
    before = originalCompose
): Promise<DockerUpdaterGitSyncRequest> {
    const expectedRepositoryHead = await runGit(fixture.repoRoot, ["rev-parse", "HEAD"]);
    await writeFile(fixture.composePath, after);
    return {
        changes: [
            {
                composePath: fixture.composePath,
                expectedAfterContentSha256: digest(after),
                expectedBeforeContentSha256: digest(before),
            },
        ],
        expectedRepositoryHead,
    };
}

async function remoteCompose(fixture: GitFixture): Promise<string> {
    return await runGit(fixture.repoRoot, [
        `--git-dir=${fixture.remoteRoot}`,
        "show",
        "main:apps/media/compose.yaml",
    ]);
}

afterEach(async () => {
    const roots = [...temporaryRoots];
    temporaryRoots.clear();
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

describe("Docker updater Git synchronization", () => {
    test("does not bind worker startup to a present repository and re-resolves later", async () => {
        const temporaryRoot = await mkdtemp(Path.join(tmpdir(), "mira-docker-git-late-"));
        temporaryRoots.add(temporaryRoot);
        const repoRoot = Path.join(temporaryRoot, "repository");
        const remoteRoot = Path.join(temporaryRoot, "remote.git");
        const sync = createDynamicDockerUpdaterGitSync({
            allowLocalUpstreamForTests: true,
            process: executeProcess,
            repoRoot,
        });

        const missing = await sync.readHead().catch((error: unknown) => error);
        expect(missing).toBeInstanceOf(Error);
        expect((missing as Error).message).toBe("Docker updater Git head is unavailable");

        await mkdir(repoRoot);
        await runGit(temporaryRoot, ["init", "--bare", remoteRoot]);
        await runGit(repoRoot, ["init", "--initial-branch=main"]);
        const appRoot = Path.join(repoRoot, "apps", "media");
        await mkdir(appRoot, { recursive: true });
        await writeFile(Path.join(appRoot, "compose.yaml"), originalCompose);
        await runGit(repoRoot, ["add", "--", "apps/media/compose.yaml"]);
        await runGit(repoRoot, ["commit", "-m", "late repository fixture"]);
        await runGit(repoRoot, [
            "remote",
            "add",
            "origin",
            Bun.pathToFileURL(remoteRoot).href,
        ]);
        await runGit(repoRoot, ["push", "--set-upstream", "origin", "main"]);

        const head = await sync.readHead();
        expect(await sync.sync({ changes: [], expectedRepositoryHead: head })).toEqual({
            composePaths: [],
            status: "no-change",
        });
    });

    test("commits and pushes only the exact updater-owned Compose path", async () => {
        const fixture = await createFixture();
        const result = await fixture.sync.sync(await updateRequest(fixture));

        expect(result).toMatchObject({
            composePaths: ["apps/media/compose.yaml"],
            status: "pushed",
        });
        expect(await remoteCompose(fixture)).toBe(updatedCompose.trimEnd());
        expect(await runGit(fixture.repoRoot, ["log", "-1", "--format=%s"])).toBe(
            dockerUpdaterGitCommitMessage
        );
        expect(await runGit(fixture.repoRoot, ["status", "--porcelain=v1"])).toBe("");
    });

    test("commits the validated index snapshot when the worktree changes after staging", async () => {
        const fixture = await createFixture();
        const request = await updateRequest(fixture);

        const result = await fixture.sync.sync(request, undefined, () => {
            writeFileSync(fixture.composePath, racedCompose);
        });

        expect(result).toMatchObject({
            composePaths: ["apps/media/compose.yaml"],
            status: "unknown-outcome",
        });
        if (result.status !== "unknown-outcome" || result.commit === undefined) {
            throw new Error("expected an attributable local automation commit");
        }
        expect(
            await runGit(fixture.repoRoot, [
                "show",
                `${result.commit}:apps/media/compose.yaml`,
            ])
        ).toBe(updatedCompose.trimEnd());
        expect(await readFile(fixture.composePath, "utf8")).toBe(racedCompose);
        expect(await remoteCompose(fixture)).toBe(originalCompose.trimEnd());

        expect(
            await fixture.sync.sync({
                changes: [],
                expectedRepositoryHead: result.commit,
            })
        ).toEqual({
            composePaths: [],
            reason: "unrelated-pending",
            status: "unavailable",
        });

        await writeFile(fixture.composePath, updatedCompose);
        expect(
            await fixture.sync.sync({
                changes: [],
                expectedRepositoryHead: result.commit,
            })
        ).toEqual({
            commit: result.commit,
            composePaths: ["apps/media/compose.yaml"],
            status: "pushed",
        });
        expect(await remoteCompose(fixture)).toBe(updatedCompose.trimEnd());
    });

    test("rejects an unrelated path staged after exact staging and before tree creation", async () => {
        let injected = false;
        const fixture = await createFixture(async (processRequest) => {
            if (!injected && processRequest.arguments.includes("write-tree")) {
                injected = true;
                await writeFile(
                    Path.join(processRequest.cwd, "notes.txt"),
                    "concurrently staged operator notes\n"
                );
                await runGit(processRequest.cwd, ["add", "--", "notes.txt"]);
            }
            return await executeProcess(processRequest);
        });
        const request = await updateRequest(fixture);

        expect(await fixture.sync.sync(request)).toEqual({
            composePaths: [],
            reason: "conflict",
            status: "unavailable",
        });
        expect(injected).toBe(true);
        expect(await runGit(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(
            request.expectedRepositoryHead
        );
        expect(await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).toBe(
            "notes.txt"
        );
        expect(await remoteCompose(fixture)).toBe(originalCompose.trimEnd());
    });

    test("verifies each planned Compose file exactly against Git HEAD", async () => {
        const fixture = await createFixture();
        const expectedRepositoryHead = await fixture.sync.readHead();
        const request = {
            expectedRepositoryHead,
            files: [
                {
                    composePath: fixture.composePath,
                    expectedContentSha256: digest(originalCompose),
                },
            ],
        };

        expect(await fixture.sync.verifyHeadFiles(request)).toBeUndefined();

        await writeFile(fixture.composePath, updatedCompose);
        const failure = await fixture.sync
            .verifyHeadFiles(request)
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "Docker updater Git HEAD verification failed"
        );
    });

    test("advances the tracking ref across sequential updater commits without fetching", async () => {
        const fixture = await createFixture();
        const first = await fixture.sync.sync(await updateRequest(fixture));

        expect(first).toMatchObject({ status: "pushed" });
        if (first.status !== "pushed") throw new Error("expected first push");
        expect(
            await runGit(fixture.repoRoot, [
                "rev-parse",
                "--verify",
                "refs/remotes/origin/main^{commit}",
            ])
        ).toBe(first.commit);

        const second = await fixture.sync.sync(
            await updateRequest(fixture, secondUpdatedCompose, updatedCompose)
        );

        expect(second).toMatchObject({ status: "pushed" });
        if (second.status !== "pushed") throw new Error("expected second push");
        expect(await remoteCompose(fixture)).toBe(secondUpdatedCompose.trimEnd());
        expect(
            await runGit(fixture.repoRoot, [
                "rev-parse",
                "--verify",
                "refs/remotes/origin/main^{commit}",
            ])
        ).toBe(second.commit);
    });

    test("preserves unrelated dirty files while syncing an exact Compose path", async () => {
        const fixture = await createFixture();
        await writeFile(fixture.notesPath, "private unfinished notes\n");

        const result = await fixture.sync.sync(await updateRequest(fixture));

        expect(result.status).toBe("pushed");
        expect(await readFile(fixture.notesPath, "utf8")).toBe(
            "private unfinished notes\n"
        );
        expect(
            await runGit(fixture.repoRoot, [
                `--git-dir=${fixture.remoteRoot}`,
                "show",
                "main:notes.txt",
            ])
        ).toBe(originalNotes.trimEnd());
        expect(await runGit(fixture.repoRoot, ["status", "--porcelain=v1"])).toBe(
            " M notes.txt"
        );
    });

    test("refuses a requested Compose file that was dirty before the updater", async () => {
        const fixture = await createFixture();
        const preexistingDirty = originalCompose.replace(":1", ":local");
        await writeFile(fixture.composePath, preexistingDirty);
        const request = await updateRequest(fixture, updatedCompose, preexistingDirty);
        const headBefore = request.expectedRepositoryHead;

        expect(await fixture.sync.sync(request)).toEqual({
            composePaths: [],
            reason: "conflict",
            status: "unavailable",
        });
        expect(await runGit(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(headBefore);
        expect(await readFile(fixture.composePath, "utf8")).toBe(updatedCompose);
    });

    test("refuses unrelated staged entries without changing the index", async () => {
        const fixture = await createFixture();
        await writeFile(fixture.notesPath, "staged operator notes\n");
        await runGit(fixture.repoRoot, ["add", "--", "notes.txt"]);
        const request = await updateRequest(fixture);

        expect(await fixture.sync.sync(request)).toEqual({
            composePaths: [],
            reason: "unrelated-staged",
            status: "unavailable",
        });
        expect(await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).toBe(
            "notes.txt"
        );
    });

    test("refuses unrelated pending commits even when no paths are requested", async () => {
        const fixture = await createFixture();
        await writeFile(fixture.notesPath, "locally committed notes\n");
        await runGit(fixture.repoRoot, ["add", "--", "notes.txt"]);
        await runGit(fixture.repoRoot, ["commit", "-m", "unrelated local commit"]);
        const expectedRepositoryHead = await runGit(fixture.repoRoot, [
            "rev-parse",
            "HEAD",
        ]);

        expect(await fixture.sync.sync({ changes: [], expectedRepositoryHead })).toEqual({
            composePaths: [],
            reason: "unrelated-pending",
            status: "unavailable",
        });
    });

    test("classifies a failed push after commit and recovers the exact pending automation commit", async () => {
        const fixture = await createFixture();
        const hookPath = Path.join(fixture.remoteRoot, "hooks", "pre-receive");
        await writeFile(
            hookPath,
            "#!/bin/sh\necho 'private provider diagnostic /opt/docker/.env' >&2\nexit 1\n"
        );
        await chmod(hookPath, 0o755);

        const first = await fixture.sync.sync(await updateRequest(fixture));
        expect(first).toMatchObject({
            composePaths: ["apps/media/compose.yaml"],
            status: "committed-push-pending",
        });
        expect(JSON.stringify(first)).not.toContain("/opt/docker/.env");
        expect(await remoteCompose(fixture)).toBe(originalCompose.trimEnd());

        await unlink(hookPath);
        if (first.status !== "committed-push-pending") {
            throw new Error("expected a committed pending fixture state");
        }
        const recovered = await fixture.sync.sync({
            changes: [],
            expectedRepositoryHead: first.commit,
        });
        expect(recovered).toEqual({
            commit: first.commit,
            composePaths: ["apps/media/compose.yaml"],
            status: "pushed",
        });
        expect(await remoteCompose(fixture)).toBe(updatedCompose.trimEnd());
    });

    test("requires a fresh successful dry-run before accepting a remotely matching pending commit", async () => {
        let rejectPushes = false;
        const rejectedPushes: DockerUpdaterGitProcessRequest[] = [];
        const fixture = await createFixture(async (request) => {
            if (rejectPushes && request.arguments.includes("push")) {
                rejectedPushes.push(request);
                return {
                    exitCode: 1,
                    stderr: new TextEncoder().encode("private revoked-write diagnostic"),
                    stdout: new Uint8Array(),
                };
            }
            return await executeProcess(request);
        });
        const hookPath = Path.join(fixture.remoteRoot, "hooks", "pre-receive");
        await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
        await chmod(hookPath, 0o755);

        const pending = await fixture.sync.sync(await updateRequest(fixture));
        expect(pending).toMatchObject({ status: "committed-push-pending" });
        if (pending.status !== "committed-push-pending") {
            throw new Error("expected a committed pending fixture state");
        }
        await unlink(hookPath);
        await runGit(fixture.repoRoot, [
            "push",
            Bun.pathToFileURL(fixture.remoteRoot).href,
            `${pending.commit}:refs/heads/main`,
        ]);
        rejectPushes = true;

        const recovered = await fixture.sync.sync({
            changes: [],
            expectedRepositoryHead: pending.commit,
        });

        expect(recovered).toEqual({
            composePaths: [],
            reason: "upstream",
            status: "unavailable",
        });
        expect(
            rejectedPushes.map(({ arguments: arguments_ }) =>
                arguments_.includes("--dry-run")
            )
        ).toEqual([false, true]);
        expect(JSON.stringify(recovered)).not.toContain("revoked-write");
    });

    test("does not attempt pending recovery without explicit GitHub credentials", async () => {
        const fixture = await createFixture();
        const hookPath = Path.join(fixture.remoteRoot, "hooks", "pre-receive");
        await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
        await chmod(hookPath, 0o755);
        const pending = await fixture.sync.sync(await updateRequest(fixture));
        expect(pending).toMatchObject({ status: "committed-push-pending" });
        if (pending.status !== "committed-push-pending") {
            throw new Error("expected a committed pending fixture state");
        }
        await runGit(fixture.repoRoot, [
            "remote",
            "set-url",
            "origin",
            "https://github.com/example/repository.git",
        ]);
        const requests: DockerUpdaterGitProcessRequest[] = [];
        const sync = createDockerUpdaterGitSync({
            process: async (request) => {
                requests.push(request);
                return await executeProcess(request);
            },
            repoRoot: fixture.repoRoot,
        });

        const recovered = await sync.sync({
            changes: [],
            expectedRepositoryHead: pending.commit,
        });

        expect(recovered).toEqual({
            composePaths: [],
            reason: "upstream",
            status: "unavailable",
        });
        expect(
            requests.some(
                ({ arguments: arguments_ }) =>
                    arguments_.includes("ls-remote") || arguments_.includes("push")
            )
        ).toBe(false);
    });

    test("fails closed before commit when the current branch has no upstream", async () => {
        const fixture = await createFixture();
        await runGit(fixture.repoRoot, ["branch", "--unset-upstream"]);
        const request = await updateRequest(fixture);

        expect(await fixture.sync.sync(request)).toEqual({
            composePaths: [],
            reason: "upstream",
            status: "unavailable",
        });
        expect(await runGit(fixture.repoRoot, ["log", "-1", "--format=%s"])).toBe(
            "initial fixture"
        );
    });

    test("rejects traversal aliases, symlinks, and hardlinked Compose files", async () => {
        const traversalFixture = await createFixture();
        const validTraversalRequest = await updateRequest(traversalFixture);
        const traversalRequest: DockerUpdaterGitSyncRequest = {
            ...validTraversalRequest,
            changes: [
                {
                    ...validTraversalRequest.changes[0]!,
                    composePath: `${traversalFixture.repoRoot}/apps/media/../media/compose.yaml`,
                },
            ],
        };
        expect(await traversalFixture.sync.sync(traversalRequest)).toMatchObject({
            reason: "invalid-target",
            status: "unavailable",
        });

        const symlinkFixture = await createFixture();
        const symlinkRequest = await updateRequest(symlinkFixture);
        const symlinkSource = Path.join(
            symlinkFixture.repoRoot,
            "apps",
            "media",
            "source.yaml"
        );
        await writeFile(symlinkSource, updatedCompose);
        await unlink(symlinkFixture.composePath);
        await symlink(symlinkSource, symlinkFixture.composePath);
        expect(await symlinkFixture.sync.sync(symlinkRequest)).toMatchObject({
            reason: "invalid-target",
            status: "unavailable",
        });

        const hardlinkFixture = await createFixture();
        const hardlinkRequest = await updateRequest(hardlinkFixture);
        const hardlinkSource = Path.join(
            hardlinkFixture.repoRoot,
            "apps",
            "media",
            "source.yaml"
        );
        await writeFile(hardlinkSource, updatedCompose);
        await unlink(hardlinkFixture.composePath);
        await link(hardlinkSource, hardlinkFixture.composePath);
        expect(await hardlinkFixture.sync.sync(hardlinkRequest)).toMatchObject({
            reason: "invalid-target",
            status: "unavailable",
        });
    });

    test("uses fixed scrubbed Git execution without a shell or ambient injection", async () => {
        const requests: DockerUpdaterGitProcessRequest[] = [];
        const rawUsername = "github-user-sentinel";
        const rawToken = "github-token-sentinel";
        const fixture = await createFixture(
            async (request) => {
                requests.push(request);
                return await executeProcess(request);
            },
            Object.freeze({
                password: Redacted.make(rawToken),
                username: Redacted.make(rawUsername),
            })
        );

        expect(await fixture.sync.sync(await updateRequest(fixture))).toMatchObject({
            status: "pushed",
        });
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
            expect(request.executable).toBe(gitExecutable);
            expect(request.cwd).toBe(fixture.repoRoot);
            expect(request.arguments).not.toContain("sh");
            expect(request.arguments).not.toContain("-c private provider diagnostic");
            expect(request.environment).toMatchObject({
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
                GIT_SSH: "/bin/false",
                GIT_TERMINAL_PROMPT: "0",
                HOME: "/nonexistent",
                PATH: "/usr/bin:/bin",
            });
            expect(request.environment).not.toHaveProperty("GIT_DIR");
            expect(request.environment).not.toHaveProperty("SSH_AUTH_SOCK");
            expect(request.arguments.join("\0")).not.toContain(rawUsername);
            expect(request.arguments.join("\0")).not.toContain(rawToken);
        }
        expect(JSON.stringify(requests)).not.toContain(rawUsername);
        expect(JSON.stringify(requests)).not.toContain(rawToken);
        const dryRunIndex = requests.findIndex(
            ({ arguments: arguments_ }) =>
                arguments_.includes("push") && arguments_.includes("--dry-run")
        );
        const commitIndex = requests.findIndex(({ arguments: arguments_ }) =>
            arguments_.includes("commit-tree")
        );
        expect(dryRunIndex).toBeGreaterThanOrEqual(0);
        expect(commitIndex).toBeGreaterThan(dryRunIndex);
    });

    test("rejects non-GitHub HTTPS remotes before authentication or commit", async () => {
        const fixture = await createFixture();
        await runGit(fixture.repoRoot, [
            "remote",
            "set-url",
            "origin",
            "https://example.com/private/repository.git",
        ]);

        expect(await fixture.sync.sync(await updateRequest(fixture))).toEqual({
            composePaths: [],
            reason: "upstream",
            status: "unavailable",
        });
        expect(await runGit(fixture.repoRoot, ["log", "-1", "--format=%s"])).toBe(
            "initial fixture"
        );
    });

    test("returns no-change for a clean branch and rejects stale source identity", async () => {
        const fixture = await createFixture();
        const head = await runGit(fixture.repoRoot, ["rev-parse", "HEAD"]);
        expect(
            await fixture.sync.sync({ changes: [], expectedRepositoryHead: head })
        ).toEqual({ composePaths: [], status: "no-change" });

        const validRequest = await updateRequest(fixture, secondUpdatedCompose);
        const request: DockerUpdaterGitSyncRequest = {
            ...validRequest,
            expectedRepositoryHead: "0".repeat(40),
        };
        expect(await fixture.sync.sync(request)).toEqual({
            composePaths: [],
            reason: "conflict",
            status: "unavailable",
        });
    });
});
