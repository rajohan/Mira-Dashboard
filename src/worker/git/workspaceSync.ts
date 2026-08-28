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
const workspaceUntrackedSafePaths = Object.freeze([
    "workspace/AGENTS.md",
    "workspace/DREAMS.md",
    "workspace/HEARTBEAT.md",
    "workspace/IDENTITY.md",
    "workspace/MEMORY.md",
    "workspace/SOUL.md",
    "workspace/TOOLS.md",
    "workspace/USER.md",
    "workspace/WORKFLOW_AUTO.md",
    "workspace/coder/",
    "workspace/communicator/",
    "workspace/memory/",
    "workspace/researcher/",
    "workspace/wiki/",
] as const);

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

async function runGit(
    root: string,
    arguments_: readonly string[],
    parentSignal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
    stdin: Uint8Array | "ignore" = "ignore"
): Promise<Buffer> {
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
        stdin,
        stdout: "pipe",
    });
    async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
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
        return Buffer.concat(chunks);
    }
    let exitCode: number;
    let stdout: Buffer;
    try {
        [exitCode, stdout] = await Promise.all([
            process.exited,
            readBounded(process.stdout),
            readBounded(process.stderr).then(() => Buffer.alloc(0)),
        ]);
    } catch (error) {
        process.kill();
        await process.exited.catch(() => {});
        throw error;
    }
    if (exitCode !== 0) {
        throw new Error("Workspace Git command failed");
    }
    return stdout;
}

async function git(
    root: string,
    arguments_: readonly string[],
    parentSignal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
    stdin: Uint8Array | "ignore" = "ignore"
): Promise<string> {
    const output = await runGit(root, arguments_, parentSignal, environment, stdin);
    return output.toString().replace(/[\r\n]+$/u, "");
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

function splitNullTerminatedPaths(output: Uint8Array): Buffer[] {
    const paths: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < output.byteLength; index += 1) {
        if (output[index] !== 0) continue;
        if (index > start) paths.push(Buffer.from(output.subarray(start, index)));
        start = index + 1;
    }
    if (start !== output.byteLength) {
        throw new Error("Workspace Git path output is invalid");
    }
    return paths;
}

interface WorkspaceStatusInventory {
    readonly addedPaths: readonly Buffer[];
    readonly changedPaths: readonly Buffer[];
    readonly pathsRequiringExplicitAdd: readonly Buffer[];
}

function parseWorkspaceStatus(output: Uint8Array): WorkspaceStatusInventory {
    const fields = splitNullTerminatedPaths(output);
    const addedPaths: Buffer[] = [];
    const changedPaths: Buffer[] = [];
    const pathsRequiringExplicitAdd: Buffer[] = [];
    for (let index = 0; index < fields.length; index += 1) {
        const record = fields[index];
        if (record === undefined || record.length < 4 || record[2] !== 0x20) {
            throw new Error("Workspace Git status output is invalid");
        }
        const indexStatus = record[0];
        const worktreeStatus = record[1];
        const path = record.subarray(3);
        changedPaths.push(path);
        if (indexStatus === 0x41 || worktreeStatus === 0x41) {
            addedPaths.push(path);
        }
        if (
            indexStatus === 0x52 ||
            indexStatus === 0x43 ||
            worktreeStatus === 0x52 ||
            worktreeStatus === 0x43
        ) {
            pathsRequiringExplicitAdd.push(path);
            index += 1;
            if (fields[index] === undefined) {
                throw new Error("Workspace Git status output is invalid");
            }
        }
    }
    return Object.freeze({ addedPaths, changedPaths, pathsRequiringExplicitAdd });
}

function pathEqualsAscii(path: Uint8Array, expected: string): boolean {
    return Buffer.from(path).equals(Buffer.from(expected));
}

function pathStartsWithAscii(path: Uint8Array, expected: string): boolean {
    const prefix = Buffer.from(expected);
    return (
        path.byteLength >= prefix.byteLength &&
        Buffer.from(path).subarray(0, prefix.byteLength).equals(prefix)
    );
}

function workspaceUntrackedPathIsSafe(path: Uint8Array): boolean {
    return workspaceUntrackedSafePaths.some((safePath) =>
        safePath.endsWith("/")
            ? pathStartsWithAscii(path, safePath)
            : pathEqualsAscii(path, safePath)
    );
}

function literalPathspec(path: string): string {
    return `:(literal)${path}`;
}

function absolutePath(root: string, path: Uint8Array): Buffer {
    return Buffer.concat([Buffer.from(`${root}${Path.sep}`), Buffer.from(path)]);
}

