import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import {
    WorkspaceGitSyncOutcomeUnknownError,
    type WorkspaceGitSyncResult,
} from "../../shared/workspaceGitSync.ts";

const gitExecutable = "/usr/bin/git";
const outputMaximumBytes = 64 * 1024;
const commandTimeoutMs = 60_000;
const commitMessage = "chore: sync OpenClaw workspace state";
const workspacePathspec = ":(literal)workspace";
const mainBranchRef = "refs/heads/main";

const cleanupTimeoutMs = 30_000;
const gitOperationMarkers = Object.freeze([
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
]);

async function git(
    root: string,
    arguments_: readonly string[],
    parentSignal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {}
): Promise<string> {
    const signal =
        parentSignal === undefined
            ? AbortSignal.timeout(commandTimeoutMs)
            : AbortSignal.any([parentSignal, AbortSignal.timeout(commandTimeoutMs)]);
    const process = Bun.spawn([gitExecutable, ...arguments_], {
        cwd: root,
        env: {
            HOME: "/home/ubuntu",
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin",
            ...environment,
        },
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                total += next.value.byteLength;
                if (total > outputMaximumBytes) {
                    throw new Error("Workspace Git output exceeded its bound");
                }
                chunks.push(next.value);
            }
        } finally {
            reader.releaseLock();
        }
        return Buffer.concat(chunks).toString();
    }
    let exitCode: number;
    let stdout: string;
    try {
        [exitCode, stdout] = await Promise.all([
            process.exited,
            readBounded(process.stdout),
            readBounded(process.stderr).then(() => ""),
        ]);
    } catch (error) {
        process.kill();
        await process.exited.catch(() => {});
        throw error;
    }
    if (exitCode !== 0) {
        throw new Error("Workspace Git command failed");
    }
    return stdout.trim();
}

async function assertNoInProgressGitOperation(
    root: string,
    signal?: AbortSignal
): Promise<void> {
    for (const marker of gitOperationMarkers) {
        const markerPath = await git(root, ["rev-parse", "--git-path", marker], signal);
        if (Fs.existsSync(Path.resolve(root, markerPath))) {
            throw new Error("Workspace Git source is not synchronized");
        }
    }
    const unmergedWorkspace = await git(
        root,
        ["diff", "--name-only", "--diff-filter=U", "--", workspacePathspec],
        signal
    );
    if (unmergedWorkspace !== "") {
        throw new Error("Workspace Git source is not synchronized");
    }
}

async function assertMainBranchHead(root: string, signal?: AbortSignal): Promise<void> {
    const symbolicHead = await git(root, ["symbolic-ref", "-q", "HEAD"], signal);
    if (symbolicHead !== mainBranchRef) {
        throw new Error("Workspace Git source is not synchronized");
    }
}

