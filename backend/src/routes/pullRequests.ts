import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

const execFileAsync = promisify(execFile);

const DASHBOARD_REPO = "rajohan/Mira-Dashboard";
const DASHBOARD_ROOT =
    process.env.MIRA_DASHBOARD_ROOT || "/home/ubuntu/projects/mira-dashboard";
const DASHBOARD_WORKTREE_ROOT =
    process.env.MIRA_DASHBOARD_WORKTREE_ROOT ||
    "/home/ubuntu/projects/mira-dashboard-worktrees";
const DASHBOARD_SERVICE = "mira-dashboard.service";
const MIRA_AUTHOR = "mira-2026";
const DEFAULT_BASE = "main";
const DEPLOYMENT_DIR = path.join(process.cwd(), "data", "deployments");
const MAX_BUFFER = 20 * 1024 * 1024;

/** Represents command result. */
interface CommandResult {
    stdout: string;
    stderr: string;
}

/** Represents pull request author. */
interface PullRequestAuthor {
    login?: string;
    name?: string;
}

/** Represents pull request summary. */
interface PullRequestSummary {
    number: number;
    title: string;
    body?: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    author: PullRequestAuthor;
    createdAt: string;
    updatedAt: string;
    isDraft: boolean;
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    statusCheckRollup?: unknown[];
    additions?: number;
    deletions?: number;
    changedFiles?: number;
}

/** Represents deployment job. */
interface DeploymentJob {
    id: string;
    status: "building" | "restart-scheduled" | "ok" | "failed";
    startedAt: string;
    updatedAt: string;
    commit?: string;
    note?: string;
    stdout?: string;
    stderr?: string;
}

/** Represents production checkout status. */
interface ProductionCheckoutStatus {
    root: string;
    expectedRoot: string;
    worktreeRoot: string;
    branch: string;
    expectedBranch: string;
    head: string;
    upstream?: string;
    isClean: boolean;
    isProductionRoot: boolean;
    isSafeForDeploy: boolean;
    statusShort?: string;
}

/** Represents git worktree. */
interface GitWorktree {
    path: string;
    branch?: string;
    head?: string;
}

/** Represents worktree cleanup result. */
interface WorktreeCleanupResult {
    status: "removed" | "skipped" | "warning";
    branch: string;
    path?: string;
    message: string;
}

/** Performs async route. */
function asyncRoute(handler: RequestHandler): RequestHandler {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch((error) => {
            console.error("[pullRequestsRoutes]", error);
            if (res.headersSent) {
                next(error);
                return;
            }
            res.status(500).json({
                error:
                    error instanceof Error ? error.message : "Pull request route failed",
            });
        });
    };
}

/** Performs ensure deployment dir. */
function ensureDeploymentDir(): void {
    fs.mkdirSync(DEPLOYMENT_DIR, { recursive: true });
}

/** Performs deployment path. */
function deploymentPath(jobId: string): string {
    return path.join(DEPLOYMENT_DIR, `${jobId}.json`);
}

/** Performs write deployment job. */
function writeDeploymentJob(job: DeploymentJob): void {
    ensureDeploymentDir();
    fs.writeFileSync(deploymentPath(job.id), JSON.stringify(job, null, 2));
}

/** Performs read deployment jobs. */
function readDeploymentJobs(): DeploymentJob[] {
    ensureDeploymentDir();
    return fs
        .readdirSync(DEPLOYMENT_DIR)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
            const raw = fs.readFileSync(path.join(DEPLOYMENT_DIR, file), "utf8");
            return JSON.parse(raw) as DeploymentJob;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 10);
}

/** Performs trim output. */
function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/** Builds command env. */
function buildCommandEnv(): NodeJS.ProcessEnv {
    const githubToken = process.env.MIRA_GITHUB_TOKEN || process.env.GH_TOKEN;
    return {
        ...process.env,
        ...(githubToken
            ? {
                  GH_TOKEN: githubToken,
                  GITHUB_TOKEN: githubToken,
              }
            : {}),
    };
}

/** Performs run command. */
async function runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
    const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd || DASHBOARD_ROOT,
        env: buildCommandEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs || 120_000,
    });

    return {
        stdout: trimOutput(String(stdout || "")),
        stderr: trimOutput(String(stderr || "")),
    };
}