function lstatIfPresent(path: Buffer): Fs.Stats | undefined {
    try {
        return Fs.lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
}

function assertSafeAdditionTypes(root: string, paths: readonly Buffer[]): void {
    for (const path of paths) {
        const candidate = absolutePath(root, path);
        const status = lstatIfPresent(candidate);
        if (status === undefined) continue;
        const exactSafePath = workspaceUntrackedSafePaths.find(
            (safePath) => !safePath.endsWith("/") && pathEqualsAscii(path, safePath)
        );
        if (exactSafePath !== undefined && status.isDirectory()) {
            throw new Error("Workspace Git exact-file addition is not a file");
        }
        if (
            status.isDirectory() &&
            lstatIfPresent(Buffer.concat([candidate, Buffer.from(`${Path.sep}.git`)])) !==
                undefined
        ) {
            throw new Error("Workspace Git additions contain an embedded repository");
        }
    }
}

function existingPaths(root: string, paths: readonly Buffer[]): Buffer[] {
    return paths.filter((path) => lstatIfPresent(absolutePath(root, path)) !== undefined);
}

function pathspecInput(paths: readonly Buffer[]): Buffer {
    return Buffer.concat(
        paths.map((path) =>
            Buffer.concat([Buffer.from(":(literal)"), path, Buffer.of(0)])
        )
    );
}

function uniquePaths(paths: readonly Buffer[]): Buffer[] {
    const seen = new Set<string>();
    return paths.filter((path) => {
        const key = path.toString("hex");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function residualChangedFileCount(
    root: string,
    signal?: AbortSignal
): Promise<number> {
    const status = await runGit(
        root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        signal
    );
    return uniquePaths(parseWorkspaceStatus(status).changedPaths).length;
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
                    runGit(
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
                const changedPathInventory = splitNullTerminatedPaths(changedPaths);
                if (
                    parents.split(" ").length !== 1 ||
                    subject !== commitMessage ||
                    changedPathInventory.length === 0 ||
                    changedPathInventory.some(
                        (changedPath) => !pathStartsWithAscii(changedPath, "workspace/")
                    )
                ) {
                    throw new Error("Workspace Git source is not synchronized");
                }
            }
            await pushAndClassify(canonicalRoot, head, upstreamHead, signal);
            recoveredCommit = head;
        }

        const [trackedChanges, untrackedPaths] = await Promise.all([
            runGit(
                canonicalRoot,
                [
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=no",
                    "--",
                    workspacePathspec,
                ],
                signal
            ),
            runGit(
                canonicalRoot,
                [
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ...workspaceUntrackedSafePaths.map((path) => literalPathspec(path)),
                ],
                signal
            ),
        ]);
        const trackedInventory = parseWorkspaceStatus(trackedChanges);
        const safeUntrackedPaths = splitNullTerminatedPaths(untrackedPaths).filter(
            (path) => workspaceUntrackedPathIsSafe(path)
        );
        const safeStagedAdditionPaths = existingPaths(
            canonicalRoot,
            trackedInventory.addedPaths.filter((path) =>
                workspaceUntrackedPathIsSafe(path)
            )
        );
        const normalExplicitAddPaths = existingPaths(
            canonicalRoot,
            uniquePaths([
                ...trackedInventory.pathsRequiringExplicitAdd,
                ...safeUntrackedPaths,
            ])
        );
        const safeExplicitAddPaths = uniquePaths([
            ...normalExplicitAddPaths,
            ...safeStagedAdditionPaths,
        ]);
        if (
            trackedInventory.changedPaths.length === 0 &&
            safeUntrackedPaths.length === 0
        ) {
            let residualCount: number;
            if (recoveredCommit === undefined) {
                residualCount = await residualChangedFileCount(canonicalRoot, signal);
            } else {
                residualCount = 1;
                try {
                    residualCount = await residualChangedFileCount(
                        canonicalRoot,
                        AbortSignal.timeout(cleanupTimeoutMs)
                    );
                } catch {
                    // A confirmed recovery remains successful while heartbeat fails closed.
                }
            }
            return {
                changedFileCount: 0,
                ...(recoveredCommit === undefined ? {} : { commit: recoveredCommit }),
                pushed: recoveredCommit !== undefined,
                residualChangedFileCount: residualCount,
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
            assertSafeAdditionTypes(canonicalRoot, safeExplicitAddPaths);
            await git(canonicalRoot, ["read-tree", head], signal, indexEnvironment);
            await git(
                canonicalRoot,
                ["add", "--update", "--", workspacePathspec],
                signal,
                indexEnvironment
            );
            if (normalExplicitAddPaths.length > 0) {
                await git(
                    canonicalRoot,
                    ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    signal,
                    indexEnvironment,
                    pathspecInput(normalExplicitAddPaths)
                );
            }
            if (safeStagedAdditionPaths.length > 0) {
                await git(
                    canonicalRoot,
                    ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    signal,
                    indexEnvironment,
                    pathspecInput(safeStagedAdditionPaths)
                );
            }
            const staged = await runGit(
                canonicalRoot,
                [
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=no",
                    "--",
                    workspacePathspec,
                ],
                signal,
                indexEnvironment
            );
            const stagedPaths = uniquePaths(parseWorkspaceStatus(staged).changedPaths);
            if (stagedPaths.length === 0) {
                return {
                    changedFileCount: 0,
                    pushed: false,
                    residualChangedFileCount: await residualChangedFileCount(
                        canonicalRoot,
                        signal
                    ),
                };
            }
            const changedFileCount = stagedPaths.length;
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
            const prePushResidualChangedFileCount = await residualChangedFileCount(
                canonicalRoot,
                signal
            );
            await pushAndClassify(
                canonicalRoot,
                commit,
                recoveredCommit ?? upstreamHead,
                signal
            );
            let finalResidualChangedFileCount = prePushResidualChangedFileCount;
            try {
                finalResidualChangedFileCount = await residualChangedFileCount(
                    canonicalRoot,
                    AbortSignal.timeout(cleanupTimeoutMs)
                );
            } catch {
                // A post-push observation cannot turn a confirmed publication into failure.
            }
            return {
                changedFileCount,
                commit,
                pushed: true,
                residualChangedFileCount: finalResidualChangedFileCount,
            };
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
