import Fs from "node:fs";
import Path from "node:path";

const gitExecutable = "/usr/bin/git";
const outputMaximumBytes = 64 * 1024;
const commandTimeoutMs = 60_000;
const commitMessage = "chore: sync OpenClaw workspace state";

export interface WorkspaceGitSyncResult {
    readonly changedFileCount: number;
    readonly commit?: string;
    readonly pushed: boolean;
}

async function git(
    root: string,
    arguments_: readonly string[],
    parentSignal?: AbortSignal
): Promise<string> {
    const signal =
        parentSignal === undefined
            ? AbortSignal.timeout(commandTimeoutMs)
            : AbortSignal.any([parentSignal, AbortSignal.timeout(commandTimeoutMs)]);
    const process = Bun.spawn([gitExecutable, ...arguments_], {
        cwd: root,
        env: { HOME: "/home/ubuntu", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    if (
        exitCode !== 0 ||
        Buffer.byteLength(stdout) > outputMaximumBytes ||
        Buffer.byteLength(stderr) > outputMaximumBytes
    ) {
        throw new Error("Workspace Git command failed");
    }
    return stdout.trim();
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
        const [repositoryRoot, branch, upstream, head, upstreamHead] = await Promise.all([
            git(canonicalRoot, ["rev-parse", "--show-toplevel"], signal),
            git(canonicalRoot, ["branch", "--show-current"], signal),
            git(canonicalRoot, ["rev-parse", "--abbrev-ref", "@{upstream}"], signal),
            git(canonicalRoot, ["rev-parse", "HEAD"], signal),
            git(canonicalRoot, ["rev-parse", "@{upstream}"], signal),
        ]);
        if (
            repositoryRoot !== canonicalRoot ||
            branch !== "main" ||
            upstream !== "origin/main"
        ) {
            throw new Error("Workspace Git source is not synchronized");
        }
        let recoveredCommit: string | undefined;
        if (head !== upstreamHead) {
            const pendingSubjects = await git(
                canonicalRoot,
                ["log", "--format=%s", "@{upstream}..HEAD"],
                signal
            );
            if (
                pendingSubjects === "" ||
                pendingSubjects.split("\n").some((subject) => subject !== commitMessage)
            ) {
                throw new Error("Workspace Git source is not synchronized");
            }
            await git(canonicalRoot, ["push", "origin", "HEAD:refs/heads/main"], signal);
            recoveredCommit = head;
        }

        const changed = await git(
            canonicalRoot,
            ["status", "--porcelain=v1", "--untracked-files=no"],
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

        await git(canonicalRoot, ["add", "--update"], signal);
        const staged = await Bun.spawn(
            [gitExecutable, "diff", "--cached", "--quiet", "--exit-code"],
            { cwd: canonicalRoot, signal, stderr: "ignore", stdout: "ignore" }
        ).exited;
        if (staged === 0) return { changedFileCount: 0, pushed: false };
        if (staged !== 1) throw new Error("Workspace Git staging check failed");

        await git(canonicalRoot, ["commit", "-m", commitMessage], signal);
        const commit = await git(canonicalRoot, ["rev-parse", "HEAD"], signal);
        await git(canonicalRoot, ["push", "origin", "HEAD:refs/heads/main"], signal);
        return { changedFileCount, commit, pushed: true };
    };
}