/** Runs a GitHub CLI command and parses its JSON output. */
async function runGhJson<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync("gh", args, {
        cwd: DASHBOARD_ROOT,
        env: buildCommandEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: 60_000,
    });

    return JSON.parse(String(stdout || "null")) as T;
}

/** Lists open pull requests targeting the dashboard production branch. */
async function listDashboardPullRequests(): Promise<PullRequestSummary[]> {
    const pullRequests = await runGhJson<PullRequestSummary[]>([
        "pr",
        "list",
        "--repo",
        DASHBOARD_REPO,
        "--state",
        "open",
        "--base",
        DEFAULT_BASE,
        "--limit",
        "1000",
        "--json",
        [
            "number",
            "title",
            "body",
            "url",
            "headRefName",
            "baseRefName",
            "author",
            "createdAt",
            "updatedAt",
            "isDraft",
            "mergeable",
            "mergeStateStatus",
            "reviewDecision",
            "statusCheckRollup",
            "additions",
            "deletions",
            "changedFiles",
        ].join(","),
    ]);

    return pullRequests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Returns the current GitHub metadata for one pull request. */
async function getPullRequest(number: number): Promise<PullRequestSummary> {
    return runGhJson<PullRequestSummary>([
        "pr",
        "view",
        String(number),
        "--repo",
        DASHBOARD_REPO,
        "--json",
        [
            "number",
            "title",
            "body",
            "url",
            "headRefName",
            "baseRefName",
            "author",
            "createdAt",
            "updatedAt",
            "isDraft",
            "mergeable",
            "mergeStateStatus",
            "reviewDecision",
            "statusCheckRollup",
            "additions",
            "deletions",
            "changedFiles",
        ].join(","),
    ]);
}

/** Validates pr number. */
function validatePrNumber(value: unknown): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error("Invalid pull request number");
    }
    return number;
}

/** Parses git worktrees. */
function parseGitWorktrees(output: string): GitWorktree[] {
    return output
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block) => {
            const worktree: GitWorktree = { path: "" };
            for (const line of block.split("\n")) {
                if (line.startsWith("worktree ")) {
                    worktree.path = line.slice("worktree ".length);
                }
                if (line.startsWith("HEAD ")) {
                    worktree.head = line.slice("HEAD ".length);
                }
                if (line.startsWith("branch ")) {
                    worktree.branch = line.slice("branch ".length);
                }
            }
            return worktree;
        })
        .filter((worktree) => worktree.path);
}

/** Returns whether a path is strictly inside the configured worktree root. */
function isPathInsideRoot(value: string, root: string): boolean {
    const resolvedValue = path.resolve(value);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedValue);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Performs find worktree for branch. */
async function findWorktreeForBranch(branch: string): Promise<GitWorktree | null> {
    const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], {
        timeoutMs: 30_000,
    });
    const expectedRef = `refs/heads/${branch}`;
    return (
        parseGitWorktrees(stdout).find(
            (worktree) => worktree.branch === expectedRef || worktree.branch === branch
        ) || null
    );
}

/** Performs cleanup pull request worktree. */
async function cleanupPullRequestWorktree(
    branch: string
): Promise<WorktreeCleanupResult> {
    try {
        const worktree = await findWorktreeForBranch(branch);
        if (!worktree) {
            return {
                status: "skipped",
                branch,
                message: `No local worktree found for ${branch}`,
            };
        }

        const worktreePath = path.resolve(worktree.path);
        if (!isPathInsideRoot(worktreePath, DASHBOARD_WORKTREE_ROOT)) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}; worktree path is outside ${DASHBOARD_WORKTREE_ROOT}`,
            };
        }

        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--short"],
            { timeoutMs: 30_000 }
        );
        if (status.trim()) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}; worktree has local changes`,
            };
        }

        await runCommand("git", ["worktree", "remove", worktreePath], {
            timeoutMs: 60_000,
        });

        return {
            status: "removed",
            branch,
            path: worktreePath,
            message: `Removed local worktree for ${branch}`,
        };
    } catch (error) {
        return {
            status: "warning",
            branch,
            message:
                error instanceof Error
                    ? `Worktree cleanup warning for ${branch}: ${error.message}`
                    : `Worktree cleanup warning for ${branch}`,
        };
    }
}

