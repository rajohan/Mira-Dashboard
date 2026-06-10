import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalDashboardRoot = process.env.MIRA_DASHBOARD_ROOT;
const originalWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
const originalRajohanToken = process.env.RAJOHAN_GITHUB_TOKEN;
const originalFakeReviewStateFile = process.env.FAKE_GH_REVIEW_STATE_FILE;
const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;

function saveEnv(names: string[]): () => void {
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    return () => {
        for (const [name, value] of previous) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    };
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
    await chmod(filePath, 0o755);
}

async function waitForDeploymentStatus(
    jobId: string,
    status: string,
    tempDir: string
): Promise<Record<string, unknown>> {
    let lastJob = {} as Record<string, unknown>;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            const job = readDeploymentJobFromDb(jobId, tempDir);
            if (job) {
                lastJob = job;
                if (lastJob.status === status) {
                    return lastJob;
                }
            }
        } catch {
            // Deployment status can be updated by the detached restart worker.
        }
        await delay(25);
    }
    assert.equal(lastJob.status, status);
    return lastJob;
}

async function waitForDeploymentLockReleased(tempDir: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            if (!readDeploymentLockFromDb(tempDir)) {
                return;
            }
        } catch {
            // The detached restart worker may briefly hold the SQLite write lock.
        }
        await delay(25);
    }
    assert.equal(readDeploymentLockFromDb(tempDir), undefined);
}

function releaseDeploymentLockInDb(jobId: string, tempDir: string): void {
    withDeploymentDb(tempDir, (deploymentDb) => {
        deploymentDb
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(jobId);
    });
}

function withDeploymentDb<T>(tempDir: string, action: (db: DatabaseSync) => T): T {
    const deploymentDb = new DatabaseSync(
        path.join(tempDir, "data", "mira-dashboard.db")
    );
    try {
        deploymentDb.exec("PRAGMA busy_timeout = 1000");
        deploymentDb.exec("PRAGMA foreign_keys = ON");
        return action(deploymentDb);
    } finally {
        deploymentDb.close();
    }
}

function readDeploymentJobFromDb(
    jobId: string,
    tempDir: string
): Record<string, unknown> | undefined {
    return withDeploymentDb(tempDir, (deploymentDb) =>
        deploymentDb
            .prepare(
                `
                SELECT
                    id,
                    status,
                    started_at AS startedAt,
                    updated_at AS updatedAt,
                    commit_sha AS "commit",
                    note,
                    stdout,
                    stderr
                FROM deployment_jobs
                WHERE id = ?
                `
            )
            .get(jobId)
    ) as Record<string, unknown> | undefined;
}

function readDeploymentLockFromDb(tempDir: string): string | undefined {
    return withDeploymentDb(tempDir, (deploymentDb) => {
        const row = deploymentDb
            .prepare("SELECT job_id FROM deployment_lock WHERE id = 1")
            .get() as { job_id: string } | undefined;
        return row?.job_id;
    });
}

function clearDeploymentState(tempDir: string): void {
    withDeploymentDb(tempDir, (deploymentDb) => {
        deploymentDb.prepare("DELETE FROM deployment_lock").run();
        deploymentDb.prepare("DELETE FROM deployment_jobs").run();
    });
}

async function waitForFile(filePath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            await stat(filePath);
            return;
        } catch {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    await stat(filePath);
}

