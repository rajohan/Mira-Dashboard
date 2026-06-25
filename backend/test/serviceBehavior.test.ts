import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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

function routeRequest<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & { params: Record<T, string> } {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
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

function writeFakeGh(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"--paginate"* && "$*" == *"-F owner=rajohan"* && "$*" == *"-F name=Mira-Dashboard"* && "$*" == *"-f query="* && "$*" == *"--jq"* ]]; then
  printf '%s\n' '{"number":1,"title":"Ready PR","body":"","url":"https://github.test/pr/1","headRefName":"ready","headRefOid":"head1","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T08:00:00.000Z","updatedAt":"2026-06-24T09:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[{"state":"APPROVED","submittedAt":"2026-06-24T08:30:00.000Z","author":{"login":"rajohan"}}]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T08:45:00.000Z"}]}'
  printf '%s\n' '{"number":2,"title":"Blocked cached PR","body":"","url":"https://github.test/pr/2","headRefName":"blocked","headRefOid":"head2","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"APPROVED","latestOpinionatedReviews":{"nodes":[]},"additions":2,"deletions":1,"changedFiles":2,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T10:45:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 2" ]]; then
  printf '%s\n' '{"number":2,"title":"Blocked refreshed PR","body":"","url":"https://github.test/pr/2","headRefName":"blocked","headRefOid":"head2b","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:30:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":3,"deletions":1,"changedFiles":2,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:15:00.000Z"}]}'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestActions(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1 $2 $3" == "pr view 3" ]]; then
  printf '%s\n' '{"number":3,"title":"Needs review","body":"","url":"https://github.test/pr/3","headRefName":"review-branch","headRefOid":"head3","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 4" ]]; then
  printf '%s\n' '{"number":4,"title":"Behind branch","body":"","url":"https://github.test/pr/4","headRefName":"behind-branch","headRefOid":"head4","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BEHIND","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 5" ]]; then
  printf '%s\n' '{"number":5,"title":"Close me","body":"","url":"https://github.test/pr/5","headRefName":"close-branch","headRefOid":"head5","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr review 3" ]]; then
  printf 'review ok\n'
elif [[ "$1 $2" == "api -X" && "$*" == *"repos/rajohan/Mira-Dashboard/pulls/4/update-branch"* ]]; then
  printf '{}\n'
elif [[ "$1 $2 $3" == "pr close 5" ]]; then
  printf 'closed\n'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestValidation(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "pr view 6" ]]; then
  printf '%s\n' '{"number":6,"title":"Draft","body":"","url":"https://github.test/pr/6","headRefName":"draft-branch","headRefOid":"head6","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":true,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 7" ]]; then
  printf '%s\n' '{"number":7,"title":"Wrong base","body":"","url":"https://github.test/pr/7","headRefName":"feature","headRefOid":"head7","baseRefName":"develop","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 8" ]]; then
  printf '%s\n' '{"number":8,"title":"Not behind","body":"","url":"https://github.test/pr/8","headRefName":"current","headRefOid":"head8","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 9" ]]; then
  printf '%s\n' '{"number":9,"title":"Conflict","body":"","url":"https://github.test/pr/9","headRefName":"conflict","headRefOid":"head9","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"DIRTY","mergeStateStatus":"BEHIND","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 10" ]]; then
  printf '%s\n' '{"number":10,"title":"Own PR","body":"","url":"https://github.test/pr/10","headRefName":"own","headRefOid":"head10","baseRefName":"main","author":{"login":"rajohan"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeDocker(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "__MIRA_CONTAINER_PGREP_NO_MATCH__"
  exit 1
fi
if [[ "$*" == "exec walg /bin/sh /usr/local/bin/backup-push.sh" ]]; then
  printf '%s\n' "backup ok"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakePgrep(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "-f /opt/docker/apps/kopia/backup.sh" ]]; then
  printf '12345\n'
  exit 0
fi
exit 1
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeOpenClaw(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "gateway restart" ]]; then
  printf '%s\n' "restart ok"
  exit 0
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

class FakeGatewayWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeGatewayWebSocket[] = [];
    binaryType = "";
    readyState = FakeGatewayWebSocket.CONNECTING;
    readonly sent: string[] = [];
    closeCode: number | undefined;
    closeReason = "";

    constructor(readonly url: string) {
        super();
        FakeGatewayWebSocket.instances.push(this);
    }

    open(): void {
        this.readyState = FakeGatewayWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
    }

    message(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(code = 1000, reason = ""): void {
        this.readyState = FakeGatewayWebSocket.CLOSED;
        this.closeCode = code;
        this.closeReason = reason;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
}

function waitFor(isReady: () => boolean, timeoutMilliseconds = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    return new Promise((resolve, reject) => {
        const tick = () => {
            try {
                if (isReady()) {
                    resolve();
                    return;
                }
            } catch (error) {
                reject(error);
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
    const errors: unknown[] = [];
    while (cleanupCallbacks.length > 0) {
        try {
            cleanupCallbacks.pop()?.();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Test cleanup failed");
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

    it("keeps the active test database usable after a rejected rebind", () => {
        rememberEnvironment("MIRA_DASHBOARD_DB_PATH");
        const originalDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH;
        expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(
            process.cwd(),
            "data",
            `unsafe-${Bun.randomUUIDv7()}.db`
        );
        expect(() => database.prepare("SELECT 1").get()).toThrow(
            "Refusing to open non-temporary Dashboard test database"
        );

        if (originalDatabasePath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDatabasePath;
        }
        expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
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

    it("validates configured log roots before routes and streams use them", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-root-test-");
        const logFileRoot = path.join(logsRoot, "not-a-directory");
        const symlinkRoot = path.join(logsRoot, "linked-root");
        writeFileSync(logFileRoot, "not a directory");
        symlinkSync(logsRoot, symlinkRoot);
        const { resolveRealLogsDirectory } = await import("../src/lib/logRoots.ts");

        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        expect(resolveRealLogsDirectory()).toBe(logsRoot);

        process.env.MIRA_DASHBOARD_LOGS_ROOT = "relative/logs";
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must be absolute"
        );

        process.env.MIRA_DASHBOARD_LOGS_ROOT = path.parse(logsRoot).root;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory cannot be the filesystem root"
        );

        process.env.MIRA_DASHBOARD_LOGS_ROOT = symlinkRoot;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must not be a symlink"
        );

        process.env.MIRA_DASHBOARD_LOGS_ROOT = logFileRoot;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must be a directory"
        );
    });

    it("records cache failures without claiming a successful update timestamp", async () => {
        const key = `test.cache.${Bun.randomUUIDv7()}`;
        const { writeCacheFailure } = await import("../src/services/cacheRefresh.ts");

        try {
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
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
        }
    });

    it("writes successful cache entries and preserves existing data when requested", async () => {
        const key = `test.cache.success.${Bun.randomUUIDv7()}`;
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");

        try {
            writeCacheSuccess({
                data: { version: 1 },
                key,
                metadata: { source: "initial" },
                source: "unit",
                ttl: 1,
                ttlUnit: "minutes",
            });
            writeCacheSuccess({
                data: { version: 2 },
                key,
                metadata: { source: "preserved" },
                preserveExistingData: true,
                source: "unit",
                ttl: 2,
                ttlUnit: "hours",
            });

            const row = database
                .prepare(
                    `SELECT data_json, status, consecutive_failures, error_message, metadata_json
                     FROM cache_entries
                     WHERE key = ?`
                )
                .get(key) as {
                consecutive_failures: number;
                data_json: string;
                error_message: string | null;
                metadata_json: string;
                status: string;
            };

            expect(JSON.parse(row.data_json)).toEqual({ version: 1 });
            expect(row.status).toBe("fresh");
            expect(row.consecutive_failures).toBe(0);
            expect(row.error_message).toBeNull();
            expect(JSON.parse(row.metadata_json)).toEqual({ source: "preserved" });
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
        }
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

    it("rejects unsafe production checkout states before deploy work starts", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-unsafe-root-");
        const actualRoot = path.join(fakeRoot, "actual");
        const expectedRoot = path.join(fakeRoot, "expected");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-unsafe-bin-");
        mkdirSync(expectedRoot, { recursive: true });
        mkdirSync(worktreeRoot, { recursive: true });
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(actualRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'feature\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'badc0de\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  exit 1
elif [[ "$1" == "status" ]]; then
  printf ' M backend/src/server.ts\n'
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = expectedRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;

        const {
            ensureProductionCheckout,
            ensureProductionReadyForDeploy,
            getProductionCheckoutStatus,
        } = await import("../src/services/pullRequests.ts");

        await expect(getProductionCheckoutStatus()).resolves.toMatchObject({
            branch: "feature",
            isClean: false,
            isProductionRoot: false,
            isSafeForDeploy: false,
            root: actualRoot,
            statusShort: "M backend/src/server.ts",
            upstream: undefined,
        });
        await expect(ensureProductionCheckout()).rejects.toThrow(
            "Expected production checkout"
        );
        await expect(ensureProductionReadyForDeploy()).rejects.toThrow(
            "Production checkout must be clean main before deploy"
        );
    });

    it("lists pull requests from GitHub JSON lines and refreshes blocked merge state", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_USERNAME");
        const fakeRoot = createTemporaryRoot("mira-pr-list-root-");
        const fakeBin = createTemporaryRoot("mira-pr-list-bin-");
        writeFakeGh(path.join(fakeBin, "gh"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.RAJOHAN_GITHUB_USERNAME = "rajohan";

        const { listDashboardPullRequests, validatePrNumber } =
            await import("../src/services/pullRequests.ts");

        const pullRequests = await listDashboardPullRequests();
        expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([2, 1]);
        expect(pullRequests[0]).toMatchObject({
            number: 2,
            title: "Blocked refreshed PR",
            headRefOid: "head2b",
            reviewerApproved: true,
            canReviewerApprove: false,
        });
        expect(pullRequests[1]).toMatchObject({
            number: 1,
            reviewerApproved: true,
            canReviewerApprove: false,
        });
        expect(validatePrNumber("42")).toBe(42);
        for (const value of ["0", "-1", "1.5", "abc", 1]) {
            expect(() => validatePrNumber(value)).toThrow("Invalid pull request number");
        }
    });

    it("drives pull request review, branch update, and reject actions through fake GitHub CLI", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        rememberEnvironment("RAJOHAN_GITHUB_USERNAME");
        const fakeRoot = createTemporaryRoot("mira-pr-actions-root-");
        const fakeBin = createTemporaryRoot("mira-pr-actions-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForPullRequestActions(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "worktree list --porcelain" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");
        process.env.RAJOHAN_GITHUB_TOKEN = "review-token";
        process.env.RAJOHAN_GITHUB_USERNAME = "rajohan";

        const { approvePullRequestReview, rejectPullRequest, updatePullRequestBranch } =
            await import("../src/services/pullRequests.ts");
        const { pullRequestRoutes } = await import("../src/routes/pullRequestRoutes.ts");

        await expect(approvePullRequestReview(3)).resolves.toMatchObject({
            isOk: true,
            message: "PR #3 review approved",
            pullRequest: {
                canReviewerApprove: true,
                number: 3,
                reviewerApproved: false,
            },
        });
        await expect(updatePullRequestBranch(4)).resolves.toMatchObject({
            isOk: true,
            message: "PR #4 branch update started",
            pullRequest: { number: 4 },
        });
        await expect(rejectPullRequest(5, "Not ready")).resolves.toMatchObject({
            cleanup: {
                branch: "close-branch",
                status: "skipped",
            },
            isOk: true,
            message: "PR #5 closed",
        });

        const reviewRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/review-approval"
        ].POST(routeRequest("/api/pull-requests/3/review-approval", { number: "3" }));
        await expect(reviewRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #3 review approved",
        });

        const updateRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/update-branch"
        ].POST(routeRequest("/api/pull-requests/4/update-branch", { number: "4" }));
        await expect(updateRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #4 branch update started",
        });

        const rejectRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/reject"
        ].POST(
            routeRequest(
                "/api/pull-requests/5/reject",
                { number: "5" },
                {
                    body: JSON.stringify({ comment: "Not ready" }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }
            )
        );
        await expect(rejectRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #5 closed",
        });

        await expect(Bun.file(ghLog).text()).resolves.toContain("pr review 3");
        await expect(Bun.file(ghLog).text()).resolves.toContain(
            "repos/rajohan/Mira-Dashboard/pulls/4/update-branch"
        );
        await expect(Bun.file(ghLog).text()).resolves.toContain("pr close 5");
    });

    it("rejects unsafe pull request actions before invoking mutating GitHub commands", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        rememberEnvironment("RAJOHAN_GITHUB_USERNAME");
        const fakeRoot = createTemporaryRoot("mira-pr-validation-root-");
        const fakeBin = createTemporaryRoot("mira-pr-validation-bin-");
        writeFakeGhForPullRequestValidation(path.join(fakeBin, "gh"));
        writeFakeGit(path.join(fakeBin, "git"), fakeRoot);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");
        process.env.RAJOHAN_GITHUB_USERNAME = "rajohan";
        delete process.env.RAJOHAN_GITHUB_TOKEN;

        const {
            approvePullRequest,
            approvePullRequestReview,
            rejectPullRequest,
            updatePullRequestBranch,
        } = await import("../src/services/pullRequests.ts");

        await expect(approvePullRequest(6, false)).rejects.toThrow(
            "Draft pull requests cannot be approved from the dashboard"
        );
        await expect(rejectPullRequest(7, "Wrong base")).rejects.toThrow(
            "Only main-targeted pull requests can be managed here"
        );
        await expect(updatePullRequestBranch(8)).rejects.toThrow(
            "Pull request branch is not behind the base branch"
        );
        await expect(updatePullRequestBranch(9)).rejects.toThrow(
            "Pull request branch has merge conflicts"
        );
        await expect(approvePullRequestReview(10)).rejects.toThrow(
            "Rajohan cannot approve his own pull request"
        );
        await expect(approvePullRequestReview(6)).rejects.toThrow(
            "Draft pull requests cannot be approved from the dashboard"
        );
    });

    it("refreshes weather cache through the Open-Meteo fallback when wttr fails", async () => {
        const originalFetch = fetch;
        const calls: string[] = [];
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: async (input: Parameters<typeof fetch>[0]) => {
                const url = String(input);
                calls.push(url);
                if (url.includes("wttr.in")) {
                    return new Response("unavailable", { status: 503 });
                }
                return Response.json({
                    current: {
                        apparent_temperature: -2,
                        relative_humidity_2m: 80,
                        temperature_2m: 1,
                        weather_code: 61,
                        wind_speed_10m: 12,
                    },
                    daily: {
                        time: ["2026-06-24", "2026-06-25"],
                        temperature_2m_max: [4, 5],
                        temperature_2m_min: [-1, 0],
                        weather_code: [61, 0],
                    },
                });
            },
            writable: true,
        });

        const { refreshWeatherCache } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshWeatherCache()).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });

        expect(calls.some((url) => url.includes("wttr.in"))).toBe(true);
        expect(calls.some((url) => url.includes("api.open-meteo.com"))).toBe(true);
        const row = database
            .prepare(
                "SELECT data_json, source, metadata_json, status FROM cache_entries WHERE key = 'weather.spydeberg'"
            )
            .get() as
            | {
                  data_json: string;
                  metadata_json: string;
                  source: string;
                  status: string;
              }
            | undefined;
        expect(row).toMatchObject({ source: "open-meteo", status: "fresh" });
        expect(JSON.parse(row!.data_json)).toMatchObject({
            description: "Rain",
            location: "Spydeberg",
            temperatureC: 1,
        });
        expect(JSON.parse(row!.metadata_json)).toMatchObject({
            fallbackUsed: true,
            providerPriority: ["wttr.in", "open-meteo"],
        });
    });

    it("drives OpenClaw Gateway client connect and request lifecycle with a fake socket", async () => {
        const originalWebSocket = WebSocket;
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
            FakeGatewayWebSocket.instances = [];
        });
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeGatewayWebSocket,
            writable: true,
        });
        const helloPayloads: unknown[] = [];
        const events: unknown[] = [];
        const { OpenClawGatewayClient } =
            await import("../src/lib/openclawGatewayClient.ts");
        const client = new OpenClawGatewayClient({
            onEvent: (event) => {
                events.push(event);
            },
            onHelloOk: (payload) => {
                helloPayloads.push(payload);
            },
            requestTimeoutMs: 100,
            url: "ws://gateway.test",
        });

        client.start();
        const socket = FakeGatewayWebSocket.instances.at(-1);
        expect(socket).toBeDefined();
        expect(socket?.url).toBe("ws://gateway.test");

        socket?.open();
        socket?.message(
            JSON.stringify({
                event: "connect.challenge",
                payload: { nonce: "nonce-1" },
                type: "event",
            })
        );
        await waitFor(() => socket?.sent.length === 1);
        const connectFrame = JSON.parse(socket!.sent[0]!) as {
            id: string;
            method: string;
            params: { client: { id: string }; role: string };
            type: string;
        };
        expect(connectFrame).toMatchObject({
            method: "connect",
            params: {
                client: { id: "gateway-client" },
                role: "operator",
            },
            type: "req",
        });

        socket?.message(
            JSON.stringify({
                id: connectFrame.id,
                isOk: true,
                payload: { policy: { tickIntervalMs: 5 }, type: "hello-ok" },
                type: "response",
            })
        );
        await waitFor(() => helloPayloads.length === 1);
        socket?.message(JSON.stringify({ event: "tick", seq: 2, type: "event" }));
        await waitFor(() => events.length === 1);
        expect(events).toContainEqual(expect.objectContaining({ event: "tick", seq: 2 }));

        const success = client.request("demo.method", { value: 1 });
        await waitFor(() => socket!.sent.length === 2);
        const successFrame = JSON.parse(socket!.sent[1]!) as { id: string };
        socket?.message(
            JSON.stringify({
                id: successFrame.id,
                ok: true,
                payload: { value: 2 },
                type: "res",
            })
        );
        await expect(success).resolves.toEqual({ value: 2 });

        const failure = client.request("demo.fail");
        await waitFor(() => socket!.sent.length === 3);
        const failureFrame = JSON.parse(socket!.sent[2]!) as { id: string };
        socket?.message(
            JSON.stringify({
                error: { message: "gateway rejected" },
                id: failureFrame.id,
                isOk: false,
                type: "response",
            })
        );
        await expect(failure).rejects.toThrow("gateway rejected");

        client.stop();
        expect(socket?.closeCode).toBe(1000);
    });

    it("reports disconnected gateway state without starting a Gateway client", async () => {
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;

        gateway.shutdown();

        expect(gateway.isConnected()).toBe(false);
        expect(gateway.getStatus()).toEqual({ gateway: "disconnected", sessions: 0 });
        expect(gateway.getGatewayWs()).toBeUndefined();
        await expect(gateway.request("sessions.list", {})).rejects.toThrow(
            "Gateway not connected"
        );
        await expect(
            gateway.sendSessionMessage("agent:main:main", "hello")
        ).rejects.toThrow("Gateway not connected");
        await expect(gateway.abortSessionRun("agent:main:main")).rejects.toThrow(
            "Gateway not connected"
        );
        await expect(gateway.deleteSession("agent:main:main")).rejects.toThrow(
            "Gateway not connected"
        );
    });

    it("returns conflict/not-found errors for clearing inactive backup jobs", async () => {
        const { clearNeedsAttentionBackupJob, mapBackupJob } =
            await import("../src/services/backups.ts");

        expect(mapBackupJob(undefined)).toBeUndefined();
        expect(
            mapBackupJob({
                code: 0,
                completed: Promise.resolve(undefined as never),
                endedAt: 456,
                id: "backup-test",
                startedAt: 123,
                status: "done",
                stderr: "",
                stdout: "ok",
                type: "kopia",
            })
        ).toEqual({
            code: 0,
            endedAt: 456,
            id: "backup-test",
            startedAt: 123,
            status: "done",
            stderr: "",
            stdout: "ok",
            type: "kopia",
        });
        await expect(clearNeedsAttentionBackupJob("kopia")).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(clearNeedsAttentionBackupJob("walg")).rejects.toThrow(
            "WALG backup job not found"
        );
    });

    it("runs manual WAL-G backups through fake Docker and records scheduled metadata", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-docker-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            const job = await startManualBackup("walg");
            const completed = await job.completed;

            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                stdout: expect.stringContaining("backup ok"),
                type: "walg",
            });
            expect(getCurrentBackupJob("walg")).toMatchObject({ status: "done" });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
            await waitFor(() => {
                const row = database
                    .prepare(
                        "SELECT status FROM scheduled_job_runs WHERE job_id = 'backup.walg' ORDER BY id DESC LIMIT 1"
                    )
                    .get() as { status?: string } | undefined;
                return row?.status === "success";
            });
            expect(
                database
                    .prepare(
                        "SELECT status FROM scheduled_job_runs WHERE job_id = 'backup.walg' ORDER BY id DESC LIMIT 1"
                    )
                    .get()
            ).toEqual({ status: "success" });
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("records and clears Kopia needs-attention state when host preflight detects a running process", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-pgrep-bin-");
        const pgrepLog = path.join(fakeBin, "pgrep.log");
        writeFakeDocker(path.join(fakeBin, "docker"));
        writeFakePgrep(path.join(fakeBin, "pgrep"), pgrepLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const {
            clearNeedsAttentionBackupJob,
            getCurrentBackupJob,
            mapBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            await expect(startManualBackup("kopia")).rejects.toMatchObject({
                statusCode: 409,
            });
            expect(mapBackupJob(getCurrentBackupJob("kopia"))).toMatchObject({
                code: 130,
                status: "needs_attention",
                stderr: expect.stringContaining("backup process is still running"),
                type: "kopia",
            });
            await expect(startManualBackup("kopia")).rejects.toThrow(
                "KOPIA backup needs attention"
            );

            const clearedJob = await clearNeedsAttentionBackupJob("kopia");
            expect(mapBackupJob(clearedJob)).toMatchObject({
                status: "needs_attention",
                type: "kopia",
            });
            expect(getCurrentBackupJob("kopia")).toBeUndefined();
            expect(readFileSync(pgrepLog, "utf8")).toContain(
                "-f /opt/docker/apps/kopia/backup.sh"
            );
            await waitFor(() => {
                const row = database
                    .prepare(
                        "SELECT status FROM scheduled_job_runs WHERE job_id = 'backup.kopia' ORDER BY id DESC LIMIT 1"
                    )
                    .get() as { status?: string } | undefined;
                return row?.status === "failed";
            });
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("evaluates log rotation policies in dry-run mode with isolated roots", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-test-");
        const logFile = path.join(rotationRoot, "service.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        writeFileSync(logFile, "line one\nline two\n");
        writeFileSync(
            configFile,
            `${JSON.stringify({
                version: 1,
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "unit",
                        paths: [logFile],
                    },
                ],
            })}\n`
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: true,
            verbose: true,
        });

        expect(summary).toMatchObject({
            checkedFiles: 1,
            checkedGroups: 1,
            isDryRun: true,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(summary.groups).toContainEqual(
            expect.objectContaining({
                checkedFiles: 1,
                name: "unit",
                rotatedFiles: 1,
            })
        );
        await expect(
            runLogRotationService({
                config: path.join(rotationRoot, "missing.json"),
                isDryRun: true,
            })
        ).rejects.toThrow();
    });

    it("reports an active log rotation lock without touching configured log files", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-lock-test-");
        const logFile = path.join(rotationRoot, "locked.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const lockFile = path.join(process.cwd(), "data", "log-rotation.lock");
        mkdirSync(path.dirname(lockFile), { recursive: true });
        writeFileSync(lockFile, `${process.pid}\n`);
        cleanupCallbacks.push(() => {
            rmSync(lockFile, { force: true });
            rmSync(`${lockFile}.reclaim`, { force: true, recursive: true });
        });
        writeFileSync(logFile, "do not rotate\n");
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [{ name: "locked", paths: [logFile] }],
                version: 1,
            })
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
        });

        expect(summary).toMatchObject({
            checkedFiles: 0,
            isDryRun: false,
            isOk: false,
            rotatedFiles: 0,
        });
        expect(summary.errors).toContainEqual({
            message: "Log rotation is already running",
        });
        expect(readFileSync(logFile, "utf8")).toBe("do not rotate\n");
    });

    it("updates agent metadata and rolls active task history forward", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-agent-service-test-");
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const { updateAgentCurrentTask, getLatestCompletedTasks } =
            await import("../src/services/agents.ts");

        const agentId = `agent-${Bun.randomUUIDv7()}`;

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

    it("parses agent config and builds statuses from temp metadata plus fake gateway sessions", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-agent-status-test-");
        const agentsRoot = path.join(openclawRoot, "agents");
        const miraSessions = path.join(agentsRoot, "mira-2026", "sessions");
        const coderSessions = path.join(agentsRoot, "coder", "sessions");
        mkdirSync(miraSessions, { recursive: true });
        mkdirSync(coderSessions, { recursive: true });
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        writeFileSync(
            path.join(openclawRoot, "openclaw.json"),
            JSON.stringify({
                agents: {
                    defaults: {
                        model: { primary: "codex" },
                        models: {
                            "openai/gpt-5.5": { alias: "codex" },
                        },
                    },
                    list: [
                        { default: true, id: "mira-2026" },
                        { id: "coder", model: { primary: "openai/gpt-4.1" } },
                    ],
                },
            })
        );
        writeFileSync(
            path.join(miraSessions, "metadata.json"),
            JSON.stringify({ currentTask: "Temp agent task" })
        );
        writeFileSync(
            path.join(miraSessions, "sessions.json"),
            JSON.stringify([
                {
                    channel: "main",
                    key: "agent:mira-2026:main",
                    sessionId: "session-main",
                    updatedAt: Date.now(),
                },
                { key: 123, updatedAt: "bad" },
            ])
        );

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalGetSessions = gateway.getSessions;
        const originalRequest = gateway.request;
        cleanupCallbacks.push(() => {
            gateway.getSessions = originalGetSessions;
            gateway.request = originalRequest;
        });
        gateway.getSessions = () => [
            {
                agentType: "coder",
                channel: "main",
                createdAt: undefined,
                displayLabel: "Coder",
                displayName: "Coder",
                hookName: "",
                id: "cached",
                key: "agent:coder:main",
                label: "",
                maxTokens: 200_000,
                model: "unknown",
                tokenCount: 0,
                type: "MAIN",
                updatedAt: Date.now(),
            },
        ];
        gateway.request = async (method) => {
            if (method === "sessions.list") {
                return {
                    sessions: [
                        {
                            isRunning: true,
                            key: "agent:mira-2026:main",
                            model: "openai/gpt-5.5",
                            status: "running",
                            updatedAt: Date.now(),
                        },
                        {
                            endedAt: Date.now(),
                            key: "agent:coder:main",
                            model: "openai/gpt-4.1",
                            status: "exited",
                            updatedAt: Date.now() - 120_000,
                        },
                        { key: "", model: "ignored" },
                    ],
                };
            }
            throw new Error(`unexpected gateway method: ${method}`);
        };

        const { buildAgentStatuses, buildSingleAgentStatus, parseAgentsConfig } =
            await import("../src/services/agents.ts");

        expect(parseAgentsConfig()).toMatchObject({
            defaults: { model: { primary: "codex" } },
            list: [{ id: "mira-2026" }, { id: "coder" }],
        });
        const statuses = await buildAgentStatuses(parseAgentsConfig()!);
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentTask: "Temp agent task",
                id: "mira-2026",
                model: "gpt-5.5",
                sessionKey: "agent:mira-2026:main",
                status: "thinking",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                id: "coder",
                model: "gpt-4.1",
                sessionKey: "agent:coder:main",
            })
        );
        await expect(
            buildSingleAgentStatus("missing", parseAgentsConfig()!)
        ).resolves.toBe(undefined);
        await expect(
            buildSingleAgentStatus("coder", parseAgentsConfig()!)
        ).resolves.toMatchObject({
            id: "coder",
            model: "gpt-4.1",
        });

        const originalConsoleError = console.error;
        console.error = () => {};
        cleanupCallbacks.push(() => {
            console.error = originalConsoleError;
        });
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{");
        try {
            expect(parseAgentsConfig()).toBeUndefined();
        } finally {
            console.error = originalConsoleError;
        }
    });

    it("validates exec requests and maps route errors without starting unsafe commands", async () => {
        const { execErrorResponse, getExecJob, runExecOnce, startExecJob } =
            await import("../src/services/execJobs.ts");
        const { execRoutes } = await import("../src/routes/execRoutes.ts");

        await expect(runExecOnce(undefined)).rejects.toThrow(
            "request body must be a JSON object"
        );
        await expect(
            runExecOnce({ args: [], command: "node", shell: true })
        ).rejects.toThrow("args cannot be combined with shell mode");
        await expect(runExecOnce({ args: [], command: "node" })).rejects.toThrow(
            "command executable is not approved"
        );
        const notFoundError = Object.assign(new Error("missing"), { statusCode: 404 });
        expect(execErrorResponse(notFoundError)).toEqual({
            error: "missing",
            status: 404,
        });
        expect(execErrorResponse(new Error("boom"))).toEqual({
            error: "internal server error",
            status: 500,
        });
        expect(() => startExecJob({ command: "node" })).toThrow(
            "args are required unless shell mode is enabled"
        );
        expect(() => getExecJob("missing-job")).toThrow("Exec job not found");

        const invalidPost = await execRoutes["/api/exec"].POST(
            new Request("https://test.local/api/exec", {
                body: JSON.stringify({ command: "node" }),
                method: "POST",
            })
        );
        expect(invalidPost.status).toBe(400);
        await expect(invalidPost.json()).resolves.toEqual({
            error: "args are required unless shell mode is enabled",
        });

        const malformedStart = await execRoutes["/api/exec/start"].POST(
            new Request("https://test.local/api/exec/start", {
                body: "{bad json",
                method: "POST",
            })
        );
        expect(malformedStart.status).toBe(400);
        await expect(malformedStart.json()).resolves.toEqual({
            error: "Invalid JSON",
        });

        const missingJobRequest = Object.assign(
            new Request("https://test.local/api/exec/missing-job"),
            { params: { jobId: "missing-job" } }
        );
        const missingJob = await execRoutes["/api/exec/:jobId"].GET(missingJobRequest);
        expect(missingJob.status).toBe(404);
        await expect(missingJob.json()).resolves.toEqual({
            error: "Exec job not found",
        });

        const stopMissingJob =
            await execRoutes["/api/exec/:jobId/stop"].POST(missingJobRequest);
        expect(stopMissingJob.status).toBe(404);
        await expect(stopMissingJob.json()).resolves.toEqual({
            error: "Exec job not found",
        });
    });

    it("serves OpenClaw config, skill, backup, and restart route contracts with fakes", async () => {
        rememberEnvironment("HOME");
        rememberEnvironment("OPENCLAW_BIN");
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_PACKAGE_ROOT");
        const routeRoot = createTemporaryRoot("mira-openclaw-config-routes-");
        const homeRoot = path.join(routeRoot, "home");
        const openclawHome = path.join(routeRoot, "openclaw-home");
        const packageRoot = path.join(routeRoot, "package-root");
        const fakeBin = path.join(routeRoot, "openclaw");
        mkdirSync(path.join(openclawHome, "workspace", "skills", "workspaceSkill"), {
            recursive: true,
        });
        mkdirSync(path.join(packageRoot, "skills", "builtinSkill"), {
            recursive: true,
        });
        mkdirSync(
            path.join(packageRoot, "dist", "extensions", "demo", "skills", "extraSkill"),
            { recursive: true }
        );
        writeFileSync(
            path.join(openclawHome, "workspace", "skills", "workspaceSkill", "SKILL.md"),
            "---\ndescription: Workspace skill\n---\n"
        );
        writeFileSync(
            path.join(packageRoot, "skills", "builtinSkill", "SKILL.md"),
            "# Builtin skill\n"
        );
        writeFileSync(
            path.join(
                packageRoot,
                "dist",
                "extensions",
                "demo",
                "skills",
                "extraSkill",
                "SKILL.md"
            ),
            "Extra skill body\n"
        );
        writeFakeOpenClaw(fakeBin);
        process.env.HOME = homeRoot;
        process.env.OPENCLAW_BIN = fakeBin;
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.OPENCLAW_PACKAGE_ROOT = packageRoot;

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const patchCalls: unknown[] = [];
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
        });
        gateway.request = async (method, parameters) => {
            if (method === "config.get") {
                return {
                    hash: "hash-1",
                    parsed: {
                        skills: {
                            entries: {
                                configuredOnly: {
                                    description: "Configured only",
                                    enabled: true,
                                },
                                workspaceSkill: { enabled: false },
                            },
                        },
                        theme: "dark",
                    },
                };
            }
            if (method === "config.patch") {
                patchCalls.push(parameters);
                return { hash: "hash-2" };
            }
            throw new Error(`unexpected gateway method: ${method}`);
        };
        const { openclawConfigRoutes } =
            await import("../src/routes/openclawConfigRoutes.ts");

        const configResponse = await openclawConfigRoutes["/api/config"].GET();
        await expect(configResponse.json()).resolves.toMatchObject({
            __hash: "hash-1",
            theme: "dark",
        });

        const validConfigPut = await openclawConfigRoutes["/api/config"].PUT(
            new Request("https://dashboard.test/api/config", {
                body: JSON.stringify({ __hash: "hash-1", theme: "light" }),
                method: "PUT",
            })
        );
        expect(validConfigPut.status).toBe(200);
        expect(patchCalls.at(-1)).toMatchObject({
            baseHash: "hash-1",
            raw: JSON.stringify({ theme: "light" }),
        });

        const skillsResponse = await openclawConfigRoutes["/api/skills"].GET();
        const skillsBody = (await skillsResponse.json()) as {
            skills: Array<{
                description?: string;
                enabled: boolean;
                name: string;
                source: string;
            }>;
        };
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                description: "Workspace skill",
                enabled: false,
                name: "workspaceSkill",
                source: "workspace",
            })
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                enabled: true,
                name: "builtinSkill",
                source: "builtin",
            })
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                enabled: true,
                name: "extraSkill",
                source: "extra",
            })
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                description: "Configured only",
                enabled: true,
                name: "configuredOnly",
                source: "extra",
            })
        );

        const invalidSkillRequest = Object.assign(
            new Request("https://dashboard.test/api/skills/__proto__", {
                body: JSON.stringify({ __hash: "hash-1", enabled: true }),
                method: "POST",
            }),
            { params: { name: "__proto__" } }
        );
        const invalidSkillResponse =
            await openclawConfigRoutes["/api/skills/:name"].POST(invalidSkillRequest);
        expect(invalidSkillResponse.status).toBe(400);

        const validSkillRequest = Object.assign(
            new Request("https://dashboard.test/api/skills/workspaceSkill", {
                body: JSON.stringify({ __hash: "hash-1", enabled: true }),
                method: "POST",
            }),
            { params: { name: "workspaceSkill" } }
        );
        const validSkillResponse =
            await openclawConfigRoutes["/api/skills/:name"].POST(validSkillRequest);
        expect(validSkillResponse.status).toBe(200);
        expect(patchCalls.at(-1)).toMatchObject({
            baseHash: "hash-1",
            raw: JSON.stringify({
                skills: { entries: { workspaceSkill: { enabled: true } } },
            }),
        });

        const backupResponse = await openclawConfigRoutes["/api/backup"].POST();
        await expect(backupResponse.json()).resolves.toMatchObject({
            config: expect.objectContaining({ theme: "dark" }),
            hash: "hash-1",
        });

        const restartResponse = await openclawConfigRoutes["/api/restart"].POST();
        expect(restartResponse.status).toBe(200);
        await expect(restartResponse.json()).resolves.toEqual({ isOk: true });
    });

    it("normalizes cron and session route contracts through a patched gateway", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const routeRoot = createTemporaryRoot("mira-gateway-route-contracts-");
        process.env.OPENCLAW_HOME = path.join(routeRoot, "openclaw-home");
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(
            routeRoot,
            "dashboard-openclaw-home"
        );
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const originalGetSessions = gateway.getSessions;
        const originalAbortSessionRun = gateway.abortSessionRun;
        const originalSendSessionMessage = gateway.sendSessionMessage;
        const originalDeleteSession = gateway.deleteSession;
        const gatewayCalls: Array<{
            method: string;
            parameters: Record<string, unknown>;
        }> = [];

        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
            gateway.getSessions = originalGetSessions;
            gateway.abortSessionRun = originalAbortSessionRun;
            gateway.sendSessionMessage = originalSendSessionMessage;
            gateway.deleteSession = originalDeleteSession;
        });

        gateway.request = async (method, parameters) => {
            gatewayCalls.push({ method, parameters });
            if (method === "cron.list") {
                return {
                    items: [{ enabled: true, id: "heartbeat", name: "Heartbeat" }],
                };
            }
            if (method === "cron.remove" || method === "cron.run") {
                return { method, parameters };
            }
            if (method === "cron.update") {
                return { isOk: true };
            }
            throw new Error(`unexpected gateway method: ${method}`);
        };
        gateway.getSessions = () => [
            {
                agentType: "codex",
                channel: "webchat",
                createdAt: "2026-06-24T10:00:00.000Z",
                displayLabel: "Main",
                displayName: "Main",
                hookName: "",
                id: "agent:main:main",
                key: "agent:main:main",
                label: "Main",
                maxTokens: 200,
                model: "codex",
                tokenCount: 100,
                type: "agent",
                updatedAt: Date.now(),
            },
            {
                agentType: "codex",
                channel: "webchat",
                createdAt: "2026-06-24T09:00:00.000Z",
                displayLabel: "Researcher",
                displayName: "Researcher",
                hookName: "",
                id: "agent:researcher:1",
                key: "agent:researcher:1",
                label: "Researcher",
                maxTokens: 100,
                model: "glm",
                tokenCount: 25,
                type: "agent",
                updatedAt: 0,
            },
        ];
        gateway.abortSessionRun = async (sessionKey) => {
            gatewayCalls.push({ method: "chat.abort", parameters: { sessionKey } });
        };
        gateway.sendSessionMessage = async (sessionKey, message) => {
            gatewayCalls.push({
                method: "chat.send",
                parameters: { message, sessionKey },
            });
        };
        gateway.deleteSession = async (sessionKey) => {
            gatewayCalls.push({ method: "sessions.delete", parameters: { sessionKey } });
            return { deleted: sessionKey };
        };

        const [{ cronRoutes }, { sessionRoutes }] = await Promise.all([
            import("../src/routes/cronRoutes.ts"),
            import("../src/routes/sessionRoutes.ts"),
        ]);

        const cronList = await cronRoutes["/api/cron/jobs"].GET();
        await expect(cronList.json()).resolves.toEqual({
            jobs: [{ enabled: true, id: "heartbeat", name: "Heartbeat" }],
        });
        expect(gatewayCalls).toContainEqual({
            method: "cron.list",
            parameters: { includeDisabled: true },
        });

        const cronDeleteRequest = {
            params: { id: "heartbeat" },
        } as Request & { params: { id: string } };
        const cronDelete =
            await cronRoutes["/api/cron/jobs/:id/delete"].POST(cronDeleteRequest);
        await expect(cronDelete.json()).resolves.toMatchObject({ isOk: true });
        expect(gatewayCalls).toContainEqual({
            method: "cron.remove",
            parameters: { jobId: "heartbeat" },
        });

        const badToggleRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/toggle",
            {
                body: JSON.stringify({ enabled: "yes" }),
                method: "POST",
            }
        );
        const badToggle = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            Object.assign(badToggleRequest, { params: { id: "heartbeat" } })
        );
        expect(badToggle.status).toBe(400);
        await expect(badToggle.json()).resolves.toEqual({
            error: "enabled must be a boolean",
        });

        const validToggleRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/toggle",
            {
                body: JSON.stringify({ enabled: false }),
                method: "POST",
            }
        );
        const validToggle = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            Object.assign(validToggleRequest, { params: { id: "heartbeat" } })
        );
        await expect(validToggle.json()).resolves.toEqual({ isOk: true });
        expect(gatewayCalls).toContainEqual({
            method: "cron.update",
            parameters: { jobId: "heartbeat", patch: { enabled: false } },
        });

        const badUpdateRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/update",
            {
                body: JSON.stringify({ patch: [] }),
                method: "POST",
            }
        );
        const badUpdate = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            Object.assign(badUpdateRequest, { params: { id: "heartbeat" } })
        );
        expect(badUpdate.status).toBe(400);
        await expect(badUpdate.json()).resolves.toEqual({
            error: "patch must be an object",
        });

        const validUpdateRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/update",
            {
                body: JSON.stringify({
                    patch: { name: "Heartbeat every minute", schedule: "*/1 * * * *" },
                }),
                method: "POST",
            }
        );
        const validUpdate = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            Object.assign(validUpdateRequest, { params: { id: "heartbeat" } })
        );
        expect(validUpdate.status).toBe(200);
        await expect(validUpdate.json()).resolves.toEqual({ isOk: true });
        expect(gatewayCalls).toContainEqual({
            method: "cron.update",
            parameters: {
                jobId: "heartbeat",
                patch: { name: "Heartbeat every minute", schedule: "*/1 * * * *" },
            },
        });

        const sessionListRequest = new Request(
            "https://dashboard.test/api/sessions/list?model=codex"
        );
        const sessionList =
            await sessionRoutes["/api/sessions/list"].GET(sessionListRequest);
        await expect(sessionList.json()).resolves.toMatchObject({
            sessions: [expect.objectContaining({ key: "agent:main:main" })],
        });

        const stats = await sessionRoutes["/api/sessions/stats"].GET();
        await expect(stats.json()).resolves.toMatchObject({
            activeInLastHour: 1,
            byModel: { codex: 1, glm: 1 },
            total: 2,
            totalTokens: 125,
        });

        const compactRequest = new Request("https://dashboard.test/api/sessions/action", {
            body: JSON.stringify({ action: "compact" }),
            method: "POST",
        });
        const compact = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(compactRequest, { params: { id: "agent:main:main" } })
        );
        await expect(compact.json()).resolves.toEqual({
            action: "compact",
            isSuccess: true,
        });

        const unsupportedRequest = new Request(
            "https://dashboard.test/api/sessions/action",
            {
                body: JSON.stringify({ action: "sleep" }),
                method: "POST",
            }
        );
        const unsupported = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(unsupportedRequest, { params: { id: "agent:main:main" } })
        );
        expect(unsupported.status).toBe(400);
        await expect(unsupported.json()).resolves.toEqual({
            error: "Unsupported action: sleep",
        });

        const deleteRequest = {
            params: { id: "agent:main:main" },
        } as Request & { params: { id: string } };
        const deleted = await sessionRoutes["/api/sessions/:id"].DELETE(deleteRequest);
        await expect(deleted.json()).resolves.toEqual({
            isSuccess: true,
            result: { deleted: "agent:main:main" },
        });
        expect(gatewayCalls).toContainEqual({
            method: "chat.send",
            parameters: { message: "/compact", sessionKey: "agent:main:main" },
        });
    });

    it("validates Docker route input and maps updater rows without running Docker", async () => {
        const { dockerRoutes } = await import("../src/routes/dockerRoutes.ts");
        const invalidContainerRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/containers/--bad"),
            { params: { containerId: "--bad" } }
        );
        const invalidImageRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/images/--bad", {
                method: "DELETE",
            }),
            { params: { imageId: "--bad" } }
        );
        const invalidVolumeRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/volumes/--bad", {
                method: "DELETE",
            }),
            { params: { volumeName: "--bad" } }
        );
        const invalidServiceRequest = Object.assign(
            new Request(
                "https://dashboard.test/api/docker/updater/services/nope/update",
                {
                    method: "POST",
                }
            ),
            { params: { serviceId: "nope" } }
        );

        const invalidContainerResponse = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(invalidContainerRequest);
        await expect(invalidContainerResponse.json()).resolves.toEqual({
            error: "Invalid containerId",
        });
        expect(
            await dockerRoutes["/api/docker/images/:imageId"].DELETE(invalidImageRequest)
        ).toMatchObject({ status: 400 });
        expect(
            await dockerRoutes["/api/docker/volumes/:volumeName"].DELETE(
                invalidVolumeRequest
            )
        ).toMatchObject({ status: 400 });
        expect(
            await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                invalidServiceRequest
            )
        ).toMatchObject({ status: 400 });

        const missingExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
            Object.assign(new Request("https://dashboard.test/api/docker/exec/missing"), {
                params: { jobId: "missing" },
            })
        );
        expect(missingExec.status).toBe(404);
        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://dashboard.test/api/docker/prune", {
                body: JSON.stringify({ target: "everything" }),
                method: "POST",
            })
        );
        expect(invalidPrune.status).toBe(400);
        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            new Request("https://dashboard.test/api/docker/stack/action", {
                body: JSON.stringify({ action: "remove" }),
                method: "POST",
            })
        );
        expect(invalidStackAction.status).toBe(400);

        const appSlug = `unit-route-${Bun.randomUUIDv7()}`;
        try {
            const service = database
                .prepare(
                    `INSERT INTO docker_managed_services (
                        app_slug, service_name, compose_path, image_repo,
                        compose_image_ref, current_tag, current_digest, latest_tag,
                        latest_digest, policy, pin_mode, enabled, metadata_json,
                        last_checked_at, last_updated_at, last_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id`
                )
                .get(
                    appSlug,
                    "web",
                    "/tmp/compose.yaml",
                    "example.com/unit/web",
                    "example.com/unit/web:1.0.0",
                    "1.0.0",
                    "sha256:old",
                    "1.1.0",
                    "sha256:new",
                    "notify",
                    "tag",
                    0,
                    JSON.stringify({ source: "test" }),
                    "2026-06-24T10:00:00.000Z",
                    "2026-06-24T11:00:00.000Z",
                    "disabled"
                ) as { id: number };
            database
                .prepare(
                    `INSERT INTO docker_update_events (
                        managed_service_id, app_slug, service_name, event_type,
                        from_tag, to_tag, from_digest, to_digest, message,
                        details_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    service.id,
                    appSlug,
                    "web",
                    "update_available",
                    "1.0.0",
                    "1.1.0",
                    "sha256:old",
                    "sha256:new",
                    "ready",
                    "{}",
                    "2026-06-24T12:00:00.000Z"
                );

            const servicesResponse =
                await dockerRoutes["/api/docker/updater/services"].GET();
            const servicesBody = (await servicesResponse.json()) as {
                services: Array<{
                    appSlug: string;
                    enabled: boolean;
                    metadata: Record<string, unknown>;
                    updateAvailable: boolean;
                }>;
                summary: { enabled: number; total: number; updateAvailable: number };
            };
            expect(servicesBody.services).toContainEqual(
                expect.objectContaining({
                    appSlug,
                    enabled: false,
                    metadata: { source: "test" },
                    updateAvailable: true,
                })
            );
            expect(servicesBody.summary.total).toBeGreaterThanOrEqual(1);
            expect(servicesBody.summary.updateAvailable).toBeGreaterThanOrEqual(1);

            const eventsResponse = await dockerRoutes["/api/docker/updater/events"].GET(
                new Request("https://dashboard.test/api/docker/updater/events?limit=1")
            );
            const eventsBody = (await eventsResponse.json()) as {
                events: Array<{ appSlug: string; managedServiceId?: number }>;
            };
            expect(eventsBody.events).toContainEqual(
                expect.objectContaining({
                    appSlug,
                    managedServiceId: service.id,
                })
            );

            const disabledServiceRequest = Object.assign(
                new Request(
                    `https://dashboard.test/api/docker/updater/services/${service.id}/update`,
                    { method: "POST" }
                ),
                { params: { serviceId: String(service.id) } }
            );
            const disabledServiceResponse =
                await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                    disabledServiceRequest
                );
            expect(disabledServiceResponse.status).toBe(400);
            await expect(disabledServiceResponse.json()).resolves.toEqual({
                error: "Updater service is disabled",
            });
        } finally {
            database
                .prepare("DELETE FROM docker_update_events WHERE app_slug = ?")
                .run(appSlug);
            database
                .prepare("DELETE FROM docker_managed_services WHERE app_slug = ?")
                .run(appSlug);
        }
    });

    it("persists, updates, runs, and prunes scheduled jobs", async () => {
        const actionKey = `test-action-${Bun.randomUUIDv7()}`;
        const keepId = `test-job-keep-${Bun.randomUUIDv7()}`;
        const pruneId = `test-job-prune-${Bun.randomUUIDv7()}`;
        const {
            calculateNextRunAt,
            finishScheduledJobRun,
            getScheduledJob,
            isScheduledJobValidationError,
            listScheduledJobRuns,
            registerScheduledJobAction,
            removeScheduledJobsNotInAction,
            runScheduledJob,
            createManualScheduledJobRun,
            updateScheduledJob,
            upsertScheduledJob,
        } = await import("../src/services/scheduledJobs.ts");

        try {
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 90,
                        scheduleType: "interval",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-24T10:01:30.000Z");
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "daily",
                        timeOfDay: "09:30",
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-25T09:30:00.000Z");
            expect(
                calculateNextRunAt(
                    {
                        cronExpression: "*/15 * * * *",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toBe("2026-06-24T10:15:00.000Z");
            expect(() =>
                upsertScheduledJob({
                    actionKey,
                    enabled: true,
                    id: "x",
                    intervalSeconds: 1,
                    name: "Invalid job",
                    scheduleType: "interval",
                })
            ).toThrow("Job id is invalid");

            registerScheduledJobAction(actionKey, (job) => ({
                jobId: job.id,
                payloadValue: job.actionPayload.value,
            }));
            const keepJob = upsertScheduledJob({
                actionKey,
                actionPayload: { value: 42 },
                enabled: true,
                id: keepId,
                intervalSeconds: 120,
                name: "Keep job",
                scheduleType: "interval",
            });
            upsertScheduledJob({
                actionKey,
                id: pruneId,
                intervalSeconds: 120,
                name: "Prune job",
                scheduleType: "interval",
            });

            expect(keepJob.nextRunAt).toBeTruthy();
            expect(getScheduledJob(keepId)).toMatchObject({
                actionPayload: { value: 42 },
                enabled: true,
                id: keepId,
            });
            expect(updateScheduledJob(keepId, { enabled: false })).toMatchObject({
                enabled: false,
                nextRunAt: undefined,
            });

            const manualRun = createManualScheduledJobRun(keepId);
            expect(() => createManualScheduledJobRun(keepId)).toThrow(
                "Scheduled job is already running"
            );
            finishScheduledJobRun(manualRun, "success", undefined, { manual: true });

            const result = await runScheduledJob(keepId);
            expect(result).toMatchObject({
                jobId: keepId,
                output: { jobId: keepId, payloadValue: 42 },
                status: "success",
                triggerType: "manual",
            });
            expect(listScheduledJobRuns(keepId, 2)).toHaveLength(2);

            removeScheduledJobsNotInAction(actionKey, [keepId]);
            expect(getScheduledJob(keepId)).toBeDefined();
            expect(getScheduledJob(pruneId)).toBeUndefined();

            const missingActionId = `test-job-missing-action-${Bun.randomUUIDv7()}`;
            upsertScheduledJob({
                actionKey: `missing-action-${Bun.randomUUIDv7()}`,
                id: missingActionId,
                intervalSeconds: 120,
                name: "Missing action",
                scheduleType: "interval",
            });
            try {
                await runScheduledJob(missingActionId);
                throw new Error("Expected missing action to fail");
            } catch (error) {
                expect(isScheduledJobValidationError(error)).toBe(true);
                expect(error).toHaveProperty(
                    "message",
                    expect.stringContaining("No scheduled job action registered")
                );
            }
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'test-job-%'")
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'test-job-%'")
                .run();
        }
    });
});
