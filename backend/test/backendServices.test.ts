import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import type { DashboardSocket } from "../src/dashboardSocket.ts";
import { database } from "../src/database.ts";

const cleanupCallbacks: Array<() => void> = [];

function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => {
        rmSync(root, { force: true, recursive: true });
    });
    return root;
}

function writeFakeGit(binaryPath: string, repoRoot: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(repoRoot)}
elif [[ "$args" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$args" == "rev-parse --short HEAD" ]]; then
  printf 'abc1234\n'
elif [[ "$args" == "rev-parse --abbrev-ref --symbolic-full-name @{u}" ]]; then
  printf 'origin/main\n'
elif [[ "$1" == "status" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function waitFor(isReady: () => boolean, timeoutMilliseconds = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (isReady()) {
                resolve();
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error("Timed out waiting for test condition"));
                return;
            }
            setTimeout(tick, 10);
        };
        tick();
    });
}

afterEach(() => {
    while (cleanupCallbacks.length > 0) {
        cleanupCallbacks.pop()?.();
    }
});

describe("backend service behavior", () => {
    it("handles auth hashing, users, sessions, and gateway tokens", async () => {
        const username = `User-${Bun.randomUUIDv7()}`;
        const normalizedUsername = username.toLowerCase();
        const {
            cleanupExpiredSessions,
            createSession,
            createUser,
            deleteSession,
            findUserByUsername,
            getAuthUserFromSessionId,
            getPersistedGatewayToken,
            hashPassword,
            isPasswordVerified,
            persistGatewayToken,
        } = await import("../src/auth.ts");

        try {
            const hash = hashPassword("correct horse battery staple");
            expect(isPasswordVerified("correct horse battery staple", hash)).toBe(true);
            expect(isPasswordVerified("wrong password", hash)).toBe(false);
            expect(isPasswordVerified("password", "not-a-valid-hash")).toBe(false);

            const user = createUser(username, "test-password");
            expect(user).toMatchObject({ username: normalizedUsername });
            expect(findUserByUsername(`  ${username.toUpperCase()}  `)).toMatchObject({
                id: user.id,
                username: normalizedUsername,
            });

            const sessionId = createSession(user.id);
            expect(getAuthUserFromSessionId(sessionId)).toEqual(user);
            deleteSession(sessionId);
            expect(getAuthUserFromSessionId(sessionId)).toBeUndefined();

            const expiredSessionId = createSession(user.id);
            database
                .prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
                .run("2000-01-01T00:00:00.000Z", expiredSessionId);
            cleanupExpiredSessions();
            expect(getAuthUserFromSessionId(expiredSessionId)).toBeUndefined();

            persistGatewayToken("token-one");
            expect(getPersistedGatewayToken()).toBe("token-one");
            persistGatewayToken("token-two");
            expect(getPersistedGatewayToken()).toBe("token-two");
        } finally {
            database
                .prepare(
                    "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)"
                )
                .run(normalizedUsername);
            database
                .prepare("DELETE FROM users WHERE username = ?")
                .run(normalizedUsername);
            database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
        }
    });

    it("sends log history to subscribers from the configured isolated log root", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-streams-test-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;

        const today = new Date().toISOString().split("T", 1)[0];
        writeFileSync(
            path.join(logsRoot, `openclaw-${today}.log`),
            "first line\nsecond line\n"
        );

        const messages: unknown[] = [];
        const socket = {
            send: (message: string) => {
                messages.push(JSON.parse(message) as unknown);
            },
        } as DashboardSocket;
        const { subscribeToLogs, unsubscribeFromLogs } =
            await import("../src/services/logStreams.ts");

        subscribeToLogs(socket);
        try {
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (message as { type?: unknown }).type === "log_history_complete"
                )
            );

            expect(messages).toContainEqual({ type: "log", line: "first line" });
            expect(messages).toContainEqual({ type: "log", line: "second line" });
            expect(messages).toContainEqual({
                type: "log_history_complete",
                count: 2,
            });
        } finally {
            unsubscribeFromLogs(socket);
        }
    });

    it("records cache failures without claiming a successful update timestamp", async () => {
        const key = `test.cache.${Bun.randomUUIDv7()}`;
        const { writeCacheFailure } = await import("../src/services/cacheRefresh.ts");

        writeCacheFailure({
            key,
            source: "test",
            ttl: 5,
            ttlUnit: "minutes",
            error: new Error("provider unavailable"),
            metadata: { provider: "unit-test" },
        });

        const row = database
            .prepare(
                `SELECT updated_at, last_attempt_at, status, error_message, consecutive_failures, metadata_json
                 FROM cache_entries
                 WHERE key = ?`
            )
            .get(key) as {
            updated_at: string | null;
            last_attempt_at: string;
            status: string;
            error_message: string;
            consecutive_failures: number;
            metadata_json: string;
        };

        expect(row.updated_at).toBeNull();
        expect(row.last_attempt_at).toBeTruthy();
        expect(row.status).toBe("error");
        expect(row.error_message).toBe("provider unavailable");
        expect(row.consecutive_failures).toBe(1);
        expect(JSON.parse(row.metadata_json)).toMatchObject({
            provider: "unit-test",
            lastFailureAt: row.last_attempt_at,
        });

        database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
    });

    it("rejects unsupported and aborted cache refresh producer requests", async () => {
        const { refreshCacheProducer, waitForLocalCacheSeed } =
            await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("unknown.cache.key")).rejects.toThrow(
            "No backend refresh producer configured for cache key"
        );

        const controller = new AbortController();
        controller.abort();
        await expect(
            refreshCacheProducer("weather.spydeberg", controller.signal)
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(waitForLocalCacheSeed("missing.key")).resolves.toBeUndefined();
    });

    it("maps recent deployment jobs in newest-first order", async () => {
        const olderId = `test-deploy-older-${Bun.randomUUIDv7()}`;
        const newerId = `test-deploy-newer-${Bun.randomUUIDv7()}`;
        database
            .prepare(
                `INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                olderId,
                "failed",
                "2026-06-24T10:00:00.000Z",
                "2026-06-24T10:01:00.000Z",
                "abc123",
                "Older deploy",
                "older note",
                "older out",
                "older err"
            );
        database
            .prepare(
                `INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                newerId,
                "done",
                "2026-06-24T11:00:00.000Z",
                "2026-06-24T11:01:00.000Z",
                "def456",
                "Newer deploy",
                "newer note",
                "newer out",
                ""
            );

        try {
            const { readDeploymentJobs } =
                await import("../src/services/pullRequests.ts");
            const jobs = readDeploymentJobs();

            expect(jobs.findIndex((job) => job.id === newerId)).toBeLessThan(
                jobs.findIndex((job) => job.id === olderId)
            );
            expect(jobs.find((job) => job.id === newerId)).toMatchObject({
                id: newerId,
                status: "done",
                commit: "def456",
                commitTitle: "Newer deploy",
                note: "newer note",
                stdout: "newer out",
                stderr: "",
            });
        } finally {
            database
                .prepare("DELETE FROM deployment_jobs WHERE id IN (?, ?)")
                .run(olderId, newerId);
        }
    });

    it("reports production checkout readiness through git command output", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-status-root-");
        const fakeBin = createTemporaryRoot("mira-pr-status-bin-");
        writeFakeGit(path.join(fakeBin, "git"), fakeRoot);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");

        const { getProductionCheckoutStatus, ensureProductionReadyForDeploy } =
            await import("../src/services/pullRequests.ts");

        const status = await getProductionCheckoutStatus();
        expect(status).toMatchObject({
            root: fakeRoot,
            expectedRoot: fakeRoot,
            branch: "main",
            expectedBranch: "main",
            head: "abc1234",
            upstream: "origin/main",
            isClean: true,
            isProductionRoot: true,
            isSafeForDeploy: true,
        });
        await expect(ensureProductionReadyForDeploy()).resolves.toBeUndefined();
    });

    it("returns conflict/not-found errors for clearing inactive backup jobs", async () => {
        const { clearNeedsAttentionBackupJob } =
            await import("../src/services/backups.ts");

        await expect(clearNeedsAttentionBackupJob("kopia")).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(clearNeedsAttentionBackupJob("walg")).rejects.toThrow(
            "WALG backup job not found"
        );
    });

    it("updates agent metadata and rolls active task history forward", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-agent-service-test-");
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;

        const agentId = `agent-${Bun.randomUUIDv7()}`;
        const { updateAgentCurrentTask, getLatestCompletedTasks } =
            await import("../src/services/agents.ts");

        try {
            const firstMetadata = await updateAgentCurrentTask(agentId, "First task");
            const secondMetadata = await updateAgentCurrentTask(agentId, "Second task");

            expect(firstMetadata.currentTask).toBe("First task");
            expect(secondMetadata.currentTask).toBe("Second task");
            const metadataFile = Bun.file(
                path.join(openclawRoot, "agents", agentId, "sessions", "metadata.json")
            );
            expect(await metadataFile.json()).toMatchObject({
                currentTask: "Second task",
            });

            const completedTasks = getLatestCompletedTasks(20).filter(
                (task) => task.agentId === agentId
            );
            expect(completedTasks).toContainEqual(
                expect.objectContaining({
                    agentId,
                    task: "First task",
                    status: "completed",
                })
            );
        } finally {
            database
                .prepare("DELETE FROM agent_task_history WHERE agent_id = ?")
                .run(agentId);
        }
    });
});
