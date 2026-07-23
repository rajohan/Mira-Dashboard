import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { database } from "../database.ts";
import { runProcess } from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

interface GitSyncResult {
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

const WORKSPACE_SYNC_JOB_ID = "git.openclaw.workspace-sync";
const OPENCLAW_SYNC_COMMIT_MESSAGE = "chore: sync OpenClaw workspace state";
const DOCKER_SYNC_COMMIT_MESSAGE = "chore: update managed app images";
const GIT_SYNC_TIMEOUT_MS = 30_000;
const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_WORKSPACE_SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const gitSyncLocks = new Map<string, { promise: Promise<void> }>();
const DOCKER_COMPOSE_FILE_RE =
    /^(?:[^/]+\/)*(?:compose|docker-compose)(?:\.override)?\.ya?ml$/u;
const OPENCLAW_SAFE_PATHS = [
    "workspace/AGENTS.md",
    "workspace/MEMORY.md",
    "workspace/DREAMS.md",
    "workspace/HEARTBEAT.md",
    "workspace/IDENTITY.md",
    "workspace/SOUL.md",
    "workspace/TOOLS.md",
    "workspace/USER.md",
    "workspace/WORKFLOW_AUTO.md",
    "workspace/memory/",
    "workspace/wiki/",
    "workspace/coder/",
    "workspace/communicator/",
    "workspace/researcher/",
] as const;

function getOpenClawRoot(): string {
    const homeDirectory = process.env.HOME?.trim() || homedir().trim();
    return (
        process.env.MIRA_OPENCLAW_ROOT?.trim() ||
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim() ||
        path.join(homeDirectory, ".openclaw")
    );
}

function getDockerAppsRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
}

function toGitPath(value: string): string {
    return value.split(path.sep).join("/");
}

function relativePath(basePath: string, targetPath: string): string | undefined {
    const relative = toGitPath(path.relative(basePath, targetPath));
    if (relative === "") return ".";
    if (relative === ".." || relative.startsWith("../")) return undefined;
    return relative;
}

function parseStatusPaths(output: string): string[] {
    const entries = output.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] ?? "";
        if (entry.length < 4) continue;
        paths.push(entry.slice(3));
        const status = entry.slice(0, 2);
        if (status.includes("R") || status.includes("C")) {
            const previousPath = entries[index + 1];
            if (previousPath) paths.push(previousPath);
            index += 1;
        }
    }
    return paths;
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function literalPathspec(path_: string): string {
    return `:(literal)${path_}`;
}

