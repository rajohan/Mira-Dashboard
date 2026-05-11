import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalDashboardRoot = process.env.MIRA_DASHBOARD_ROOT;
const originalWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;

async function writeExecutable(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
    await chmod(filePath, 0o755);
}

async function installFakeCommands(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    await writeExecutable(
        path.join(binDir, "gh"),
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const pr = {
  number: 10,
  title: "Add Playwright smoke tests",
  body: "Coverage batch",
  url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
  headRefName: "add-playwright-smoke-tests",
  baseRefName: "master",
  author: { login: "mira-2026" },
  createdAt: "2026-05-10T00:00:00Z",
  updatedAt: "2026-05-11T00:00:00Z",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  statusCheckRollup: [],
  additions: 12,
  deletions: 3,
  changedFiles: 4
};
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([pr]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === "pr" && ["merge", "close"].includes(args[1])) {
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
  process.stdout.write((process.env.MIRA_DASHBOARD_ROOT || "/home/ubuntu/projects/mira-dashboard") + "\n");
  process.exit(0);
}
if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
  process.stdout.write("master\n");
  process.exit(0);
}
if (args.join(" ") === "rev-parse --short HEAD") {
  process.stdout.write("abc1234\n");
  process.exit(0);
}
if (args.join(" ") === "status --short") {
  process.exit(0);
}
if (args.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
  process.stdout.write("origin/master\n");
  process.exit(0);
}
if (args.join(" ") === "worktree list --porcelain") {
  process.stdout.write("worktree " + process.env.MIRA_DASHBOARD_WORKTREE_ROOT + "/add-playwright-smoke-tests\nHEAD deadbeef\nbranch refs/heads/add-playwright-smoke-tests\n\n");
  process.exit(0);
}
if (args[0] === "-C" && args[2] === "status" && args[3] === "--short") {
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "remove") {
  process.stdout.write("removed " + args[2] + "\n");
  process.exit(0);
}
if (["fetch", "checkout", "pull"].includes(args[0])) {
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
        path.join(binDir, "sudo"),
        String.raw`#!${process.execPath}
process.stdout.write("sudo " + process.argv.slice(2).join(" ") + "\n");
`
    );

    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(tempDir: string): Promise<TestServer> {
    process.chdir(tempDir);
    process.env.MIRA_DASHBOARD_ROOT = tempDir;
    process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(tempDir, "worktrees");
    const { default: pullRequestsRoutes } = await import(
        `./pullRequests.js?test=${Date.now()}`
    );
    const app = express();
    app.use(express.json());
    pullRequestsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
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
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-pull-requests-"));
        await installFakeCommands(tempDir);
        await mkdir(path.join(tempDir, "data", "deployments"), { recursive: true });
        await mkdir(path.join(tempDir, "worktrees", "add-playwright-smoke-tests"), {
            recursive: true,
        });
        await writeFile(
            path.join(tempDir, "data", "deployments", "job-1.json"),
            JSON.stringify({
                id: "job-1",
                status: "ok",
                startedAt: "2026-05-11T00:00:00.000Z",
                updatedAt: "2026-05-11T00:01:00.000Z",
                commit: "abc1234",
            }),
            "utf8"
        );
        server = await startServer(tempDir);
    });

    after(async () => {
        await server.close();
        process.chdir(originalCwd);
        process.env.PATH = originalPath;
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
        await rm(tempDir, { recursive: true, force: true });
    });

    it("lists Mira-authored pull requests from GitHub", async () => {
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
                number: 10,
                title: "Add Playwright smoke tests",
                body: "Coverage batch",
                url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
                headRefName: "add-playwright-smoke-tests",
                baseRefName: "master",
                author: { login: "mira-2026" },
                createdAt: "2026-05-10T00:00:00Z",
                updatedAt: "2026-05-11T00:00:00Z",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "",
                statusCheckRollup: [],
                additions: 12,
                deletions: 3,
                changedFiles: 4,
            },
        ]);
    });

    it("returns recent deployment jobs from the local deployment directory", async () => {
        const response = await requestJson<{
            deployments: Array<{ id: string; status: string; commit: string }>;
        }>(server, "/api/pull-requests/deployments");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.deployments, [
            {
                id: "job-1",
                status: "ok",
                startedAt: "2026-05-11T00:00:00.000Z",
                updatedAt: "2026-05-11T00:01:00.000Z",
                commit: "abc1234",
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
            branch: "master",
            expectedBranch: "master",
            head: "abc1234",
            upstream: "origin/master",
            isClean: true,
            isProductionRoot: true,
            isSafeForDeploy: true,
        });
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

            assert.equal(response.status, 500);
            assert.equal(response.body.error, "Invalid pull request number");
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("approves, rejects, and deploys Mira pull requests", async () => {
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
            deployment: { status: string; commit: string; note: string };
        }>(server, "/api/pull-requests/deploy", { method: "POST", body: {} });
        assert.equal(deploy.status, 200);
        assert.equal(deploy.body.ok, true);
        assert.equal(deploy.body.deployment.status, "restart-scheduled");
        assert.equal(deploy.body.deployment.commit, "abc1234");
        assert.equal(
            deploy.body.deployment.note,
            "Build passed; restart + health check scheduled"
        );
    });
});
