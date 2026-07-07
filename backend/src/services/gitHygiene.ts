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
    timeoutMs?: number;
}

const WORKSPACE_SYNC_JOB_ID = "git.openclaw.workspace-sync";
const GIT_SYNC_TIMEOUT_MS = 120_000;
const GIT_SAFE_STATUS_RE = /^(?:[ MADRCU?!]{2}) (.+)$/u;
const DOCKER_COMPOSE_FILE_RE =
    /^apps\/[^/]+\/(?:compose|docker-compose)(?:\.override)?\.ya?ml$/u;
const OPENCLAW_SAFE_PATHS = [
    "workspace/MEMORY.md",
    "workspace/DREAMS.md",
    "workspace/HEARTBEAT.md",
    "workspace/TOOLS.md",
    "workspace/memory/",
    "workspace/wiki/",
    "workspace/coder/memory/",
    "workspace/communicator/memory/",
    "workspace/researcher/memory/",
] as const;

function getOpenClawRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_OPENCLAW_ROOT", "/home/ubuntu/.openclaw");
}

function getDockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}

function normalizeStatusPath(value: string): string {
    const renamedPath = value.match(/^(.+) -> (.+)$/u);
    return (renamedPath?.[2] ?? value).trim().replaceAll(/^"|"$/gu, "");
}

function parseStatusPaths(output: string): string[] {
    return output
        .split("\n")
        .map((line) => {
            const match = line.match(GIT_SAFE_STATUS_RE);
            const statusPath = match?.[1];
            return statusPath ? normalizeStatusPath(statusPath) : undefined;
        })
        .filter((path_): path_ is string => Boolean(path_));
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

async function git(arguments_: string[], options: GitCommandOptions): Promise<string> {
    const result = await runProcess("git", arguments_, {
        cwd: options.cwd,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
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

function isDockerUpdaterSafePath(path_: string): boolean {
    return DOCKER_COMPOSE_FILE_RE.test(path_);
}

async function commitAndPushPaths(
    repoPath: string,
    paths: string[],
    message: string
): Promise<GitSyncResult> {
    const changedPaths = uniqueSorted(paths);
    if (changedPaths.length === 0) {
        return { changedPaths, pushed: false, skippedReason: "no safe changes" };
    }

    await git(["add", "--", ...changedPaths], { cwd: repoPath });
    const stagedDiff = await runProcess("git", ["diff", "--cached", "--quiet"], {
        cwd: repoPath,
        env: process.env,
        timeoutMs: GIT_SYNC_TIMEOUT_MS,
    });
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

    await git(["commit", "-m", message], { cwd: repoPath });
    const commit = await git(["rev-parse", "--short", "HEAD"], { cwd: repoPath });
    await git(["push"], { cwd: repoPath, timeoutMs: 180_000 });
    return { changedPaths, commit, pushed: true };
}

export async function syncOpenClawWorkspaceSafePaths(): Promise<GitSyncResult> {
    const repoPath = getOpenClawRoot();
    const status = await git(["status", "--porcelain"], { cwd: repoPath });
    const changedPaths = parseStatusPaths(status);
    const safePaths = changedPaths.filter((path_) => isOpenClawSafePath(path_));
    if (safePaths.length === 0) {
        return { changedPaths: [], pushed: false, skippedReason: "no safe changes" };
    }
    return commitAndPushPaths(
        repoPath,
        safePaths,
        "chore: sync OpenClaw workspace state"
    );
}

export async function syncDockerUpdaterChanges(): Promise<GitSyncResult> {
    const repoPath = getDockerRoot();
    const status = await git(["status", "--porcelain", "--", "apps"], {
        cwd: repoPath,
    });
    const safePaths = parseStatusPaths(status).filter((path_) =>
        isDockerUpdaterSafePath(path_)
    );
    if (safePaths.length === 0) {
        return { changedPaths: [], pushed: false, skippedReason: "no safe changes" };
    }
    return commitAndPushPaths(repoPath, safePaths, "chore: update managed app images");
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
    } as const;
    registerScheduledJobAction("git.openclaw.workspace-sync", async () => {
        const result = await syncOpenClawWorkspaceSafePaths();
        return { ...result };
    });
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
}
