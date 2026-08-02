import { runProcess } from "../../lib/processes.ts";

export interface GitSyncResult {
    changedPaths: string[];
    commit?: string;
    skippedReason?: string;
    pushed: boolean;
}

interface GitCommandOptions {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

interface InspectedUpstream {
    name: string;
    refspec: string;
    remote: string;
}

const GIT_SYNC_TIMEOUT_MS = 30_000;
const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_DISABLED_HOOKS_PATH = "/dev/null";
const gitSyncLocks = new Map<string, { promise: Promise<void> }>();

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export function parseStatusPaths(output: string): string[] {
    const entries = output.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] ?? "";
        if (entry.length < 4) continue;
        paths.push(entry.slice(3));
        const status = new Set(entry.slice(0, 2));
        if (status.has("R") || status.has("C")) {
            const previousPath = entries[index + 1];
            if (previousPath) paths.push(previousPath);
            index += 1;
        }
    }
    return paths;
}

export function literalPathspec(path_: string): string {
    return `:(literal)${path_}`;
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.GIT_CONFIG_COUNT;
    delete environment.GIT_CONFIG_PARAMETERS;
    for (const key of Object.keys(environment)) {
        if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) {
            delete environment[key];
        }
    }
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "core.hooksPath";
    environment.GIT_CONFIG_VALUE_0 = GIT_DISABLED_HOOKS_PATH;
    return environment;
}

export async function git(
    arguments_: string[],
    options: GitCommandOptions
): Promise<string> {
    const result = await runProcess("git", arguments_, {
        cwd: options.cwd,
        env: gitEnvironment(),
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? GIT_SYNC_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        throw new Error(
            `git ${arguments_.join(" ")} failed with exit code ${result.code}: ${
                result.stderr.trim() || result.stdout.trim()
            }`
        );
    }
    return result.stdout.trimEnd();
}

async function inspectUpstream(
    repoPath: string,
    signal?: AbortSignal
): Promise<InspectedUpstream | undefined> {
    const upstream = await runProcess(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        {
            cwd: repoPath,
            env: gitEnvironment(),
            signal,
            timeoutMs: GIT_SYNC_TIMEOUT_MS,
        }
    );
    if (upstream.code !== 0) return undefined;
    const upstreamName = upstream.stdout.trim();
    const separatorIndex = upstreamName.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === upstreamName.length - 1) {
        return undefined;
    }
    const remote = upstreamName.slice(0, separatorIndex);
    const branch = upstreamName.slice(separatorIndex + 1);
    return { name: upstreamName, refspec: `HEAD:refs/heads/${branch}`, remote };
}

async function pendingCommitState(
    repoPath: string,
    signal?: AbortSignal
): Promise<{ subjects: string[]; upstream: InspectedUpstream } | undefined> {
    const upstream = await inspectUpstream(repoPath, signal);
    if (!upstream) return undefined;
    const subjects = await git(["log", "--format=%s", `${upstream.name}..HEAD`], {
        cwd: repoPath,
        signal,
    });
    return { subjects: subjects.split("\n").filter(Boolean), upstream };
}

async function assertPendingCommitsAreAutomation(
    repoPath: string,
    allowedMessages: string[],
    signal?: AbortSignal
): Promise<void> {
    const pendingState = await pendingCommitState(repoPath, signal);
    if (pendingState === undefined) {
        throw new Error("Refusing to push without an inspectable upstream");
    }
    if (pendingState.subjects.some((subject) => !allowedMessages.includes(subject))) {
        throw new Error("Refusing to push unrelated local commits");
    }
}

export async function commitAndPushPaths(
    repoPath: string,
    paths: string[],
    message: string,
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult> {
    const changedPaths = uniqueSorted(paths);
    if (changedPaths.length === 0) {
        return { changedPaths, pushed: false, skippedReason: "no safe changes" };
    }

    await assertPendingCommitsAreAutomation(repoPath, [message], signal);
    const changedPathspecs = changedPaths.map((path_) => literalPathspec(path_));
    await git(["add", "--", ...changedPathspecs], { cwd: repoPath, signal });
    try {
        const stagedDiff = await runProcess(
            "git",
            ["diff", "--cached", "--quiet", "--", ...changedPathspecs],
            {
                cwd: repoPath,
                env: gitEnvironment(),
                signal,
                timeoutMs: GIT_SYNC_TIMEOUT_MS,
            }
        );
        if (stagedDiff.code === 0) {
            return { changedPaths, pushed: false, skippedReason: "no staged changes" };
        }
        if (stagedDiff.code !== 1) {
            throw new Error(
                `git diff --cached --quiet failed with exit code ${stagedDiff.code}: ${
                    stagedDiff.stderr.trim() || stagedDiff.stdout.trim()
                }`
            );
        }

        protectFromCancellation?.();
        await git(["commit", "--only", "-m", message, "--", ...changedPathspecs], {
            cwd: repoPath,
            signal,
        });
    } catch (error) {
        await git(["restore", "--staged", "--", ...changedPathspecs], { cwd: repoPath });
        throw error;
    }
    const upstream = await inspectUpstream(repoPath, signal);
    if (!upstream) {
        throw new Error("Refusing to push without an inspectable upstream");
    }
    const commit = await git(["rev-parse", "--short", "HEAD"], {
        cwd: repoPath,
        signal,
    });
    await git(["push", upstream.remote, upstream.refspec], {
        cwd: repoPath,
        signal,
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
    return { changedPaths, commit, pushed: true };
}

export async function pushPendingAutomationCommits(
    repoPath: string,
    allowedMessages: string[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult | undefined> {
    const pendingState = await pendingCommitState(repoPath, signal);
    if (
        pendingState === undefined ||
        pendingState.subjects.length === 0 ||
        pendingState.subjects.some((subject) => !allowedMessages.includes(subject))
    ) {
        return undefined;
    }

    protectFromCancellation?.();
    await git(["push", pendingState.upstream.remote, pendingState.upstream.refspec], {
        cwd: repoPath,
        signal,
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
    const commit = await git(["rev-parse", "--short", "HEAD"], {
        cwd: repoPath,
        signal,
    });
    return { changedPaths: [], commit, pushed: true };
}

export async function withGitSyncLock<T>(
    repoPath: string,
    action: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const wasPrevious = gitSyncLocks.get(repoPath)?.promise ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    const release = current.resolve;
    async function waitForCurrent(): Promise<void> {
        await wasPrevious;
        await current.promise;
    }
    const next = { promise: waitForCurrent() };
    gitSyncLocks.set(repoPath, next);
    await wasPrevious;
    try {
        signal?.throwIfAborted();
        return await action();
    } finally {
        release();
        if (gitSyncLocks.get(repoPath) === next) {
            gitSyncLocks.delete(repoPath);
        }
    }
}