async function installFakeCommands(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    await writeExecutable(
        path.join(binDir, "gh"),
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.FAKE_GH_JSON_LINES === "partial") {
  process.stdout.write('{"ok":1}\n\n{"ok":2}');
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "invalid") {
  process.stdout.write('{bad}\n');
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "invalid-final") {
  process.stdout.write('{bad}');
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "nonzero") {
  process.stderr.write("gh failed");
  process.exit(2);
}
if (process.env.FAKE_GH_JSON_LINES === "nonzero-no-stderr") {
  process.exit(2);
}
if (process.env.FAKE_GH_JSON_LINES === "empty-json") {
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "long-buffer") {
  process.stdout.write("x".repeat(700_000));
  setTimeout(() => {
    process.stdout.write("x".repeat(700_000));
    setTimeout(() => process.exit(0), 20);
  }, 20);
  return;
}
if (process.env.FAKE_GH_JSON_LINES === "long-line") {
  process.stdout.write("x".repeat(700_000));
  setTimeout(() => {
    process.stdout.write("x".repeat(700_000) + "\n");
    setTimeout(() => process.exit(0), 20);
  }, 20);
  return;
}
if (process.env.FAKE_GH_JSON_LINES === "long-complete-line") {
  process.stdout.write("x".repeat(1_100_000) + "\n");
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "long-complete-line-with-prefix") {
  process.stdout.write('{"ok":1}\n' + "x".repeat(1_100_000) + "\n");
  process.exit(0);
}
if (process.env.FAKE_GH_JSON_LINES === "timeout") {
  if (process.env.FAKE_GH_READY_FILE) {
    require("node:fs").writeFileSync(process.env.FAKE_GH_READY_FILE, "ready");
  }
  process.on("SIGTERM", () => {
    if (process.env.FAKE_GH_EXIT_FILE) {
      require("node:fs").writeFileSync(process.env.FAKE_GH_EXIT_FILE, "exited");
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000);
  return;
}
const pullRequests = [
{
  number: 10,
  title: "Add Playwright smoke tests",
  body: "Coverage batch",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
  headRefName: "add-playwright-smoke-tests",
  baseRefName: "main",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T00:00:00Z",
  updatedAt: "2026-05-11T00:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 12,
  deletions: 3,
  changedFiles: 4
},
{
  number: 11,
  title: "Raise frontend coverage",
  body: "Coverage follow-up",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/11",
  headRefName: "chore/coverage-to-100-followup",
  baseRefName: "main",
  author: { login: "rajohan" },
  createdAt: "2026-05-10T01:00:00Z",
  updatedAt: "2026-05-12T00:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 20,
  deletions: 5,
  changedFiles: 3
},
{
  number: 14,
  title: "Wait for protected deployment",
  body: "GitHub still reports a protected branch blocker",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/14",
  headRefName: "protected-deployment",
  baseRefName: "main",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T01:30:00Z",
  updatedAt: "2026-05-11T12:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 3,
  deletions: 1,
  changedFiles: 1
},
{
  number: 15,
  title: "Refresh lookup fails",
  body: "Keep the original list state if the fresh lookup fails",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/15",
  headRefName: "refresh-fails",
  baseRefName: "main",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T01:45:00Z",
  updatedAt: "2026-05-11T06:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 2,
  deletions: 0,
  changedFiles: 1
},
{
  number: 16,
  title: "Refresh dirty blocker",
  body: "Verify dirty merge states are refreshed",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/16",
  headRefName: "refresh-dirty-blocker",
  baseRefName: "main",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T01:50:00Z",
  updatedAt: "2026-05-11T06:30:00Z",
  isDraft: false,
  mergeable: "DIRTY",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 4,
  deletions: 2,
  changedFiles: 2
},
{
  number: 17,
  title: "Approved latest review",
  body: "Review decision has not caught up yet",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/17",
  headRefName: "reviewer-approved-refresh",
  baseRefName: "main",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T01:55:00Z",
  updatedAt: "2026-05-11T06:15:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "",
  latestOpinionatedReviews: {
    nodes: [
      {
        author: { login: "rajohan" },
        state: "APPROVED",
        submittedAt: "2026-05-11T06:10:00Z"
      }
    ]
  },
  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
  additions: 5,
  deletions: 2,
  changedFiles: 2
},
{
  number: 12,
  title: "Target a release branch",
  body: "Not for the main dashboard review queue",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/12",
  headRefName: "release-only",
  baseRefName: "release",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T02:00:00Z",
  updatedAt: "2026-05-13T00:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  statusCheckRollup: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1
}
];
if (args[0] === "pr" && args[1] === "list") {
  process.stderr.write("pr list should use paginated graphql instead");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "graphql") {
  if (!args.includes("--paginate")) {
    process.stderr.write("pull request listing should paginate");
    process.exit(1);
  }
  if (!args.includes("owner=rajohan") || !args.includes("name=Mira-Dashboard")) {
    process.stderr.write("pull request listing should pass the configured repo");
    process.exit(1);
  }
  const jqIndex = args.indexOf("--jq");
  const jq = args[jqIndex + 1] || "";
  if (
    jqIndex === -1 ||
    !jq.includes(".data.repository.pullRequests.nodes[]") ||
    !jq.includes(
      ".statusCheckRollup = (if .statusCheckRollup.state then [{status: .statusCheckRollup.state}] else [] end)"
    )
  ) {
    process.stderr.write(
      "pull request listing should flatten graphql nodes and status rollup state with jq"
    );
    process.exit(1);
  }
  if (!args.some((arg) => arg.includes("baseRefName: \"main\""))) {
    process.stderr.write("pull request listing should filter by base in graphql");
    process.exit(1);
  }
  const mainPullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.baseRefName === "main"
  );
  for (const pullRequest of mainPullRequests) {
    process.stdout.write(JSON.stringify(pullRequest) + "\n");
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const requested = Number(args[2]);
  const jsonIndex = args.indexOf("--json");
  const requestedFields =
    jsonIndex !== -1 && typeof args[jsonIndex + 1] === "string"
      ? args[jsonIndex + 1].split(",")
      : [];
  if (
    jsonIndex === -1 ||
    !requestedFields.includes("reviews") ||
    !requestedFields.includes("mergeStateStatus")
  ) {
    process.stderr.write("pr view should request reviews and mergeStateStatus JSON fields");
    process.exit(1);
  }
  if (requested === 10) {
    process.stdout.write(JSON.stringify({
      ...pullRequests[0],
      mergeStateStatus: "CLEAN"
    }));
    process.exit(0);
  }
  if (requested === 13) {
    const reviewApproved =
      process.env.FAKE_GH_REVIEW_STATE_FILE &&
      require("node:fs").existsSync(process.env.FAKE_GH_REVIEW_STATE_FILE);
    process.stdout.write(JSON.stringify({
      number: 13,
      title: "Pending CI",
      body: "Do not merge yet",
      url: "https://github.com/rajohan/Mira-Dashboard/pull/13",
      headRefName: "pending-ci",
      baseRefName: "main",
      author: { login: "mira-2026" },
      createdAt: "2026-05-10T03:00:00Z",
      updatedAt: "2026-05-14T00:00:00Z",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: reviewApproved ? "APPROVED" : "",
      statusCheckRollup: [{ status: "PENDING", name: "ci" }],
      additions: 1,
      deletions: 0,
      changedFiles: 1
    }));
    process.exit(0);
  }
  if (requested === 15) {
    process.stderr.write("fresh lookup failed");
    process.exit(1);
  }
  if (requested === 16) {
    process.stdout.write(JSON.stringify({
      ...pullRequests.find((candidate) => candidate.number === 16),
      title: "Fresh dirty blocker",
      body: "Fresh lookup still reports a dirty branch blocker"
    }));
    process.exit(0);
  }
  if (requested === 17) {
    process.stdout.write(JSON.stringify({
      ...pullRequests.find((candidate) => candidate.number === 17),
      mergeStateStatus: "CLEAN",
      title: "Approved latest review is mergeable"
    }));
    process.exit(0);
  }
  if (requested === 18) {
    process.stdout.write(JSON.stringify({
      number: 18,
      title: "External without review",
      body: "Passing CI but not reviewed",
      url: "https://github.com/rajohan/Mira-Dashboard/pull/18",
      headRefName: "external-without-review",
      baseRefName: "main",
      author: { login: "dependabot[bot]" },
      createdAt: "2026-05-10T01:57:00Z",
      updatedAt: "2026-05-11T06:20:00Z",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
      additions: 1,
      deletions: 1,
      changedFiles: 1
    }));
    process.exit(0);
  }
  const pr = pullRequests.find((candidate) => candidate.number === requested);
  if (!pr) {
    process.stderr.write("pull request not found");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "review") {
  if (process.env.GH_TOKEN !== "rajohan-review-token") {
    process.stderr.write("review should use Rajohan token");
    process.exit(1);
  }
  const repoIndex = args.indexOf("--repo");
  if (
    !args.includes("--approve") ||
    repoIndex === -1 ||
    args[repoIndex + 1] !== "rajohan/Mira-Dashboard"
  ) {
    process.stderr.write("review should approve the configured dashboard repo");
    process.exit(1);
  }
  if (process.env.FAKE_GH_REVIEW_STATE_FILE) {
    require("node:fs").writeFileSync(process.env.FAKE_GH_REVIEW_STATE_FILE, "approved");
  }
  process.stdout.write(args.slice(0, 4).join(" ") + "\n");
  process.exit(0);
}
if (args[0] === "pr" && ["merge", "close"].includes(args[1])) {
  if (args[1] === "close") {
    const idx = args.indexOf("--comment");
    const comment =
      idx !== -1 && idx + 1 < args.length && typeof args[idx + 1] === "string" && !args[idx + 1].startsWith("--")
        ? args[idx + 1]
        : undefined;
    if (comment !== undefined) {
      process.stdout.write("comment=" + comment + "\n");
    }
  }
  process.stdout.write(args.slice(0, 3).join(" ") + "\n");
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(1);
`
    );

    await writeExecutable(
        path.join(binDir, "git"),
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") === "rev-parse --show-toplevel") {
  if (process.env.FAKE_GIT_ROOT) {
    process.stdout.write(process.env.FAKE_GIT_ROOT + "\n");
    process.exit(0);
  }
  process.stdout.write((process.env.MIRA_DASHBOARD_ROOT || "/home/ubuntu/projects/mira-dashboard") + "\n");
  process.exit(0);
}
if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
  process.stdout.write((process.env.FAKE_GIT_BRANCH || "main") + "\n");
  process.exit(0);
}
if (args.join(" ") === "rev-parse --short HEAD") {
  process.stdout.write("abc1234\n");
  process.exit(0);
}
if (args.join(" ") === "status --short") {
  if (process.env.FAKE_GIT_DIRTY_PRODUCTION === "1") {
    process.stdout.write(" M package.json\n");
  }
  process.exit(0);
}
if (args.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
  if (process.env.FAKE_GIT_NO_UPSTREAM === "1") {
    process.stderr.write("no upstream\n");
    process.exit(1);
  }
  if (process.env.FAKE_GIT_EMPTY_UPSTREAM === "1") {
    process.stdout.write("\n");
    process.exit(0);
  }
  process.stdout.write("origin/main\n");
  process.exit(0);
}
if (args.join(" ") === "worktree list --porcelain") {
  if (process.env.FAKE_GIT_WORKTREE_LIST === "empty") {
    process.exit(0);
  }
  if (process.env.FAKE_GIT_WORKTREE_LIST === "outside") {
    process.stdout.write("worktree /tmp/outside-worktree\nHEAD deadbeef\nbranch refs/heads/add-playwright-smoke-tests\n\n");
    process.exit(0);
  }
  if (process.env.FAKE_GIT_WORKTREE_LIST === "short-branch") {
    process.stdout.write("worktree " + process.env.MIRA_DASHBOARD_WORKTREE_ROOT + "/add-playwright-smoke-tests\nHEAD deadbeef\nbranch add-playwright-smoke-tests\n\n");
    process.exit(0);
  }
  process.stdout.write("worktree " + process.env.MIRA_DASHBOARD_WORKTREE_ROOT + "/add-playwright-smoke-tests\nHEAD deadbeef\nbranch refs/heads/add-playwright-smoke-tests\n\n");
  process.exit(0);
}
if (args[0] === "-C" && args[2] === "status" && args[3] === "--short") {
  if (process.env.FAKE_GIT_DIRTY_WORKTREE === "1") {
    process.stdout.write(" M src/App.tsx\n");
  }
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "remove") {
  if (process.env.FAKE_GIT_REMOVE_FAIL === "1") {
    process.stderr.write("remove failed");
    process.exit(3);
  }
  process.stdout.write("removed " + args[2] + "\n");
  process.exit(0);
}
if (["fetch", "checkout", "pull"].includes(args[0])) {
  if (args[0] === "pull" && process.env.FAKE_GIT_PULL_FAIL === "1") {
    process.stderr.write("pull failed");
    process.exit(2);
  }
  process.stdout.write(args.join(" ") + "\n");
  process.exit(0);
}
process.stderr.write("unexpected git args: " + args.join(" "));
process.exit(1);
`
    );

    await writeExecutable(
        path.join(binDir, "npm"),
        String.raw`#!${process.execPath}
process.stdout.write("npm " + process.argv.slice(2).join(" ") + "\n");
`
    );

    await writeExecutable(
        path.join(binDir, "systemd-run"),
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const script = args.at(-1) || "";
if (!args.includes("--user") || !script.includes("systemctl --user restart mira-dashboard.service")) {
  process.stderr.write("deploy restart should use user systemd service");
  process.exit(1);
}
process.stdout.write("systemd-run " + args.join(" ") + "\n");
`
    );

    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(tempDir: string): Promise<TestServer> {
    const previousCwd = process.cwd();
    const previousDashboardRoot = process.env.MIRA_DASHBOARD_ROOT;
    const previousWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
    const previousDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    process.chdir(tempDir);
    process.env.MIRA_DASHBOARD_ROOT = tempDir;
    process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(tempDir, "worktrees");
    process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "data", "mira-dashboard.db");
    let server: http.Server | undefined;
    try {
        const { default: pullRequestsRoutes } = await import(
            `./pullRequests.js?test=${randomUUID()}`
        );
        const app = express();
        app.use(express.json());
        pullRequestsRoutes(app);
        server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            const onListening = () => {
                server?.off("error", onError);
                resolve();
            };
            const onError = (error: Error) => {
                server?.off("listening", onListening);
                process.chdir(previousCwd);
                if (previousDashboardRoot === undefined) {
                    delete process.env.MIRA_DASHBOARD_ROOT;
                } else {
                    process.env.MIRA_DASHBOARD_ROOT = previousDashboardRoot;
                }
                if (previousWorktreeRoot === undefined) {
                    delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
                } else {
                    process.env.MIRA_DASHBOARD_WORKTREE_ROOT = previousWorktreeRoot;
                }
                if (previousDbPath === undefined) {
                    delete process.env.MIRA_DASHBOARD_DB_PATH;
                } else {
                    process.env.MIRA_DASHBOARD_DB_PATH = previousDbPath;
                }
                reject(error);
            };
            server?.once("listening", onListening);
            server?.once("error", onError);
            server?.listen(0);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () => new Promise((resolve) => server?.close(() => resolve())),
        };
    } catch (error) {
        if (server?.listening) {
            await new Promise((resolve) => server?.close(() => resolve(null)));
        }
        process.chdir(previousCwd);
        if (previousDashboardRoot === undefined) {
            delete process.env.MIRA_DASHBOARD_ROOT;
        } else {
            process.env.MIRA_DASHBOARD_ROOT = previousDashboardRoot;
        }
        if (previousWorktreeRoot === undefined) {
            delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
        } else {
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = previousWorktreeRoot;
        }
        if (previousDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = previousDbPath;
        }
        throw error;
    }
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("pull request routes", () => {
    let server = undefined as unknown as TestServer;
    let tempDir = "";

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-pull-requests-"));
        process.env.FAKE_GH_REVIEW_STATE_FILE = path.join(tempDir, "review-state");
        await installFakeCommands(tempDir);
        process.env.RAJOHAN_GITHUB_TOKEN = "rajohan-review-token";
        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        server = await startServer(tempDir);
        const { __testing } = await import(`./pullRequests.js?seed=${randomUUID()}`);
        __testing.writeDeploymentJob({
            id: "job-1",
            status: "ok",
            startedAt: "2026-05-11T00:00:00.000Z",
            updatedAt: "2026-05-11T00:01:00.000Z",
            commit: "abc1234",
        });
        __testing.writeDeploymentJob({
            id: "job-without-commit",
            status: "ok",
            startedAt: "2026-05-11T00:02:00.000Z",
            updatedAt: "2026-05-11T00:03:00.000Z",
        });
    });

    after(async () => {
        await server?.close();
        process.chdir(originalCwd);
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        if (originalDashboardRoot === undefined) {
            delete process.env.MIRA_DASHBOARD_ROOT;
        } else {
            process.env.MIRA_DASHBOARD_ROOT = originalDashboardRoot;
        }
        if (originalWorktreeRoot === undefined) {
            delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
        } else {
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = originalWorktreeRoot;
        }
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        if (originalRajohanToken === undefined) {
            delete process.env.RAJOHAN_GITHUB_TOKEN;
        } else {
            process.env.RAJOHAN_GITHUB_TOKEN = originalRajohanToken;
        }
        if (originalFakeReviewStateFile === undefined) {
            delete process.env.FAKE_GH_REVIEW_STATE_FILE;
        } else {
            process.env.FAKE_GH_REVIEW_STATE_FILE = originalFakeReviewStateFile;
        }
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("lists open main-targeted pull requests from GitHub", async () => {
        const response = await requestJson<{
            pullRequests: Array<{
                number: number;
                title: string;
                author: { login: string };
            }>;
        }>(server, "/api/pull-requests");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.pullRequests, [
            {
                number: 11,
                title: "Raise frontend coverage",
                body: "Coverage follow-up",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/11",
                headRefName: "chore/coverage-to-100-followup",
                baseRefName: "main",
                author: { login: "rajohan" },
                createdAt: "2026-05-10T01:00:00Z",
                updatedAt: "2026-05-12T00:00:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 20,
                deletions: 5,
                changedFiles: 3,
            },
            {
                number: 14,
                title: "Wait for protected deployment",
                body: "GitHub still reports a protected branch blocker",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/14",
                headRefName: "protected-deployment",
                baseRefName: "main",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T01:30:00Z",
                updatedAt: "2026-05-11T12:00:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "BLOCKED",
                reviewDecision: "APPROVED",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 3,
                deletions: 1,
                changedFiles: 1,
            },
            {
                number: 16,
                title: "Fresh dirty blocker",
                body: "Fresh lookup still reports a dirty branch blocker",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/16",
                headRefName: "refresh-dirty-blocker",
                baseRefName: "main",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T01:50:00Z",
                updatedAt: "2026-05-11T06:30:00Z",
                isDraft: false,
                mergeable: "DIRTY",
                mergeStateStatus: "BLOCKED",
                reviewDecision: "APPROVED",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 4,
                deletions: 2,
                changedFiles: 2,
            },
            {
                number: 17,
                title: "Approved latest review is mergeable",
                body: "Review decision has not caught up yet",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/17",
                headRefName: "reviewer-approved-refresh",
                baseRefName: "main",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T01:55:00Z",
                updatedAt: "2026-05-11T06:15:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 5,
                deletions: 2,
                changedFiles: 2,
            },
            {
                number: 15,
                title: "Refresh lookup fails",
                body: "Keep the original list state if the fresh lookup fails",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/15",
                headRefName: "refresh-fails",
                baseRefName: "main",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T01:45:00Z",
                updatedAt: "2026-05-11T06:00:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "BLOCKED",
                reviewDecision: "APPROVED",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 2,
                deletions: 0,
                changedFiles: 1,
            },
            {
                number: 10,
                title: "Add Playwright smoke tests",
                body: "Coverage batch",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
                headRefName: "add-playwright-smoke-tests",
                baseRefName: "main",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T00:00:00Z",
                updatedAt: "2026-05-11T00:00:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                reviewerApproved: true,
                reviewerCanApprove: false,
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                additions: 12,
                deletions: 3,
                changedFiles: 4,
            },
        ]);
    });

    it("returns recent deployment jobs from the dashboard database", async () => {
        const response = await requestJson<{
            deployments: Array<{
                id: string;
                status: string;
                commit: string;
                commitUrl: string;
            }>;
        }>(server, "/api/pull-requests/deployments");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.deployments, [
            {
                id: "job-without-commit",
                status: "ok",
                startedAt: "2026-05-11T00:02:00.000Z",
                updatedAt: "2026-05-11T00:03:00.000Z",
            },
            {
                id: "job-1",
                status: "ok",
                startedAt: "2026-05-11T00:00:00.000Z",
                updatedAt: "2026-05-11T00:01:00.000Z",
                commit: "abc1234",
                commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/abc1234",
            },
        ]);
    });

    it("reports production checkout safety state", async () => {
        const response = await requestJson<{
            checkout: {
                root: string;
                branch: string;
                head: string;
                upstream: string;
                isClean: boolean;
                isProductionRoot: boolean;
                isSafeForDeploy: boolean;
            };
        }>(server, "/api/pull-requests/production-checkout");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.checkout, {
            root: tempDir,
            expectedRoot: tempDir,
            worktreeRoot: path.join(tempDir, "worktrees"),
            branch: "main",
            expectedBranch: "main",
            head: "abc1234",
            upstream: "origin/main",
            isClean: true,
            isProductionRoot: true,
            isSafeForDeploy: true,
        });
    });

    it("covers pull request route helper edge cases", async () => {
        const { __testing } = await import(`./pullRequests.js?helpers=${randomUUID()}`);

        assert.deepEqual(__testing.parseRepoParts("owner/repo"), {
            owner: "owner",
            name: "repo",
        });
        assert.throws(() => __testing.parseRepoParts("owner/repo/extra"), {
            message: "Dashboard repository must be configured as owner/name",
        });
        assert.throws(() => __testing.parseRepoParts("missing-slash"), {
            message: "Dashboard repository must be configured as owner/name",
        });
        assert.throws(() => __testing.parseRepoParts("/repo"), {
            message: "Dashboard repository must be configured as owner/name",
        });
        assert.throws(() => __testing.parseRepoParts("owner/"), {
            message: "Dashboard repository must be configured as owner/name",
        });
        const parsedRows: Array<{ ok: number }> = [];
        __testing.parseGhJsonLine("", parsedRows);
        __testing.parseGhJsonLine("   ", parsedRows);
        __testing.parseGhJsonLine('{"ok":1}', parsedRows);
        assert.deepEqual(parsedRows, [{ ok: 1 }]);
        assert.throws(
            () => __testing.parseGhJsonLine("x".repeat(1024 * 1024 + 1), parsedRows),
            /too large/u
        );
        const clearCalls: NodeJS.Timeout[] = [];
        const forceTimer = setTimeout(() => {}, 10_000);
        forceTimer.unref();
        assert.equal(
            __testing.clearForceKillTimerIfAllowed(
                forceTimer,
                {},
                false,
                (timer: NodeJS.Timeout) => clearCalls.push(timer)
            ),
            null
        );
        assert.deepEqual(clearCalls, [forceTimer]);
        assert.equal(
            __testing.clearForceKillTimerIfAllowed(forceTimer, {}, true),
            forceTimer
        );
        assert.equal(
            __testing.clearForceKillTimerIfAllowed(
                forceTimer,
                { keepForceKillTimer: true },
                false
            ),
            forceTimer
        );
        assert.equal(__testing.clearForceKillTimerIfAllowed(null, {}, false), null);
        clearTimeout(forceTimer);
        assert.deepEqual(
            __testing.parseGitWorktrees(
                [
                    "worktree /tmp/root",
                    "HEAD abc",
                    "branch refs/heads/main",
                    "",
                    "worktree /tmp/detached",
                    "HEAD def",
                    "",
                ].join("\n")
            ),
            [
                { path: "/tmp/root", head: "abc", branch: "refs/heads/main" },
                { path: "/tmp/detached", head: "def" },
            ]
        );
        assert.equal(__testing.isPathInsideRoot("/tmp/root/child", "/tmp/root"), true);
        assert.equal(__testing.isPathInsideRoot("/tmp/root", "/tmp/root"), false);
        assert.equal(__testing.isPathInsideRoot("/tmp/other", "/tmp/root"), false);
        assert.equal(__testing.validatePrNumber("10"), 10);
        assert.throws(() => __testing.validatePrNumber("0"), {
            message: "Invalid pull request number",
        });
        assert.throws(() => __testing.validatePrNumber("1.5"), {
            message: "Invalid pull request number",
        });
        assert.throws(() => __testing.validatePrNumber("1e2"), {
            message: "Invalid pull request number",
        });
        assert.throws(() => __testing.validatePrNumber("0x10"), {
            message: "Invalid pull request number",
        });
        assert.throws(() => __testing.validatePrNumber(10), {
            message: "Invalid pull request number",
        });
        assert.throws(
            () =>
                __testing.validateMiraPr({
                    author: { login: "rajohan" },
                    baseRefName: "main",
                    isDraft: false,
                } as never),
            { message: "Only Mira-authored pull requests can be managed here" }
        );
        assert.doesNotThrow(() =>
            __testing.validateDashboardPr({
                author: { login: "rajohan" },
                baseRefName: "main",
                isDraft: false,
                statusCheckRollup: [{ status: "PENDING", name: "ci" }],
            } as never)
        );
        assert.throws(
            () =>
                __testing.validateMiraPr({
                    author: { login: "mira-2026" },
                    baseRefName: "release",
                    isDraft: false,
                } as never),
            { message: "Only main-targeted pull requests can be managed here" }
        );
        assert.throws(
            () =>
                __testing.validateMiraPr({
                    author: { login: "mira-2026" },
                    baseRefName: "main",
                    isDraft: true,
                } as never),
            { message: "Draft pull requests cannot be approved from the dashboard" }
        );
        assert.doesNotThrow(() =>
            __testing.validateMiraPr({
                author: { login: "mira-2026" },
                baseRefName: "main",
                isDraft: false,
                statusCheckRollup: [{ status: "PENDING", name: "ci" }],
            } as never)
        );
        assert.doesNotThrow(() =>
            __testing.validateDashboardPrForApproval({
                author: { login: "rajohan" },
                baseRefName: "main",
                isDraft: false,
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            } as never)
        );
        assert.doesNotThrow(() =>
            __testing.validateMiraPrForApproval({
                author: { login: "mira-2026" },
                baseRefName: "main",
                isDraft: false,
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            } as never)
        );
        assert.doesNotThrow(() =>
            __testing.validateMiraPrForApproval({
                author: { login: "mira-2026" },
                baseRefName: "main",
                isDraft: false,
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ name: "ci", state: "SUCCESS" }],
            } as never)
        );
        assert.throws(
            () =>
                __testing.validateDashboardPrForApproval({
                    author: { login: "dependabot[bot]" },
                    baseRefName: "main",
                    isDraft: false,
                    reviewDecision: "REVIEW_REQUIRED",
                    statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                } as never),
            { message: "Pull request review approval is required before merging" }
        );
        assert.doesNotThrow(() =>
            __testing.validateDashboardPrForReviewApproval({
                author: { login: "mira-2026" },
                baseRefName: "main",
                isDraft: false,
                reviewDecision: "REVIEW_REQUIRED",
            } as never)
        );
        assert.throws(
            () =>
                __testing.validateDashboardPrForReviewApproval({
                    author: { login: "rajohan" },
                    baseRefName: "main",
                    isDraft: false,
                    reviewDecision: "REVIEW_REQUIRED",
                } as never),
            { message: "Rajohan cannot approve his own pull request" }
        );
        assert.throws(
            () =>
                __testing.validateDashboardPrForReviewApproval({
                    author: { login: "mira-2026" },
                    baseRefName: "main",
                    isDraft: false,
                    reviewDecision: "APPROVED",
                } as never),
            { message: "Pull request is already approved" }
        );
        assert.doesNotThrow(() =>
            __testing.validateDashboardPrForReviewApproval({
                author: { login: "mira-2026" },
                baseRefName: "main",
                isDraft: false,
                reviews: [
                    {
                        author: { login: "rajohan" },
                        state: "APPROVED",
                        submittedAt: "2026-06-03T15:51:12Z",
                    },
                    {
                        author: { login: "rajohan" },
                        submittedAt: "2026-06-03T16:00:00Z",
                    },
                    {
                        state: "APPROVED",
                        submittedAt: "2026-06-03T16:05:00Z",
                    },
                    {
                        author: { login: "rajohan" },
                        state: "DISMISSED",
                        submittedAt: "2026-06-03T16:13:20Z",
                    },
                ],
            } as never)
        );
        assert.throws(
            () =>
                __testing.validateDashboardPrForReviewApproval({
                    author: { login: "mira-2026" },
                    baseRefName: "main",
                    isDraft: false,
                    reviews: [
                        {
                            author: { login: "rajohan" },
                            state: "APPROVED",
                            submittedAt: "2026-06-03T15:51:12Z",
                        },
                        {
                            author: { login: "rajohan" },
                            state: "COMMENTED",
                            submittedAt: "2026-06-03T16:13:20Z",
                        },
                    ],
                } as never),
            { message: "Pull request is already approved" }
        );
        const restoreReviewerEnv = saveEnv(["RAJOHAN_GITHUB_USERNAME"]);
        try {
            process.env.RAJOHAN_GITHUB_USERNAME = "   ";
            assert.throws(
                () =>
                    __testing.validateDashboardPrForReviewApproval({
                        author: { login: "rajohan" },
                        baseRefName: "main",
                        isDraft: false,
                    } as never),
                { message: "Rajohan cannot approve his own pull request" }
            );

            process.env.RAJOHAN_GITHUB_USERNAME = "custom-reviewer";
            assert.throws(
                () =>
                    __testing.validateDashboardPrForReviewApproval({
                        author: { login: "mira-2026" },
                        baseRefName: "main",
                        isDraft: false,
                        latestOpinionatedReviews: {
                            nodes: [
                                {
                                    author: { login: "custom-reviewer" },
                                    state: "APPROVED",
                                },
                                {
                                    author: { login: "custom-reviewer" },
                                    state: "DISMISSED",
                                },
                            ],
                        },
                    } as never),
                { message: "Pull request is already approved" }
            );
        } finally {
            restoreReviewerEnv();
        }
        assert.throws(
            () =>
                __testing.validateMiraPrForApproval({
                    author: { login: "mira-2026" },
                    baseRefName: "main",
                    isDraft: false,
                    statusCheckRollup: [{ status: "PENDING", name: "ci" }],
                } as never),
            { message: "Pull request CI checks must pass before approval" }
        );
        assert.throws(
            () =>
                __testing.validateMiraPrForApproval({
                    author: { login: "mira-2026" },
                    baseRefName: "main",
                    isDraft: false,
                } as never),
            { message: "Pull request CI checks must pass before approval" }
        );
        assert.equal(__testing.shellQuote("can't"), String.raw`'can'\''t'`);
        assert.ok(
            __testing
                .deploymentJobUpdateCommand({
                    id: "path-check",
                    status: "ok",
                    startedAt: "2026-06-03T19:41:52.233Z",
                    updatedAt: "2026-06-03T19:41:52.233Z",
                })
                .includes(`MIRA_DEPLOYMENT_DB='${process.env.MIRA_DASHBOARD_DB_PATH}'`)
        );
        assert.match(
            __testing.deploymentJobUpdateCommand({
                id: "busy-timeout-check",
                status: "ok",
                startedAt: "2026-06-03T19:41:52.233Z",
                updatedAt: "2026-06-03T19:41:52.233Z",
            }),
            /PRAGMA busy_timeout = 5000/
        );
        assert.match(
            __testing.deploymentJobUpdateCommand({
                id: "transaction-check",
                status: "ok",
                startedAt: "2026-06-03T19:41:52.233Z",
                updatedAt: "2026-06-03T19:41:52.233Z",
            }),
            /BEGIN IMMEDIATE[\s\S]*DELETE FROM deployment_lock[\s\S]*COMMIT[\s\S]*ROLLBACK/
        );
        assert.equal(__testing.trimOutput("x".repeat(20_010)).length, 20_000);
    });

    it("covers deployment lock lifecycle helper edge cases", async () => {
        const { __testing } = await import(`./pullRequests.js?locks=${randomUUID()}`);
        const { db: deploymentDb } = await import("../db.js");
        const freshTimestamp = new Date().toISOString();
        clearDeploymentState(tempDir);

        try {
            assert.equal(__testing.readDeploymentJob("broken"), undefined);

            __testing.writeDeploymentJob({
                id: "finished",
                status: "ok",
                startedAt: "2026-06-03T19:41:52.233Z",
                updatedAt: "2026-06-03T19:41:52.233Z",
                note: "done",
            });
            __testing.acquireDeploymentLock("finished");
            __testing.acquireDeploymentLock("next");
            assert.equal(__testing.readDeploymentLock(), "next");

            __testing.releaseDeploymentLock("other");
            assert.equal(__testing.readDeploymentLock(), "next");
            __testing.releaseDeploymentLock("next");
            assert.equal(__testing.readDeploymentLock(), undefined);

            __testing.writeDeploymentJob({
                id: "active",
                status: "restart-scheduled",
                startedAt: freshTimestamp,
                updatedAt: freshTimestamp,
                note: "restart pending",
            });
            __testing.acquireDeploymentLock("active");
            assert.throws(() => __testing.acquireDeploymentLock("blocked"), {
                message: "Dashboard deploy already in progress (active)",
            });
            __testing.releaseDeploymentLock("active");

            const staleJob = {
                id: "stale",
                status: "building",
                startedAt: "2000-01-01T00:00:00.000Z",
                updatedAt: "2000-01-01T00:00:00.000Z",
                note: "stale deploy",
            };
            assert.equal(__testing.isDeploymentJobStale(staleJob), true);
            assert.equal(
                __testing.isDeploymentJobStale({
                    ...staleJob,
                    updatedAt: "",
                }),
                true
            );
            assert.equal(
                __testing.isDeploymentJobStale({
                    ...staleJob,
                    startedAt: "not-a-date",
                    updatedAt: "also-not-a-date",
                }),
                true
            );
            __testing.writeDeploymentJob(staleJob);
            __testing.acquireDeploymentLock(staleJob.id);
            __testing.acquireDeploymentLock("after-stale");
            assert.equal(__testing.readDeploymentLock(), "after-stale");
            __testing.releaseDeploymentLock("after-stale");

            __testing.releaseDeploymentLock("missing");

            const realPrepare = deploymentDb.prepare.bind(deploymentDb);
            const releasePrepareMock = mock.method(
                deploymentDb,
                "prepare",
                (sql: string) => {
                    if (sql.includes("DELETE FROM deployment_lock WHERE id = 1")) {
                        throw new Error("release unavailable");
                    }
                    return realPrepare(sql);
                }
            );
            try {
                assert.doesNotThrow(() => __testing.releaseDeploymentLock("missing"));
            } finally {
                releasePrepareMock.mock.restore();
            }

            const constraintPrepareMock = mock.method(
                deploymentDb,
                "prepare",
                (sql: string) => {
                    if (sql.includes("INSERT INTO deployment_lock")) {
                        return {
                            run: () => {
                                throw new Error("constraint failed");
                            },
                        };
                    }
                    return realPrepare(sql);
                }
            );
            try {
                assert.throws(() => __testing.acquireDeploymentLock("raced"), {
                    message: "Dashboard deploy already in progress",
                });
            } finally {
                constraintPrepareMock.mock.restore();
            }

            const failedLockPrepareMock = mock.method(
                deploymentDb,
                "prepare",
                (sql: string) => {
                    if (sql.includes("INSERT INTO deployment_lock")) {
                        return {
                            run: () => {
                                throw new Error("lock write unavailable");
                            },
                        };
                    }
                    return realPrepare(sql);
                }
            );
            try {
                assert.throws(() => __testing.acquireDeploymentLock("failed-lock"), {
                    message: "lock write unavailable",
                });
            } finally {
                failedLockPrepareMock.mock.restore();
            }

            withDeploymentDb(tempDir, (deploymentDb) => {
                deploymentDb
                    .prepare(
                        "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
                    )
                    .run("missing-active", freshTimestamp);
            });
            assert.throws(() => __testing.acquireDeploymentLock("missing-blocked"), {
                message: "Dashboard deploy already in progress (missing-active)",
            });
            __testing.releaseDeploymentLock("missing-active");

            withDeploymentDb(tempDir, (deploymentDb) => {
                deploymentDb
                    .prepare(
                        "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
                    )
                    .run("stale-missing-active", "2000-01-01T00:00:00.000Z");
            });
            __testing.acquireDeploymentLock("after-orphan-stale");
            assert.equal(__testing.readDeploymentLock(), "after-orphan-stale");
            __testing.releaseDeploymentLock("after-orphan-stale");

            withDeploymentDb(tempDir, (deploymentDb) => {
                deploymentDb
                    .prepare(
                        "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
                    )
                    .run("malformed-missing-active", "not-a-date");
            });
            __testing.acquireDeploymentLock("after-malformed-orphan");
            assert.equal(__testing.readDeploymentLock(), "after-malformed-orphan");
            __testing.releaseDeploymentLock("after-malformed-orphan");

            const job = {
                id: "background-failed",
                status: "building",
                startedAt: "2026-06-03T19:41:52.233Z",
                updatedAt: "2026-06-03T19:41:52.233Z",
                note: "Deploy started",
            };
            __testing.writeDeploymentJob(job);
            __testing.acquireDeploymentLock(job.id);
            const restoreGitEnv = saveEnv(["FAKE_GIT_PULL_FAIL"]);
            process.env.FAKE_GIT_PULL_FAIL = "1";
            try {
                await __testing.runDeploymentJob(job);
            } finally {
                restoreGitEnv();
            }
            const failedJob = __testing.readDeploymentJob(job.id) as {
                status: string;
                note: string;
            };
            assert.equal(failedJob.status, "failed");
            assert.match(failedJob.note, /pull failed/u);
            assert.equal(__testing.readDeploymentLock(), undefined);

            const startJob = __testing.startDeployLatest();
            assert.equal(startJob.status, "building");
            assert.equal(__testing.readDeploymentLock(), startJob.id);
            await waitForDeploymentStatus(startJob.id, "restart-scheduled", tempDir);
            __testing.releaseDeploymentLock(startJob.id);

            const failedJobWriteMock = mock.method(
                deploymentDb,
                "prepare",
                (sql: string) => {
                    if (sql.includes("INSERT INTO deployment_jobs")) {
                        throw new Error("job write failed");
                    }
                    return realPrepare(sql);
                }
            );
            try {
                assert.throws(() => __testing.startDeployLatest(), {
                    message: "job write failed",
                });
                assert.equal(__testing.readDeploymentLock(), undefined);
            } finally {
                failedJobWriteMock.mock.restore();
            }

            assert.throws(() => __testing.startDeployLatest("missing-lock"), {
                message: "Dashboard deploy lock handoff failed",
            });
            assert.equal(__testing.readDeploymentLock(), undefined);

            const originalConsoleError = console.error;
            const backgroundErrors: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                backgroundErrors.push(args);
            };
            try {
                __testing.reportBackgroundDeploymentError(
                    new Error("floating deploy failed")
                );
            } finally {
                console.error = originalConsoleError;
            }
            assert.deepEqual(backgroundErrors, [
                [
                    "[pullRequestsRoutes] Background deploy failed:",
                    "floating deploy failed",
                ],
            ]);

            for (let index = 0; index < 52; index += 1) {
                __testing.writeDeploymentJob({
                    id: `history-${index}`,
                    status: "ok",
                    startedAt: `2026-06-03T19:41:${String(index).padStart(2, "0")}.233Z`,
                    updatedAt: `2026-06-03T19:41:${String(index).padStart(2, "0")}.233Z`,
                    note: "done",
                });
            }
            const response = await requestJson<{ deployments: unknown[] }>(
                server,
                "/api/pull-requests/deployments"
            );
            assert.equal(response.body.deployments.length, 10);
        } finally {
            mock.restoreAll();
            clearDeploymentState(tempDir);
        }
    });

    it("covers GitHub JSON-lines parser edge cases", async () => {
        const { __testing } = await import(
            `./pullRequests.js?json-lines=${randomUUID()}`
        );
        const originalScenario = process.env.FAKE_GH_JSON_LINES;
        try {
            process.env.FAKE_GH_JSON_LINES = "partial";
            assert.deepEqual(await __testing.runGhJsonLines(["api", "graphql"]), [
                { ok: 1 },
                { ok: 2 },
            ]);

            process.env.FAKE_GH_JSON_LINES = "invalid";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                SyntaxError
            );

            process.env.FAKE_GH_JSON_LINES = "nonzero";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /gh failed/u
            );

            process.env.FAKE_GH_JSON_LINES = "nonzero-no-stderr";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /GitHub CLI exited with code 2/u
            );

            process.env.FAKE_GH_JSON_LINES = "long-buffer";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /too large|Unexpected token/u
            );

            process.env.FAKE_GH_JSON_LINES = "long-line";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /too large|Unexpected token/u
            );

            process.env.FAKE_GH_JSON_LINES = "long-complete-line";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /too large|Unexpected token/u
            );

            process.env.FAKE_GH_JSON_LINES = "long-complete-line-with-prefix";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                /too large|Unexpected token/u
            );

            process.env.FAKE_GH_JSON_LINES = "invalid-final";
            await assert.rejects(
                () => __testing.runGhJsonLines(["api", "graphql"]),
                SyntaxError
            );

            assert.throws(
                () =>
                    __testing.parseGhJsonLine(
                        {
                            trim: () => "partial",
                            length: 7,
                            toString: () => {
                                throw "non-error parse failure";
                            },
                        } as unknown as string,
                        []
                    ),
                (error) => error === "non-error parse failure"
            );
            assert.match(
                __testing.toGhJsonParseError("non-error parse failure").message,
                /Failed to parse GitHub CLI output/u
            );

            process.env.FAKE_GH_JSON_LINES = "timeout";
            const timeoutReadyFile = path.join(tempDir, "gh-timeout-ready");
            const timeoutExitFile = path.join(tempDir, "gh-timeout-exit");
            const previousReadyFile = process.env.FAKE_GH_READY_FILE;
            const previousExitFile = process.env.FAKE_GH_EXIT_FILE;
            process.env.FAKE_GH_READY_FILE = timeoutReadyFile;
            process.env.FAKE_GH_EXIT_FILE = timeoutExitFile;
            try {
                const timeoutPromise = __testing.runGhJsonLines(["api", "graphql"], {
                    timeoutMs: 1_000,
                });
                await waitForFile(timeoutReadyFile);
                await assert.rejects(() => timeoutPromise, /timed out/u);
                await waitForFile(timeoutExitFile);
            } finally {
                if (previousReadyFile === undefined) {
                    delete process.env.FAKE_GH_READY_FILE;
                } else {
                    process.env.FAKE_GH_READY_FILE = previousReadyFile;
                }
                if (previousExitFile === undefined) {
                    delete process.env.FAKE_GH_EXIT_FILE;
                } else {
                    process.env.FAKE_GH_EXIT_FILE = previousExitFile;
                }
            }

            const originalPathForSpawnError = process.env.PATH;
            process.env.PATH = tempDir;
            try {
                delete process.env.FAKE_GH_JSON_LINES;
                await assert.rejects(
                    () => __testing.runGhJsonLines(["api", "graphql"]),
                    /ENOENT/u
                );
            } finally {
                if (originalPathForSpawnError === undefined) {
                    delete process.env.PATH;
                } else {
                    process.env.PATH = originalPathForSpawnError;
                }
            }
            delete process.env.FAKE_GH_JSON_LINES;
        } finally {
            if (originalScenario === undefined) {
                delete process.env.FAKE_GH_JSON_LINES;
            } else {
                process.env.FAKE_GH_JSON_LINES = originalScenario;
            }
        }
    });

    it("covers command environment and JSON command helper edge cases", async () => {
        const { __testing } = await import(`./pullRequests.js?command=${randomUUID()}`);
        const originalDashboardRoot = process.env.MIRA_DASHBOARD_ROOT;
        const originalDashboardWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
        const originalMiraToken = process.env.MIRA_GITHUB_TOKEN;
        const originalMiraBackupToken = process.env.MIRA_GITHUB_TOKEN_BACKUP;
        const originalRajohanToken = process.env.RAJOHAN_GITHUB_TOKEN;
        const originalRajohanBackupToken = process.env.RAJOHAN_GITHUB_TOKEN_BACKUP;
        const originalGhToken = process.env.GH_TOKEN;
        try {
            process.env.MIRA_DASHBOARD_ROOT = "";
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = "";
            const moduleWithDefaultRoots = await import(
                `./pullRequests.js?roots=${randomUUID()}`
            );
            assert.equal(typeof moduleWithDefaultRoots.default, "function");
            assert.deepEqual(moduleWithDefaultRoots.__testing.getResolvedRoots(), {
                dashboardRoot: "/home/ubuntu/projects/mira-dashboard",
                dashboardWorktreeRoot: "/home/ubuntu/projects/mira-dashboard-worktrees",
            });

            delete process.env.MIRA_GITHUB_TOKEN;
            delete process.env.GH_TOKEN;
            delete process.env.GITHUB_TOKEN;
            assert.equal(__testing.buildCommandEnv().GITHUB_TOKEN, undefined);

            process.env.GH_TOKEN = "gh-token";
            assert.equal(__testing.buildCommandEnv().GH_TOKEN, "gh-token");
            assert.equal(__testing.buildCommandEnv().GITHUB_TOKEN, undefined);

            process.env.MIRA_GITHUB_TOKEN = "";
            assert.equal(__testing.buildCommandEnv().GH_TOKEN, "gh-token");
            assert.equal(__testing.buildCommandEnv().GITHUB_TOKEN, undefined);

            process.env.GH_TOKEN = "   ";
            process.env.GITHUB_TOKEN = "stale-token";
            assert.equal(__testing.buildCommandEnv().GH_TOKEN, "stale-token");
            assert.equal(__testing.buildCommandEnv().GITHUB_TOKEN, undefined);

            process.env.MIRA_GITHUB_TOKEN = "mira-token";
            process.env.MIRA_GITHUB_TOKEN_BACKUP = "backup-token";
            process.env.RAJOHAN_GITHUB_TOKEN = "rajohan-token";
            process.env.RAJOHAN_GITHUB_TOKEN_BACKUP = "rajohan-backup-token";
            const miraEnv = __testing.buildCommandEnv();
            assert.equal(miraEnv.GH_TOKEN, "mira-token");
            assert.equal(miraEnv.GITHUB_TOKEN, undefined);
            assert.equal(miraEnv.MIRA_GITHUB_TOKEN, undefined);
            assert.equal(miraEnv.MIRA_GITHUB_TOKEN_BACKUP, undefined);
            assert.equal(miraEnv.RAJOHAN_GITHUB_TOKEN, undefined);
            assert.equal(miraEnv.RAJOHAN_GITHUB_TOKEN_BACKUP, undefined);

            const reviewEnv = __testing.buildReviewCommandEnv();
            assert.equal(reviewEnv.GH_TOKEN, "rajohan-token");
            assert.equal(reviewEnv.GITHUB_TOKEN, undefined);
            assert.equal(reviewEnv.MIRA_GITHUB_TOKEN, undefined);
            assert.equal(reviewEnv.RAJOHAN_GITHUB_TOKEN, undefined);

            delete process.env.RAJOHAN_GITHUB_TOKEN;
            assert.throws(() => __testing.buildReviewCommandEnv(), {
                message: "Rajohan GitHub review token is not configured",
            });
            process.env.RAJOHAN_GITHUB_TOKEN = "rajohan-token";

            const pullRequest = await __testing.runGhJson([
                "pr",
                "view",
                "10",
                "--json",
                "number,reviews,mergeStateStatus",
            ]);
            assert.equal(pullRequest.number, 10);

            const oldFakeGhJsonLines = process.env.FAKE_GH_JSON_LINES;
            try {
                process.env.FAKE_GH_JSON_LINES = "empty-json";
                assert.equal(
                    await __testing.runGhJson([
                        "pr",
                        "view",
                        "10",
                        "--json",
                        "number,reviews,mergeStateStatus",
                    ]),
                    null
                );
            } finally {
                if (oldFakeGhJsonLines === undefined) {
                    delete process.env.FAKE_GH_JSON_LINES;
                } else {
                    process.env.FAKE_GH_JSON_LINES = oldFakeGhJsonLines;
                }
            }

            const command = await __testing.runCommand("git", [
                "rev-parse",
                "--short",
                "HEAD",
            ]);
            assert.equal(command.stdout, "abc1234\n");
            assert.equal(command.stderr, "");
        } finally {
            if (originalDashboardRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_ROOT = originalDashboardRoot;
            }
            if (originalDashboardWorktreeRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_WORKTREE_ROOT = originalDashboardWorktreeRoot;
            }
            if (originalMiraToken === undefined) {
                delete process.env.MIRA_GITHUB_TOKEN;
            } else {
                process.env.MIRA_GITHUB_TOKEN = originalMiraToken;
            }
            if (originalMiraBackupToken === undefined) {
                delete process.env.MIRA_GITHUB_TOKEN_BACKUP;
            } else {
                process.env.MIRA_GITHUB_TOKEN_BACKUP = originalMiraBackupToken;
            }
            if (originalRajohanToken === undefined) {
                delete process.env.RAJOHAN_GITHUB_TOKEN;
            } else {
                process.env.RAJOHAN_GITHUB_TOKEN = originalRajohanToken;
            }
            if (originalRajohanBackupToken === undefined) {
                delete process.env.RAJOHAN_GITHUB_TOKEN_BACKUP;
            } else {
                process.env.RAJOHAN_GITHUB_TOKEN_BACKUP = originalRajohanBackupToken;
            }
            if (originalGhToken === undefined) {
                delete process.env.GH_TOKEN;
            } else {
                process.env.GH_TOKEN = originalGhToken;
            }
            delete process.env.GITHUB_TOKEN;
        }
    });

    it("rejects unsafe dashboard root configuration at import time", async () => {
        const restoreEnv = saveEnv([
            "MIRA_DASHBOARD_ROOT",
            "MIRA_DASHBOARD_WORKTREE_ROOT",
        ]);
        try {
            process.env.MIRA_DASHBOARD_ROOT = "relative-dashboard";
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(tempDir, "worktrees");
            await assert.rejects(
                () => import(`./pullRequests.js?relative-root=${randomUUID()}`),
                /MIRA_DASHBOARD_ROOT must be an absolute non-root path/u
            );

            process.env.MIRA_DASHBOARD_ROOT = tempDir;
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(
                path.parse(tempDir).root,
                "tmp",
                ".."
            );
            await assert.rejects(
                () => import(`./pullRequests.js?root-worktree=${randomUUID()}`),
                /MIRA_DASHBOARD_WORKTREE_ROOT must be an absolute non-root path/u
            );
        } finally {
            restoreEnv();
        }
    });

    it("rejects invalid pull request numbers before running external commands", async () => {
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress the expected route error for this negative-path assertion.
        };
        try {
            const response = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/nope/approve",
                { method: "POST", body: {} }
            );

            assert.equal(response.status, 400);
            assert.equal(response.body.error, "Invalid pull request number");

            const reject = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/nope/reject",
                { method: "POST", body: { comment: "Nope" } }
            );

            assert.equal(reject.status, 400);
            assert.equal(reject.body.error, "Invalid pull request number");

            const review = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/nope/review-approval",
                { method: "POST", body: {} }
            );

            assert.equal(review.status, 400);
            assert.equal(review.body.error, "Invalid pull request number");
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("approves pull request reviews with the Rajohan GitHub token", async () => {
        if (process.env.FAKE_GH_REVIEW_STATE_FILE) {
            await rm(process.env.FAKE_GH_REVIEW_STATE_FILE, { force: true });
        }
        const response = await requestJson<{
            ok: boolean;
            message: string;
            pullRequest?: { reviewDecision?: string };
        }>(server, "/api/pull-requests/13/review-approval", {
            method: "POST",
            body: {},
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.message, "PR #13 review approved");
        assert.equal(response.body.pullRequest?.reviewDecision, "APPROVED");
    });

    it("blocks review approval for Rajohan-authored pull requests or missing token", async () => {
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress expected route errors for this negative-path assertion.
        };
        const restoreEnv = saveEnv(["RAJOHAN_GITHUB_TOKEN"]);
        try {
            if (process.env.FAKE_GH_REVIEW_STATE_FILE) {
                await rm(process.env.FAKE_GH_REVIEW_STATE_FILE, { force: true });
            }
            const ownPullRequest = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/11/review-approval",
                { method: "POST", body: {} }
            );

            assert.equal(ownPullRequest.status, 500);
            assert.equal(
                ownPullRequest.body.error,
                "Rajohan cannot approve his own pull request"
            );

            delete process.env.RAJOHAN_GITHUB_TOKEN;
            const missingToken = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/13/review-approval",
                { method: "POST", body: {} }
            );

            assert.equal(missingToken.status, 500);
            assert.equal(
                missingToken.body.error,
                "Rajohan GitHub review token is not configured"
            );
        } finally {
            restoreEnv();
            console.error = originalConsoleError;
        }
    });

    it("approves, rejects, and deploys Mira pull requests", async () => {
        clearDeploymentState(tempDir);
        const approve = await requestJson<{
            ok: boolean;
            message: string;
            cleanup: { status: string; branch: string };
        }>(server, "/api/pull-requests/10/approve", {
            method: "POST",
            body: { deploy: false },
        });
        assert.equal(approve.status, 200);
        assert.equal(approve.body.ok, true);
        assert.equal(approve.body.message, "PR #10 merged");
        assert.deepEqual(approve.body.cleanup, {
            status: "removed",
            branch: "add-playwright-smoke-tests",
            path: path.join(tempDir, "worktrees", "add-playwright-smoke-tests"),
            message: "Removed local worktree for add-playwright-smoke-tests",
        });

        const reject = await requestJson<{
            ok: boolean;
            message: string;
            cleanup: { status: string };
        }>(server, "/api/pull-requests/10/reject", {
            method: "POST",
            body: { comment: " Not this one " },
        });
        assert.equal(reject.status, 200);
        assert.equal(reject.body.ok, true);
        assert.equal(reject.body.message, "PR #10 closed");

        const deploy = await requestJson<{
            ok: boolean;
            deployment: { id: string; status: string; commit?: string; note: string };
        }>(server, "/api/pull-requests/deploy", { method: "POST", body: {} });
        assert.equal(deploy.status, 200);
        assert.equal(deploy.body.ok, true);
        assert.equal(deploy.body.deployment.status, "building");
        assert.equal(deploy.body.deployment.commit, undefined);
        assert.equal(deploy.body.deployment.note, "Deploy started");
        const deploymentId = deploy.body.deployment.id;
        try {
            const finishedDeploy = await waitForDeploymentStatus(
                deploymentId,
                "restart-scheduled",
                tempDir
            );
            assert.equal(finishedDeploy.commit, "abc1234");
            assert.equal(
                finishedDeploy.note,
                "Build passed; restart + health check scheduled"
            );
        } finally {
            if (deploymentId) {
                releaseDeploymentLockInDb(deploymentId, tempDir);
                await waitForDeploymentLockReleased(tempDir);
            }
        }

        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        const restoreGitEnv = saveEnv(["FAKE_GIT_WORKTREE_LIST"]);
        process.env.FAKE_GIT_WORKTREE_LIST = "short-branch";
        try {
            const approveAndDeploy = await requestJson<{
                ok: boolean;
                message: string;
                deployment: { id: string; status: string };
            }>(server, "/api/pull-requests/10/approve", {
                method: "POST",
                body: { deploy: true },
            });
            assert.equal(approveAndDeploy.status, 200);
            assert.equal(approveAndDeploy.body.message, "PR #10 merged; deploy started");
            assert.equal(approveAndDeploy.body.deployment.status, "building");
            const deploymentId = approveAndDeploy.body.deployment.id;
            try {
                await waitForDeploymentStatus(deploymentId, "restart-scheduled", tempDir);
            } finally {
                if (deploymentId) {
                    releaseDeploymentLockInDb(deploymentId, tempDir);
                    await waitForDeploymentLockReleased(tempDir);
                }
            }
        } finally {
            restoreGitEnv();
        }

        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        const restoreSyncOnlyFailureEnv = saveEnv([
            "FAKE_GIT_WORKTREE_LIST",
            "FAKE_GIT_PULL_FAIL",
        ]);
        process.env.FAKE_GIT_WORKTREE_LIST = "short-branch";
        process.env.FAKE_GIT_PULL_FAIL = "1";
        try {
            const syncOnlyFailure = await requestJson<{
                ok: boolean;
                message: string;
                syncError: string;
            }>(server, "/api/pull-requests/10/approve", {
                method: "POST",
                body: { deploy: false },
            });
            assert.equal(syncOnlyFailure.status, 200);
            assert.equal(syncOnlyFailure.body.ok, true);
            assert.equal(
                syncOnlyFailure.body.message,
                "PR #10 merged; production sync failed"
            );
            assert.match(syncOnlyFailure.body.syncError, /pull failed/u);
        } finally {
            restoreSyncOnlyFailureEnv();
        }

        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        const restoreSyncFailureEnv = saveEnv([
            "FAKE_GIT_WORKTREE_LIST",
            "FAKE_GIT_PULL_FAIL",
        ]);
        process.env.FAKE_GIT_WORKTREE_LIST = "short-branch";
        process.env.FAKE_GIT_PULL_FAIL = "1";
        try {
            const partialSuccess = await requestJson<{
                ok: boolean;
                message: string;
                cleanup: { status: string };
                deployment?: { id: string; status: string };
                syncError: string;
            }>(server, "/api/pull-requests/10/approve", {
                method: "POST",
                body: { deploy: true },
            });
            assert.equal(partialSuccess.status, 200);
            assert.equal(partialSuccess.body.ok, true);
            assert.equal(
                partialSuccess.body.message,
                "PR #10 merged; production sync failed"
            );
            assert.equal(partialSuccess.body.cleanup.status, "removed");
            assert.equal(partialSuccess.body.deployment, undefined);
            assert.match(partialSuccess.body.syncError, /pull failed/u);
        } finally {
            restoreSyncFailureEnv();
        }

        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        const { db: deploymentDb } = await import("../db.js");
        const realDeploymentPrepare = deploymentDb.prepare.bind(deploymentDb);
        const failedDeployStartMock = mock.method(
            deploymentDb,
            "prepare",
            (sql: string) => {
                if (sql.includes("INSERT INTO deployment_jobs")) {
                    throw new Error("job write failed");
                }
                return realDeploymentPrepare(sql);
            }
        );
        try {
            const deployStartFailure = await requestJson<{
                ok: boolean;
                message: string;
                cleanup: { status: string };
                deployment?: { id: string; status: string };
                deployError: string;
            }>(server, "/api/pull-requests/10/approve", {
                method: "POST",
                body: { deploy: true },
            });
            assert.equal(deployStartFailure.status, 200);
            assert.equal(deployStartFailure.body.ok, true);
            assert.equal(
                deployStartFailure.body.message,
                "PR #10 merged; deploy failed to start"
            );
            assert.equal(deployStartFailure.body.cleanup.status, "removed");
            assert.equal(deployStartFailure.body.deployment, undefined);
            assert.equal(deployStartFailure.body.deployError, "job write failed");
        } finally {
            failedDeployStartMock.mock.restore();
        }

        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        const { __testing } = await import(
            `./pullRequests.js?merge-active=${randomUUID()}`
        );
        const activeUpdatedAt = new Date().toISOString();
        __testing.writeDeploymentJob({
            id: "merge-active-job",
            status: "building",
            startedAt: activeUpdatedAt,
            updatedAt: activeUpdatedAt,
            note: "Deploy started",
        });
        __testing.acquireDeploymentLock("merge-active-job");
        try {
            const activeDeployFailure = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/10/approve",
                {
                    method: "POST",
                    body: { deploy: true },
                }
            );
            assert.equal(activeDeployFailure.status, 500);
            assert.equal(
                activeDeployFailure.body.error,
                "Dashboard deploy already in progress (merge-active-job)"
            );

            const mergeOnlyFailure = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/10/approve",
                {
                    method: "POST",
                    body: { deploy: false },
                }
            );
            assert.equal(mergeOnlyFailure.status, 500);
            assert.equal(
                mergeOnlyFailure.body.error,
                "Dashboard deploy already in progress (merge-active-job)"
            );
        } finally {
            __testing.releaseDeploymentLock("merge-active-job");
        }
    });

    it("allows approved non-Mira pull requests to merge", async () => {
        clearDeploymentState(tempDir);
        const response = await requestJson<{
            ok: boolean;
            message: string;
            cleanup: { status: string; branch: string };
        }>(server, "/api/pull-requests/11/approve", {
            method: "POST",
            body: { deploy: false },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.message, "PR #11 merged");
        assert.equal(response.body.cleanup.branch, "chore/coverage-to-100-followup");
    });

    it("allows non-Mira pull requests to be rejected from the dashboard", async () => {
        const response = await requestJson<{
            ok: boolean;
            message: string;
            cleanup: { status: string; branch: string };
        }>(server, "/api/pull-requests/11/reject", {
            method: "POST",
            body: { comment: "Closing this external PR" },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.message, "PR #11 closed");
        assert.equal(response.body.cleanup.status, "skipped");
        assert.equal(response.body.cleanup.branch, "chore/coverage-to-100-followup");
    });

    it("blocks merging non-Mira pull requests without review approval", async () => {
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress the expected route error for this negative-path assertion.
        };
        try {
            const response = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/18/approve",
                { method: "POST", body: { deploy: false } }
            );

            assert.equal(response.status, 500);
            assert.equal(
                response.body.error,
                "Pull request review approval is required before merging"
            );
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("blocks approval until CI checks have passed while still allowing rejection", async () => {
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress the expected route error for this negative-path assertion.
        };
        try {
            const approval = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/13/approve",
                { method: "POST", body: { deploy: false } }
            );

            assert.equal(approval.status, 500);
            assert.equal(
                approval.body.error,
                "Pull request CI checks must pass before approval"
            );

            const rejection = await requestJson<{
                message: string;
                cleanup: { status: string };
            }>(server, "/api/pull-requests/13/reject", {
                method: "POST",
                body: { comment: "Not ready yet" },
            });

            assert.equal(rejection.status, 200);
            assert.equal(rejection.body.message, "PR #13 closed");
            assert.equal(rejection.body.cleanup.status, "skipped");
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("reports cleanup warnings for missing, unsafe, or dirty worktrees", async () => {
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress expected route errors for forced production-checkout failures.
        };

        const restoreGitEnv = saveEnv([
            "FAKE_GIT_WORKTREE_LIST",
            "FAKE_GIT_DIRTY_WORKTREE",
            "FAKE_GIT_REMOVE_FAIL",
            "FAKE_GIT_DIRTY_PRODUCTION",
        ]);
        try {
            process.env.FAKE_GIT_WORKTREE_LIST = "empty";
            const noWorktree = await requestJson<{
                cleanup: { status: string; branch: string; message: string };
            }>(server, "/api/pull-requests/10/reject", {
                method: "POST",
                body: {},
            });
            assert.equal(noWorktree.status, 200);
            assert.deepEqual(noWorktree.body.cleanup, {
                status: "skipped",
                branch: "add-playwright-smoke-tests",
                message: "No local worktree found for add-playwright-smoke-tests",
            });

            process.env.FAKE_GIT_WORKTREE_LIST = "outside";
            const outside = await requestJson<{ cleanup: { status: string } }>(
                server,
                "/api/pull-requests/10/reject",
                { method: "POST", body: {} }
            );
            assert.equal(outside.status, 200);
            assert.equal(outside.body.cleanup.status, "warning");

            delete process.env.FAKE_GIT_WORKTREE_LIST;
            process.env.FAKE_GIT_DIRTY_WORKTREE = "1";
            const dirty = await requestJson<{
                cleanup: { status: string; message: string };
            }>(server, "/api/pull-requests/10/reject", {
                method: "POST",
                body: {},
            });
            assert.equal(dirty.status, 200);
            assert.equal(dirty.body.cleanup.status, "warning");
            assert.equal(
                dirty.body.cleanup.message,
                "Skipped cleanup for add-playwright-smoke-tests; worktree has local changes"
            );

            delete process.env.FAKE_GIT_DIRTY_WORKTREE;
            process.env.FAKE_GIT_REMOVE_FAIL = "1";
            const removeFailure = await requestJson<{
                cleanup: { status: string; message: string };
            }>(server, "/api/pull-requests/10/reject", {
                method: "POST",
                body: {},
            });
            assert.equal(removeFailure.status, 200);
            assert.equal(removeFailure.body.cleanup.status, "warning");
            assert.match(removeFailure.body.cleanup.message, /remove failed/u);

            delete process.env.FAKE_GIT_REMOVE_FAIL;
            process.env.FAKE_GIT_DIRTY_PRODUCTION = "1";
            const dirtyProduction = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/10/approve",
                { method: "POST", body: { deploy: false } }
            );
            assert.equal(dirtyProduction.status, 500);
            assert.equal(
                dirtyProduction.body.error,
                "Production checkout has local changes; refusing deploy/merge"
            );
        } finally {
            restoreGitEnv();
            console.error = originalConsoleError;
        }
    });

    it("surfaces production checkout and deploy readiness failures", async () => {
        clearDeploymentState(tempDir);
        const originalConsoleError = console.error;
        console.error = () => {
            // Suppress expected route errors for forced deploy failures.
        };

        const restoreGitEnv = saveEnv([
            "FAKE_GIT_NO_UPSTREAM",
            "FAKE_GIT_EMPTY_UPSTREAM",
            "FAKE_GIT_ROOT",
            "FAKE_GIT_BRANCH",
        ]);
        try {
            process.env.FAKE_GIT_NO_UPSTREAM = "1";
            const checkout = await requestJson<{
                checkout: { upstream?: string; isSafeForDeploy: boolean };
            }>(server, "/api/pull-requests/production-checkout");
            assert.equal(checkout.status, 200);
            assert.equal(checkout.body.checkout.upstream, undefined);
            assert.equal(checkout.body.checkout.isSafeForDeploy, true);
            delete process.env.FAKE_GIT_NO_UPSTREAM;

            process.env.FAKE_GIT_EMPTY_UPSTREAM = "1";
            const emptyUpstream = await requestJson<{
                checkout: { upstream?: string; isSafeForDeploy: boolean };
            }>(server, "/api/pull-requests/production-checkout");
            assert.equal(emptyUpstream.status, 200);
            assert.equal(emptyUpstream.body.checkout.upstream, undefined);
            assert.equal(emptyUpstream.body.checkout.isSafeForDeploy, true);
            delete process.env.FAKE_GIT_EMPTY_UPSTREAM;

            process.env.FAKE_GIT_ROOT = path.join(tempDir, "not-production");
            const wrongRoot = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/deploy",
                { method: "POST", body: {} }
            );
            assert.equal(wrongRoot.status, 500);
            assert.match(wrongRoot.body.error, /Expected production checkout/);

            delete process.env.FAKE_GIT_ROOT;
            process.env.FAKE_GIT_BRANCH = "preview/pr-10";
            const wrongBranch = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/deploy",
                { method: "POST", body: {} }
            );
            assert.equal(wrongBranch.status, 500);
            assert.match(
                wrongBranch.body.error,
                /Production checkout must be clean main before deploy/
            );
            delete process.env.FAKE_GIT_BRANCH;

            const { __testing } = await import(
                `./pullRequests.js?active-deploy=${randomUUID()}`
            );
            const activeUpdatedAt = new Date().toISOString();
            clearDeploymentState(tempDir);
            __testing.writeDeploymentJob({
                id: "active-job",
                status: "building",
                startedAt: activeUpdatedAt,
                updatedAt: activeUpdatedAt,
                note: "Deploy started",
            });
            __testing.acquireDeploymentLock("active-job");
            const activeDeploy = await requestJson<{ error: string }>(
                server,
                "/api/pull-requests/deploy",
                { method: "POST", body: {} }
            );
            assert.equal(activeDeploy.status, 500);
            assert.equal(
                activeDeploy.body.error,
                "Dashboard deploy already in progress (active-job)"
            );
        } finally {
            restoreGitEnv();
            const { __testing } = await import(
                `./pullRequests.js?active-deploy-cleanup=${randomUUID()}`
            );
            __testing.releaseDeploymentLock("active-job");
            console.error = originalConsoleError;
        }
    });
});