export function createWorkspaceGitSync(rootPath: string) {
    const canonicalRoot = Fs.realpathSync(rootPath);
    const status = Fs.lstatSync(rootPath);
    if (
        canonicalRoot !== rootPath ||
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        Path.parse(rootPath).root === rootPath
    ) {
        throw new Error("Workspace Git root is invalid");
    }

    return async (signal?: AbortSignal): Promise<WorkspaceGitSyncResult> => {
        const [repositoryRoot, branch, upstream, head] = await Promise.all([
            git(canonicalRoot, ["rev-parse", "--show-toplevel"], signal),
            git(canonicalRoot, ["branch", "--show-current"], signal),
            git(canonicalRoot, ["rev-parse", "--abbrev-ref", "@{upstream}"], signal),
            git(canonicalRoot, ["rev-parse", "HEAD"], signal),
        ]);
        if (
            repositoryRoot !== canonicalRoot ||
            branch !== "main" ||
            upstream !== "origin/main"
        ) {
            throw new Error("Workspace Git source is not synchronized");
        }
        await git(
            canonicalRoot,
            ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
            signal
        );
        const upstreamHead = await git(
            canonicalRoot,
            ["rev-parse", "@{upstream}"],
            signal
        );
        let recoveredCommit: string | undefined;
        if (head !== upstreamHead) {
            const pendingCommits = await git(
                canonicalRoot,
                ["rev-list", "--reverse", "@{upstream}..HEAD"],
                signal
            );
            if (pendingCommits === "") {
                throw new Error("Workspace Git source is not synchronized");
            }
            for (const commit of pendingCommits.split("\n")) {
                const [parents, subject, changedPaths] = await Promise.all([
                    git(canonicalRoot, ["show", "-s", "--format=%P", commit], signal),
                    git(canonicalRoot, ["show", "-s", "--format=%s", commit], signal),
                    git(
                        canonicalRoot,
                        [
                            "diff-tree",
                            "--no-commit-id",
                            "--name-only",
                            "-z",
                            "-r",
                            commit,
                        ],
                        signal
                    ),
                ]);
                const changedPathInventory = changedPaths
                    .split("\0")
                    .filter((changedPath) => changedPath !== "");
                if (
                    parents.split(" ").length !== 1 ||
                    subject !== commitMessage ||
                    changedPathInventory.length === 0 ||
                    changedPathInventory.some(
                        (changedPath) => !changedPath.startsWith("workspace/")
                    )
                ) {
                    throw new Error("Workspace Git source is not synchronized");
                }
            }
            await pushAndClassify(canonicalRoot, head, upstreamHead, signal);
            recoveredCommit = head;
        }

        const changed = await git(
            canonicalRoot,
            ["status", "--porcelain=v1", "--untracked-files=no", "--", workspacePathspec],
            signal
        );
        const changedFileCount = changed === "" ? 0 : changed.split("\n").length;
        if (changedFileCount === 0) {
            return {
                changedFileCount,
                ...(recoveredCommit === undefined ? {} : { commit: recoveredCommit }),
                pushed: recoveredCommit !== undefined,
            };
        }

        await assertNoInProgressGitOperation(canonicalRoot, signal);
        const privateIndexDirectory = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-workspace-git-index-")
        );
        Fs.chmodSync(privateIndexDirectory, 0o700);
        const indexEnvironment = Object.freeze({
            GIT_INDEX_FILE: Path.join(privateIndexDirectory, "index"),
        });
        try {
            await git(canonicalRoot, ["read-tree", head], signal, indexEnvironment);
            await git(
                canonicalRoot,
                ["add", "--update", "--", workspacePathspec],
                signal,
                indexEnvironment
            );
            const staged = await git(
                canonicalRoot,
                ["diff", "--cached", "--name-only", "--", workspacePathspec],
                signal,
                indexEnvironment
            );
            if (staged === "") return { changedFileCount: 0, pushed: false };
            const tree = await git(
                canonicalRoot,
                ["write-tree"],
                signal,
                indexEnvironment
            );
            const commit = await git(
                canonicalRoot,
                ["commit-tree", tree, "-p", head, "-m", commitMessage],
                signal
            );
            await assertMainBranchHead(canonicalRoot, signal);
            await git(canonicalRoot, ["update-ref", mainBranchRef, commit, head], signal);
            try {
                await assertMainBranchHead(canonicalRoot, signal);
                await git(
                    canonicalRoot,
                    ["reset", commit, "--", workspacePathspec],
                    signal
                );
            } catch (error) {
                try {
                    await git(
                        canonicalRoot,
                        ["update-ref", mainBranchRef, head, commit],
                        AbortSignal.timeout(cleanupTimeoutMs)
                    );
                } catch {
                    throw new WorkspaceGitSyncOutcomeUnknownError();
                }
                throw error;
            }
            await pushAndClassify(
                canonicalRoot,
                commit,
                recoveredCommit ?? upstreamHead,
                signal
            );
            return { changedFileCount, commit, pushed: true };
        } finally {
            Fs.rmSync(privateIndexDirectory, { force: true, recursive: true });
        }
    };
}

async function pushAndClassify(
    root: string,
    expectedHead: string,
    previousUpstreamHead: string,
    signal?: AbortSignal
): Promise<void> {
    try {
        await git(root, ["push", "origin", `${mainBranchRef}:${mainBranchRef}`], signal);
        return;
    } catch (error) {
        const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
        try {
            await git(
                root,
                [
                    "fetch",
                    "--no-tags",
                    "origin",
                    "refs/heads/main:refs/remotes/origin/main",
                ],
                cleanupSignal
            );
            const remoteHead = await git(
                root,
                ["rev-parse", "origin/main"],
                cleanupSignal
            );
            if (remoteHead === expectedHead) return;
            if (remoteHead === previousUpstreamHead) throw error;
            throw new WorkspaceGitSyncOutcomeUnknownError();
        } catch (verificationError) {
            if (
                verificationError === error ||
                verificationError instanceof WorkspaceGitSyncOutcomeUnknownError
            ) {
                throw verificationError;
            }
            throw new WorkspaceGitSyncOutcomeUnknownError();
        }
    }
}