/** Validates mira pr. */
function validateMiraPr(pr: PullRequestSummary): void {
    if (pr.author?.login !== MIRA_AUTHOR) {
        throw new Error("Only Mira-authored pull requests can be managed here");
    }

    if (pr.baseRefName !== DEFAULT_BASE) {
        throw new Error(
            `Only ${DEFAULT_BASE}-targeted pull requests can be managed here`
        );
    }

    if (pr.isDraft) {
        throw new Error("Draft pull requests cannot be approved from the dashboard");
    }
}

/** Returns production checkout status. */
async function getProductionCheckoutStatus(): Promise<ProductionCheckoutStatus> {
    const [{ stdout: root }, { stdout: branch }, { stdout: head }, { stdout: status }] =
        await Promise.all([
            runCommand("git", ["rev-parse", "--show-toplevel"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--short", "HEAD"], {
                timeoutMs: 30_000,
            }),
            runCommand("git", ["status", "--short"], { timeoutMs: 30_000 }),
        ]);

    let upstream: string | undefined;
    try {
        const { stdout } = await runCommand(
            "git",
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            { timeoutMs: 30_000 }
        );
        upstream = stdout.trim() || undefined;
    } catch {
        upstream = undefined;
    }

    const productionRoot = root.trim();
    const currentBranch = branch.trim();
    const statusShort = status.trim();
    const isClean = statusShort.length === 0;
    const isProductionRoot =
        path.resolve(productionRoot) === path.resolve(DASHBOARD_ROOT);

    return {
        root: productionRoot,
        expectedRoot: DASHBOARD_ROOT,
        worktreeRoot: DASHBOARD_WORKTREE_ROOT,
        branch: currentBranch,
        expectedBranch: DEFAULT_BASE,
        head: head.trim(),
        upstream,
        isClean,
        isProductionRoot,
        isSafeForDeploy: isClean && isProductionRoot && currentBranch === DEFAULT_BASE,
        statusShort: statusShort || undefined,
    };
}

/** Performs ensure production checkout. */
async function ensureProductionCheckout(): Promise<void> {
    const status = await getProductionCheckoutStatus();

    if (!status.isProductionRoot) {
        throw new Error(
            `Expected production checkout at ${DASHBOARD_ROOT}, got ${status.root}`
        );
    }

    if (!status.isClean) {
        throw new Error("Production checkout has local changes; refusing deploy/merge");
    }
}

/** Performs ensure production ready for deploy. */
async function ensureProductionReadyForDeploy(): Promise<void> {
    const status = await getProductionCheckoutStatus();

    if (!status.isSafeForDeploy) {
        throw new Error(
            `Production checkout must be clean ${DEFAULT_BASE} before deploy; current branch=${status.branch}, clean=${status.isClean}`
        );
    }
}

/** Performs sync main. */
async function syncMain(): Promise<void> {
    await ensureProductionCheckout();
    await runCommand("git", ["fetch", "--prune", "origin"], { timeoutMs: 120_000 });
    await runCommand("git", ["checkout", DEFAULT_BASE], { timeoutMs: 60_000 });
    await runCommand("git", ["pull", "--ff-only", "origin", DEFAULT_BASE], {
        timeoutMs: 120_000,
    });
    await ensureProductionReadyForDeploy();
}

/** Performs shell quote. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Performs schedule restart health check. */
async function scheduleRestartHealthCheck(job: DeploymentJob): Promise<CommandResult> {
    const jobPath = deploymentPath(job.id);
    const okJob: DeploymentJob = {
        ...job,
        status: "ok",
        updatedAt: new Date().toISOString(),
        note: "Restarted service and health check passed",
    };
    const failedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        note: "Restart was triggered, but health check failed",
    };

    const script = [
        "restart_status=0",
        `systemctl restart ${DASHBOARD_SERVICE} || restart_status=$?`,
        "sleep 4",
        'if [ "$restart_status" -eq 0 ] && curl -fsS http://127.0.0.1:3100/api/health >/dev/null; then',
        `  printf %s ${shellQuote(JSON.stringify(okJob, null, 2))} > ${shellQuote(jobPath)}`,
        "else",
        `  printf %s ${shellQuote(JSON.stringify(failedJob, null, 2))} > ${shellQuote(jobPath)}`,
        "fi",
    ].join("\n");

    return runCommand(
        "sudo",
        [
            "-n",
            "systemd-run",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard deploy restart + health check",
            "/bin/bash",
            "-lc",
            script,
        ],
        { timeoutMs: 30_000 }
    );
}

