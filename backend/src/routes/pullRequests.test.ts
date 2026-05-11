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

async function writeExecutable(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
    await chmod(filePath, 0o755);
}

async function installFakeCommands(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    await writeExecutable(
        path.join(binDir, "gh"),
        String.raw`#!/usr/bin/node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
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
      changedFiles: 4
    }
  ]));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(1);
`
    );

    await writeExecutable(
        path.join(binDir, "git"),
        String.raw`#!/usr/bin/node
const args = process.argv.slice(2);
if (args.join(" ") === "rev-parse --show-toplevel") {
  process.stdout.write("/home/ubuntu/projects/mira-dashboard\n");
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
process.stderr.write("unexpected git args: " + args.join(" "));
process.exit(1);
`
    );

    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(tempDir: string): Promise<TestServer> {
    process.chdir(tempDir);
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
            root: "/home/ubuntu/projects/mira-dashboard",
            expectedRoot: "/home/ubuntu/projects/mira-dashboard",
            worktreeRoot: "/home/ubuntu/projects/mira-dashboard-worktrees",
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
});