async function git(arguments_: string[], options: GitCommandOptions): Promise<string> {
    const result = await runProcess("git", arguments_, {
        cwd: options.cwd,
        env: process.env,
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

function isOpenClawSafePath(path_: string): boolean {
    return OPENCLAW_SAFE_PATHS.some((safePath) =>
        safePath.endsWith("/") ? path_.startsWith(safePath) : path_ === safePath
    );
}

function isDockerUpdaterSafePath(
    path_: string,
    appsPath: string,
    shouldAllowRepoRootCompose: boolean
): boolean {
    const dirname = path.dirname(path_);
    const isAncestorComposePath =
        shouldAllowRepoRootCompose &&
        (dirname === "." || appsPath.startsWith(`${dirname}/`));
    const relativeToApps =
        appsPath === "."
            ? path_
            : path_.startsWith(`${appsPath}/`)
              ? path_.slice(appsPath.length + 1)
              : isAncestorComposePath
                ? path_
                : undefined;
    return relativeToApps !== undefined && DOCKER_COMPOSE_FILE_RE.test(relativeToApps);
}

async function resolveDockerGitScope(
    signal?: AbortSignal
): Promise<{ appsPath: string; repoPath: string }> {
    const appsRoot = realpathSync(getDockerAppsRoot());
    const repoPath = await git(["rev-parse", "--show-toplevel"], {
        cwd: appsRoot,
        signal,
    });
    const appsPath = relativePath(repoPath, appsRoot);
    if (!appsPath) {
        throw new Error(`Docker apps root is outside git repository: ${appsRoot}`);
    }
    return { appsPath, repoPath };
}

async function dockerGitScope(
    signal?: AbortSignal
): Promise<{ appsPath: string; repoPath: string }> {
    return await resolveDockerGitScope(signal);
}

export async function dirtyDockerUpdaterPaths(
    paths: string[],
    signal?: AbortSignal
): Promise<Set<string> | undefined> {
    try {
        const scope = await dockerGitScope(signal);
        const statusPathspecs = normalizeDockerChangedPaths(scope.repoPath, paths) ?? [];
        if (statusPathspecs.length === 0) return new Set();
        const status = await git(
            [
                "status",
                "--porcelain=v1",
                "-z",
                "--",
                ...statusPathspecs.map((path_) => literalPathspec(path_)),
            ],
            { cwd: scope.repoPath, signal }
        );
        return new Set(
            parseStatusPaths(status).map((statusPath) =>
                path.resolve(scope.repoPath, statusPath)
            )
        );
    } catch {
        signal?.throwIfAborted();
        return undefined;
    }
}

function normalizeDockerChangedPaths(
    repoPath: string,
    paths: string[] | undefined
): string[] | undefined {
    if (!paths) return undefined;
    return paths
        .map((path_) =>
            path.isAbsolute(path_) ? relativePath(repoPath, path.resolve(path_)) : path_
        )
        .filter((path_): path_ is string => Boolean(path_));
}

async function commitAndPushPaths(
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
                env: process.env,
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

interface InspectedUpstream {
    name: string;
    refspec: string;
    remote: string;
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
            env: process.env,
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

async function pushPendingAutomationCommits(
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

async function withGitSyncLock<T>(
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

export async function syncOpenClawWorkspaceSafePaths(
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult> {
    const repoPath = getOpenClawRoot();
    return withGitSyncLock(
        repoPath,
        async () => {
            const status = await git(["status", "--porcelain=v1", "-z", "-uall"], {
                cwd: repoPath,
                signal,
            });
            const changedPaths = parseStatusPaths(status);
            const safePaths = changedPaths.filter((path_) => isOpenClawSafePath(path_));
            if (safePaths.length === 0) {
                const pushedPending = await pushPendingAutomationCommits(
                    repoPath,
                    [OPENCLAW_SYNC_COMMIT_MESSAGE],
                    signal,
                    protectFromCancellation
                );
                if (pushedPending) return pushedPending;
                return {
                    changedPaths: [],
                    pushed: false,
                    skippedReason: "no safe changes",
                };
            }
            return commitAndPushPaths(
                repoPath,
                safePaths,
                OPENCLAW_SYNC_COMMIT_MESSAGE,
                signal,
                protectFromCancellation
            );
        },
        signal
    );
}

export async function syncDockerUpdaterChanges(
    paths?: string[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult> {
    const scope = await dockerGitScope(signal);
    const { appsPath, repoPath } = scope;
    return withGitSyncLock(
        repoPath,
        async () => {
            const statusPathspecs = normalizeDockerChangedPaths(repoPath, paths);
            const safePaths =
                statusPathspecs?.length === 0
                    ? []
                    : parseStatusPaths(
                          await git(
                              [
                                  "status",
                                  "--porcelain=v1",
                                  "-z",
                                  "--",
                                  ...(statusPathspecs ?? [appsPath]).map((path_) =>
                                      literalPathspec(path_)
                                  ),
                              ],
                              {
                                  cwd: repoPath,
                                  signal,
                              }
                          )
                      ).filter((path_) =>
                          isDockerUpdaterSafePath(
                              path_,
                              appsPath,
                              statusPathspecs !== undefined
                          )
                      );
            if (safePaths.length === 0) {
                const pushedPending = await pushPendingAutomationCommits(
                    repoPath,
                    [DOCKER_SYNC_COMMIT_MESSAGE],
                    signal,
                    protectFromCancellation
                );
                if (pushedPending) return pushedPending;
                return {
                    changedPaths: [],
                    pushed: false,
                    skippedReason: "no safe changes",
                };
            }
            return commitAndPushPaths(
                repoPath,
                safePaths,
                DOCKER_SYNC_COMMIT_MESSAGE,
                signal,
                protectFromCancellation
            );
        },
        signal
    );
}

export function registerGitHygieneScheduledJobs(): void {
    const job = {
        id: WORKSPACE_SYNC_JOB_ID,
        name: "OpenClaw workspace sync",
        description: "Commit and push safe generated OpenClaw workspace state.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "05:20",
        actionKey: "git.openclaw.workspace-sync",
        actionPayload: {},
        resourceClass: "host-heavy",
    } as const;
    registerScheduledJobAction(
        "git.openclaw.workspace-sync",
        async (_job, signal, context) => {
            const result = await syncOpenClawWorkspaceSafePaths(
                signal,
                context.protectFromCancellation
            );
            return { ...result };
        },
        { timeoutMs: GIT_WORKSPACE_SYNC_TIMEOUT_MS }
    );
    database.run("BEGIN");
    try {
        removeScheduledJobsNotInAction("git.openclaw.workspace-sync", [job.id]);
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing?.timeOfDay ?? job.timeOfDay,
            cronExpression: existing?.cronExpression ?? undefined,
        });
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