/** Performs deploy latest. */
async function deployLatest(): Promise<DeploymentJob> {
    const now = new Date().toISOString();
    const job: DeploymentJob = {
        id: Date.now().toString(36),
        status: "building",
        startedAt: now,
        updatedAt: now,
        note: "Deploy started",
    };
    writeDeploymentJob(job);

    try {
        await syncMain();

        await runCommand("npm", ["run", "build"], { timeoutMs: 180_000 });
        await runCommand("npm", ["--prefix", "backend", "run", "build"], {
            timeoutMs: 120_000,
        });
        const { stdout: commit } = await runCommand(
            "git",
            ["rev-parse", "--short", "HEAD"],
            {
                timeoutMs: 30_000,
            }
        );

        const restartScheduled: DeploymentJob = {
            ...job,
            status: "restart-scheduled",
            updatedAt: new Date().toISOString(),
            commit: commit.trim(),
            note: "Build passed; restart + health check scheduled",
        };
        writeDeploymentJob(restartScheduled);
        await scheduleRestartHealthCheck(restartScheduled);
        return restartScheduled;
    } catch (error) {
        const failed: DeploymentJob = {
            ...job,
            status: "failed",
            updatedAt: new Date().toISOString(),
            note: error instanceof Error ? error.message : "Deploy failed",
        };
        writeDeploymentJob(failed);
        throw error;
    }
}

/** Performs approve pull request. */
async function approvePullRequest(number: number, deploy: boolean) {
    await ensureProductionCheckout();
    const pr = await getPullRequest(number);
    validateMiraPr(pr);

    await runCommand(
        "gh",
        [
            "pr",
            "merge",
            String(number),
            "--squash",
            "--delete-branch",
            "--repo",
            DASHBOARD_REPO,
        ],
        { timeoutMs: 120_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName);
    await syncMain();

    return {
        ok: true,
        message: deploy ? `PR #${number} merged; deploy started` : `PR #${number} merged`,
        deployment: deploy ? await deployLatest() : undefined,
        cleanup,
    };
}

/** Performs reject pull request. */
async function rejectPullRequest(number: number, comment: string) {
    const pr = await getPullRequest(number);
    validateMiraPr(pr);

    await runCommand(
        "gh",
        ["pr", "close", String(number), "--repo", DASHBOARD_REPO, "--comment", comment],
        { timeoutMs: 60_000 }
    );
    const cleanup = await cleanupPullRequestWorktree(pr.headRefName);

    return {
        ok: true,
        message: `PR #${number} closed`,
        cleanup,
    };
}

/** Registers pull requests API routes. */
export default function pullRequestsRoutes(app: express.Application): void {
    app.get(
        "/api/pull-requests",
        asyncRoute(async (_req, res) => {
            res.json({ pullRequests: await listDashboardPullRequests() });
        })
    );

    app.get(
        "/api/pull-requests/deployments",
        asyncRoute(async (_req, res) => {
            res.json({ deployments: readDeploymentJobs() });
        })
    );

    app.get(
        "/api/pull-requests/production-checkout",
        asyncRoute(async (_req, res) => {
            res.json({ checkout: await getProductionCheckoutStatus() });
        })
    );

    app.post(
        "/api/pull-requests/deploy",
        express.json(),
        asyncRoute(async (_req, res) => {
            res.json({ ok: true, deployment: await deployLatest() });
        })
    );

    app.post(
        "/api/pull-requests/:number/approve",
        express.json(),
        asyncRoute(async (req, res) => {
            const number = validatePrNumber(req.params.number);
            const deploy = req.body?.deploy === true;
            res.json(await approvePullRequest(number, deploy));
        })
    );

    app.post(
        "/api/pull-requests/:number/reject",
        express.json(),
        asyncRoute(async (req, res) => {
            const number = validatePrNumber(req.params.number);
            const comment =
                typeof req.body?.comment === "string" && req.body.comment.trim()
                    ? req.body.comment.trim()
                    : "Closed from Mira Dashboard after Raymond rejected it.";
            res.json(await rejectPullRequest(number, comment));
        })
    );
}
