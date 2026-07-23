import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import type { DashboardSocket } from "../src/dashboardSocket.ts";
import { database, sqlNullable } from "../src/database.ts";
import * as processModule from "../src/lib/processes.ts";

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

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

function readableUtf8Stream(value: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
        },
    });
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

function writeFakeGhForPullRequestMerge(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1 $2 $3" == "pr view 11" ]]; then
  printf '%s\n' '{"number":11,"title":"Merge me","body":"","url":"https://github.test/pr/11","headRefName":"merge-branch","headRefOid":"head11","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr merge 11" ]]; then
  printf 'merged\n'
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
if [[ "$*" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"backup_name":"base_0001","finish_time":"$now","start_time":"$now","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
  exit 0
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

function writeFailingWalgPreflightDocker(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "pgrep failed" >&2
  exit 2
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  printf '[]\n'
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeRunningWalgPreflightDocker(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '23456\n'
  exit 0
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  printf '[]\n'
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
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
    sendError: Error | undefined;

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
        if (this.sendError) {
            throw this.sendError;
        }
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

async function startTestScheduledExecutor(): Promise<void> {
    const { startScheduledJobExecutor, stopScheduledJobExecutor } =
        await import("../src/services/scheduledJobs.ts");
    startScheduledJobExecutor();
    cleanupCallbacks.push(stopScheduledJobExecutor);
}

afterEach(async () => {
    const errors: unknown[] = [];
    while (cleanupCallbacks.length > 0) {
        try {
            await cleanupCallbacks.pop()?.();
        } catch (error) {
            errors.push(error);
        }
    }
    database
        .prepare(
            `DELETE FROM job_executions
             WHERE scheduled_job_id LIKE 'backup.%'
                OR action_key = 'backup.clear-attention'`
        )
        .run();
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
            createFirstUser,
            createUser,
            deleteSession,
            findUserByUsername,
            getAuthUserFromSessionId,
            getPersistedGatewayToken,
            hashPassword,
            verifyPassword,
            persistGatewayToken,
        } = await import("../src/auth.ts");

        try {
            const hash = await hashPassword("correct horse battery staple");
            expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
            expect(await verifyPassword("wrong password", hash)).toBe(false);
            expect(await verifyPassword("password", "not-a-valid-hash")).toBe(false);

            const user = await createUser(username, "test-password");
            expect(user).toMatchObject({ username: normalizedUsername });
            const originalHashPassword = Bun.password.hash;
            cleanupCallbacks.push(() => {
                Bun.password.hash = originalHashPassword;
            });
            Bun.password.hash = () => {
                throw new Error("Password hashing should not run after bootstrap closes");
            };
            await expect(
                createFirstUser(`first-${username}`, "correct-password")
            ).resolves.toBeUndefined();
            Bun.password.hash = originalHashPassword;

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
            path.parse(tmpdir()).root,
            "mira-dashboard-non-temporary-test",
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

    it("formats OpenClaw log dates in the app timezone regardless of host TZ", async () => {
        rememberEnvironment("TZ");
        const { formatOpenClawLogDate } = await import("../src/lib/logRoots.ts");
        const osloOnlyDate = new Date("2026-06-27T22:30:00.000Z");

        process.env.TZ = "UTC";
        expect(formatOpenClawLogDate(osloOnlyDate)).toBe("2026-06-28");

        process.env.TZ = "Not/A_Real_Zone";
        expect(() => formatOpenClawLogDate(osloOnlyDate)).not.toThrow();
        expect(formatOpenClawLogDate(osloOnlyDate)).toBe("2026-06-28");
    });

    it("sends log history to subscribers from the configured isolated log root", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-streams-test-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;

        const { formatOpenClawLogDate } = await import("../src/lib/logRoots.ts");
        const today = formatOpenClawLogDate(new Date());
        const logFile = path.join(logsRoot, `openclaw-${today}.log`);
        writeFileSync(logFile, "first line\nsecond line\n");

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

            expect(messages).toContainEqual({
                type: "log",
                history: true,
                line: "first line",
                lineId: "0",
            });
            expect(messages).toContainEqual({
                type: "log",
                history: true,
                line: "second line",
                lineId: "11",
            });
            expect(messages).toContainEqual({
                type: "log_history_complete",
                count: 2,
            });

            unsubscribeFromLogs(socket);
            messages.length = 0;
            const multibytePrefix = "aé";
            const historyWindowBytes = 128 * 1024;
            const multibyteHistoryLine =
                "history boundary " +
                "z".repeat(
                    historyWindowBytes - Buffer.byteLength("\nhistory boundary \n") - 1
                );
            writeFileSync(logFile, `${multibytePrefix}\n${multibyteHistoryLine}\n`);
            subscribeToLogs(socket);
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (message as { type?: unknown }).type === "log_history_complete"
                )
            );

            const historyCompleteIndex = messages.findIndex(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    (message as { type?: unknown }).type === "log_history_complete"
            );
            expect(
                messages
                    .slice(0, historyCompleteIndex)
                    .filter(
                        (message) =>
                            typeof message === "object" &&
                            message !== null &&
                            (message as { type?: unknown }).type === "log"
                    )
            ).toEqual([
                {
                    type: "log",
                    history: true,
                    line: multibyteHistoryLine,
                    lineId: String(Buffer.byteLength(multibytePrefix) + 1),
                },
            ]);
            expect(messages[historyCompleteIndex]).toEqual({
                type: "log_history_complete",
                count: 1,
            });

            appendFileSync(logFile, "third line\n");
            await waitFor(
                () =>
                    messages.some((message) =>
                        JSON.stringify(message).includes("third line")
                    ),
                2500
            );
            expect(messages).toContainEqual({ type: "log", line: "third line" });
        } finally {
            unsubscribeFromLogs(socket);
        }
    });

    it("completes log history when today's file is missing and ignores subscriber send errors", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-streams-empty-test-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        const originalConsoleError = console.error;
        Object.defineProperty(console, "error", {
            configurable: true,
            value: () => {},
            writable: true,
        });

        const messages: unknown[] = [];
        const socket = {
            send: (message: string) => {
                messages.push(JSON.parse(message) as unknown);
            },
        } as DashboardSocket;
        const throwingSocket = {
            send: () => {
                throw new Error("subscriber closed");
            },
        } as unknown as DashboardSocket;
        const { subscribeToLogs, unsubscribeFromLogs } =
            await import("../src/services/logStreams.ts");

        subscribeToLogs(socket);
        subscribeToLogs(throwingSocket);
        try {
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (message as { type?: unknown }).type === "log_history_complete"
                )
            );
            expect(messages).toContainEqual({
                type: "log_history_complete",
                count: 0,
            });
        } finally {
            unsubscribeFromLogs(socket);
            unsubscribeFromLogs(throwingSocket);
            Object.defineProperty(console, "error", {
                configurable: true,
                value: originalConsoleError,
                writable: true,
            });
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
        const { cacheRoutes } = await import("../src/routes/cacheRoutes.ts");
        await expect(refreshCacheProducer("unknown.cache.key")).rejects.toThrow(
            "No backend refresh producer configured for cache key"
        );
        const unknownRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/unknown.cache.key/refresh",
                    {
                        method: "POST",
                    }
                ),
                { params: { key: "unknown.cache.key" } }
            )
        );
        expect(unknownRefresh.status).toBe(400);
        await expect(unknownRefresh.json()).resolves.toEqual({
            error: "No backend refresh producer configured for cache key: unknown.cache.key",
        });
        const missingCacheKey = await cacheRoutes["/api/cache/:key"].GET(
            Object.assign(new Request("https://dashboard.test/api/cache/%20"), {
                params: { key: " " },
            })
        );
        expect(missingCacheKey.status).toBe(400);
        await expect(missingCacheKey.json()).resolves.toEqual({
            error: "Missing cache key",
        });

        const controller = new AbortController();
        controller.abort();
        await expect(
            refreshCacheProducer("weather.spydeberg", controller.signal)
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(waitForLocalCacheSeed("missing.key")).resolves.toBeUndefined();
    });

    it("refreshes supported cache keys through the cache route", async () => {
        const { waitForLocalCacheSeed } = await import("../src/services/cacheRefresh.ts");
        try {
            await waitForLocalCacheSeed("weather.spydeberg");
        } catch {
            // Startup seeding is best-effort; this test replaces it with a mock refresh.
        }
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.startsWith("https://wttr.in/Spydeberg")) {
                return Response.json({
                    current_condition: [
                        {
                            FeelsLikeC: "8",
                            humidity: "75",
                            temp_C: "10",
                            weatherCode: "116",
                            weatherDesc: [{ value: "Partly cloudy" }],
                            windspeedKmph: "14",
                        },
                    ],
                    nearest_area: [{ areaName: [{ value: "Spydeberg" }] }],
                    weather: [
                        {
                            date: "2026-06-26",
                            maxtempC: "18",
                            mintempC: "7",
                            hourly: [
                                {
                                    weatherCode: "116",
                                    weatherDesc: [{ value: "Partly cloudy" }],
                                },
                            ],
                        },
                    ],
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());

        const { registerCacheRefreshScheduledJobs } =
            await import("../src/services/cacheRefresh.ts");
        registerCacheRefreshScheduledJobs({ seedStrategy: "none" });
        await startTestScheduledExecutor();
        const { cacheRoutes } = await import("../src/routes/cacheRoutes.ts");
        const response = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    { method: "POST" }
                ),
                { params: { key: "weather.spydeberg" } }
            )
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            entry: {
                data: {
                    description: "Partly cloudy",
                    location: "Spydeberg",
                    temperatureC: 10,
                },
                key: "weather.spydeberg",
                source: "wttr.in",
                status: "fresh",
            },
            isOk: true,
        });
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

    it("rejects active deployment locks before starting deploy work", async () => {
        const jobId = `test-deploy-active-${Bun.randomUUIDv7()}`;
        const staleOwner = `test-deploy-stale-owner-${Bun.randomUUIDv7()}`;
        database
            .prepare(
                `INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                jobId,
                "building",
                new Date().toISOString(),
                new Date().toISOString(),
                sqlNullable(undefined),
                sqlNullable(undefined),
                "active",
                "",
                ""
            );
        database
            .prepare(
                "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
            )
            .run(jobId, new Date().toISOString());

        try {
            const { startDeployLatest } = await import("../src/services/pullRequests.ts");
            expect(() => startDeployLatest()).toThrow(
                `Dashboard deploy already in progress (${jobId})`
            );
            expect(() => startDeployLatest(staleOwner)).toThrow(
                "Dashboard deploy lock handoff failed"
            );
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(jobId);
        }
    });

    it("keeps queued deployment locks active beyond the legacy stale window", async () => {
        const { startDeployLatest } = await import("../src/services/pullRequests.ts");
        const { cancelJobExecution } =
            await import("../src/services/jobExecutionQueue.ts");
        const first = startDeployLatest();
        let replacementId: string | undefined;
        try {
            database
                .prepare("UPDATE deployment_jobs SET updated_at = ? WHERE id = ?")
                .run("2026-01-01T00:00:00.000Z", first.id);
            database
                .prepare("UPDATE deployment_lock SET updated_at = ? WHERE job_id = ?")
                .run("2026-01-01T00:00:00.000Z", first.id);

            expect(() => startDeployLatest()).toThrow(
                `Dashboard deploy already in progress (${first.id})`
            );

            const firstExecution = database
                .prepare(
                    `SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`
                )
                .get(first.id) as { id: string };
            cancelJobExecution(firstExecution.id);
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(first.id)
            ).toEqual({
                note: "Deploy cancelled before execution",
                status: "failed",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();

            const replacement = startDeployLatest();
            replacementId = replacement.id;
            expect(replacement.id).not.toBe(first.id);
        } finally {
            const deploymentIds = [first.id, replacementId].filter((id): id is string =>
                Boolean(id)
            );
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            for (const deploymentId of deploymentIds) {
                database
                    .prepare(
                        `DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`
                    )
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });

    it("fails deployments and releases their locks when worker leases expire", async () => {
        const { startDeployLatest } = await import("../src/services/pullRequests.ts");
        const { getJobExecution, recoverExpiredJobExecutions } =
            await import("../src/services/jobExecutionQueue.ts");
        const deployment = startDeployLatest();
        let replacementId: string | undefined;
        try {
            const execution = database
                .prepare(
                    `SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`
                )
                .get(deployment.id) as { id: string };
            database
                .prepare(
                    `UPDATE job_executions
                     SET status = 'running', started_at = ?, heartbeat_at = ?,
                         lease_owner = ?, lease_expires_at = ?, attempt = 1
                     WHERE id = ?`
                )
                .run(
                    "2100-01-01T00:00:00.000Z",
                    "2100-01-01T00:00:00.000Z",
                    "missing-deploy-worker",
                    "2100-01-01T00:02:00.000Z",
                    execution.id
                );

            expect(recoverExpiredJobExecutions("2100-01-01T00:03:00.000Z")).toBe(1);
            expect(getJobExecution(execution.id)).toMatchObject({
                message: "Job failed after its worker lease expired",
                status: "failed",
            });
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(deployment.id)
            ).toEqual({
                note: "Deploy failed after its worker lease expired",
                status: "failed",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();

            const replacement = startDeployLatest();
            replacementId = replacement.id;
            expect(replacement.status).toBe("building");
        } finally {
            const deploymentIds = [deployment.id, replacementId].filter(
                (id): id is string => Boolean(id)
            );
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            for (const deploymentId of deploymentIds) {
                database
                    .prepare(
                        `DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`
                    )
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });

    it("reserves the deployment lock while a pull request approval is queued", async () => {
        const { runPullRequestApproval, startDeployLatest } =
            await import("../src/services/pullRequests.ts");
        const { cancelJobExecution } =
            await import("../src/services/jobExecutionQueue.ts");
        const approval = runPullRequestApproval(11, false);
        let approvalExecutionId: string | undefined;
        let deploymentId: string | undefined;
        try {
            const execution = database
                .prepare(
                    `SELECT id
                     FROM job_executions
                     WHERE action_key = 'github.merge'
                     ORDER BY queued_at DESC, id DESC
                     LIMIT 1`
                )
                .get() as { id: string };
            approvalExecutionId = execution.id;
            expect(() => startDeployLatest()).toThrow(
                "Dashboard deploy already in progress"
            );

            cancelJobExecution(execution.id);
            await expect(approval).rejects.toThrow("Job cancelled before execution");

            const deployment = startDeployLatest();
            deploymentId = deployment.id;
            expect(deployment.status).toBe("building");
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            if (approvalExecutionId) {
                database
                    .prepare("DELETE FROM job_executions WHERE id = ?")
                    .run(approvalExecutionId);
            }
            if (deploymentId) {
                database
                    .prepare(
                        `DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`
                    )
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });

    it("runs deploy latest build flow against an isolated checkout", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-deploy-root-");
        const fakeBin = createTemporaryRoot("mira-pr-deploy-bin-");
        const gitLog = path.join(fakeRoot, "git.log");
        const bunLog = path.join(fakeRoot, "bun.log");
        const systemdLog = path.join(fakeRoot, "systemd.log");
        mkdirSync(path.join(fakeRoot, "backend", "node_modules"), { recursive: true });
        mkdirSync(path.join(fakeRoot, "node_modules"), { recursive: true });
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(fakeRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'def5678\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" || "$*" == "pull --ff-only origin main" ]]; then
  printf ''
elif [[ "$*" == "log -1 --pretty=%s" ]]; then
  printf 'Deployable dashboard commit\n'
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        writeFileSync(
            path.join(fakeBin, "bun"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >> ${JSON.stringify(bunLog)}
if [[ "$*" == "install --frozen-lockfile" || "$*" == "run build" ]]; then
  printf 'ok\n'
else
  echo "unexpected bun args: $*" >&2
  exit 2
fi
`
        );
        writeFileSync(
            path.join(fakeBin, "systemd-run"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(systemdLog)}
printf 'scheduled\n'
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        chmodSync(path.join(fakeBin, "bun"), 0o755);
        chmodSync(path.join(fakeBin, "systemd-run"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");

        const { registerPullRequestExecutionActions, startDeployLatest } =
            await import("../src/services/pullRequests.ts");
        registerPullRequestExecutionActions();
        await startTestScheduledExecutor();
        const job = startDeployLatest();

        try {
            await waitFor(() => {
                const row = database
                    .prepare(
                        "SELECT status, commit_sha, commit_title, note FROM deployment_jobs WHERE id = ?"
                    )
                    .get(job.id) as
                    | {
                          commit_sha: string | null;
                          commit_title: string | null;
                          note: string | null;
                          status: string;
                      }
                    | undefined;
                return row?.status === "restart-scheduled" && existsSync(systemdLog);
            }, 5000);

            const row = database
                .prepare(
                    "SELECT status, commit_sha, commit_title, note FROM deployment_jobs WHERE id = ?"
                )
                .get(job.id) as {
                commit_sha: string | null;
                commit_title: string | null;
                note: string | null;
                status: string;
            };
            expect(row).toEqual({
                commit_sha: "def5678",
                commit_title: "Deployable dashboard commit",
                note: "Build passed; restart + health check scheduled",
                status: "restart-scheduled",
            });
            await expect(Bun.file(gitLog).text()).resolves.toContain(
                "pull --ff-only origin main"
            );
            await expect(Bun.file(bunLog).text()).resolves.toContain(
                `${fakeRoot}|install --frozen-lockfile`
            );
            await expect(Bun.file(bunLog).text()).resolves.toContain(
                `${path.join(fakeRoot, "backend")}|run build`
            );
            await expect(Bun.file(systemdLog).text()).resolves.toContain(
                `mira-dashboard-deploy-${job.id}`
            );
            expect(existsSync(path.join(fakeRoot, "node_modules"))).toBe(false);
            expect(existsSync(path.join(fakeRoot, "backend", "node_modules"))).toBe(
                false
            );
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE job_id = ?").run(job.id);
            database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(job.id);
            database
                .prepare(
                    "DELETE FROM job_executions WHERE action_key = 'dashboard.deploy' AND payload_json LIKE ?"
                )
                .run(`%${job.id}%`);
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

        const {
            approvePullRequestReview,
            registerPullRequestExecutionActions,
            rejectPullRequest,
            updatePullRequestBranch,
        } = await import("../src/services/pullRequests.ts");
        registerPullRequestExecutionActions();
        await startTestScheduledExecutor();
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

        const defaultRejectRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/reject"
        ].POST(routeRequest("/api/pull-requests/5/reject", { number: "5" }));
        await expect(defaultRejectRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #5 closed",
        });

        const malformedApproveRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/approve"
        ].POST(
            routeRequest(
                "/api/pull-requests/3/approve",
                { number: "3" },
                {
                    body: "{",
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }
            )
        );
        expect(malformedApproveRoute.status).toBe(400);
        await expect(malformedApproveRoute.json()).resolves.toMatchObject({
            error: expect.stringContaining("JSON"),
        });

        await expect(Bun.file(ghLog).text()).resolves.toContain("pr review 3");
        await expect(Bun.file(ghLog).text()).resolves.toContain(
            "repos/rajohan/Mira-Dashboard/pulls/4/update-branch"
        );
        await expect(Bun.file(ghLog).text()).resolves.toContain("pr close 5");
        await expect(Bun.file(ghLog).text()).resolves.toContain(
            "Closed from Mira Dashboard after Rajohan rejected it."
        );
    });

    it("merges an approved pull request and removes its clean local worktree safely", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_USERNAME");
        const fakeRoot = createTemporaryRoot("mira-pr-merge-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const localWorktree = path.join(worktreeRoot, "merge-branch");
        const fakeBin = createTemporaryRoot("mira-pr-merge-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        mkdirSync(localWorktree, { recursive: true });
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(fakeRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'abc1234\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree list --porcelain" ]]; then
  printf 'worktree %s\nHEAD abc1234\nbranch refs/heads/merge-branch\n\n' ${JSON.stringify(localWorktree)}
elif [[ "$*" == "-C ${localWorktree} status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree remove ${localWorktree}" ]]; then
  rm -rf ${JSON.stringify(localWorktree)}
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" || "$*" == "pull --ff-only origin main" ]]; then
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
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        process.env.RAJOHAN_GITHUB_USERNAME = "rajohan";

        try {
            const { approvePullRequest } =
                await import("../src/services/pullRequests.ts");
            const result = await approvePullRequest(11, false);

            expect(result).toMatchObject({
                cleanup: {
                    branch: "merge-branch",
                    message: "Removed local worktree for merge-branch",
                    status: "removed",
                },
                isOk: true,
                message: "PR #11 merged",
                syncError: undefined,
            });
            await expect(Bun.file(ghLog).text()).resolves.toContain("pr merge 11");
            await expect(Bun.file(gitLog).text()).resolves.toContain("worktree remove");
            expect(existsSync(localWorktree)).toBe(false);
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare("DELETE FROM deployment_jobs WHERE id LIKE 'approve-%'")
                .run();
        }
    });

    it("reports a successful merge separately from a failed production sync", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_USERNAME");
        const fakeRoot = createTemporaryRoot("mira-pr-sync-fail-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-sync-fail-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(fakeRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'abc1234\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree list --porcelain" ]]; then
  printf ''
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" ]]; then
  printf ''
elif [[ "$*" == "pull --ff-only origin main" ]]; then
  echo 'remote moved unexpectedly' >&2
  exit 1
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        process.env.RAJOHAN_GITHUB_USERNAME = "rajohan";

        try {
            const { approvePullRequest } =
                await import("../src/services/pullRequests.ts");
            const result = await approvePullRequest(11, true);

            expect(result).toMatchObject({
                cleanup: {
                    branch: "merge-branch",
                    status: "skipped",
                },
                deployment: undefined,
                deployError: undefined,
                isOk: true,
                message: "PR #11 merged; production sync failed",
                syncError: expect.stringContaining("remote moved unexpectedly"),
            });
            await expect(Bun.file(ghLog).text()).resolves.toContain("pr merge 11");
            await expect(Bun.file(gitLog).text()).resolves.toContain(
                "pull --ff-only origin main"
            );
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare("DELETE FROM deployment_jobs WHERE id LIKE 'approve-%'")
                .run();
        }
    });

    it("rejects oversized GitHub JSON stream rows when listing pull requests", async () => {
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 12_345,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(`${"x".repeat(1024 * 1024 + 1)}\n`),
                }) as unknown as processModule.BunProcess
        );
        const killSpy = jest
            .spyOn(processModule, "killProcessGroup")
            .mockImplementation(() => {});

        try {
            const { listDashboardPullRequests } =
                await import("../src/services/pullRequests.ts");
            await expect(listDashboardPullRequests()).rejects.toThrow(
                "GitHub CLI JSON line was too large"
            );
            expect(killSpy).toHaveBeenCalledWith(expect.any(Object), "SIGTERM");
        } finally {
            spawnSpy.mockRestore();
            killSpy.mockRestore();
        }
    });

    it("maps pull request route validation and GitHub list failures to JSON errors", async () => {
        const { pullRequestRoutes } = await import("../src/routes/pullRequestRoutes.ts");
        const invalidNumber = await pullRequestRoutes[
            "/api/pull-requests/:number/review-approval"
        ].POST(
            routeRequest("/api/pull-requests/nope/review-approval", { number: "nope" })
        );
        expect(invalidNumber.status).toBe(400);
        await expect(invalidNumber.json()).resolves.toEqual({
            error: "Invalid pull request number",
        });

        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(2),
                    kill: () => {},
                    pid: 12_345,
                    stderr: readableUtf8Stream("graphql unavailable\n"),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            const listResponse = await pullRequestRoutes["/api/pull-requests"].GET();
            expect(listResponse.status).toBe(500);
            await expect(listResponse.json()).resolves.toEqual({
                error: "graphql unavailable",
            });
        } finally {
            spawnSpy.mockRestore();
        }
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

    it("refreshes git cache from sanitized command output", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'git.workspace'")
                .run();
        });
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (file, arguments_) => {
                expect(file).toBe("git");
                const gitArguments = [...arguments_];
                let repo = "";
                let commandArguments = gitArguments;
                if (gitArguments[0] === "-C") {
                    repo = String(gitArguments[1]);
                    commandArguments = gitArguments.slice(2);
                }
                const command = commandArguments.join(" ");
                if (command === "rev-parse --is-inside-work-tree") {
                    return { code: 0, stderr: "", stdout: "true\n" };
                }
                if (command === "branch --show-current") {
                    return { code: 0, stderr: "", stdout: "main\n" };
                }
                if (command === "rev-parse HEAD") {
                    return { code: 0, stderr: "", stdout: "abcdef1234567890\n" };
                }
                if (command === "remote -v") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            `origin\thttps://token@example.com/${path.basename(repo)}.git (fetch)`,
                            `origin\tgit@example.com:${path.basename(repo)}.git (push)`,
                            "",
                        ].join("\n"),
                    };
                }
                if (command === "status --short") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            " M modified.txt",
                            "A  staged.txt",
                            "D  deleted.txt",
                            "R  old.txt -> new.txt",
                            "?? untracked.txt",
                            "UU conflicted.txt",
                            "",
                        ].join("\n"),
                    };
                }
                return {
                    code: 2,
                    stderr: `unexpected git args for ${repo}: ${command}`,
                    stdout: "",
                };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        const { refreshGitCache } = await import("../src/services/cacheRefresh.ts");

        const result = await refreshGitCache();

        expect(result).toEqual({ refreshed: ["git.workspace"] });
        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'git.workspace'"
            )
            .get() as { data_json: string; metadata_json: string; status: string };
        expect(row.status).toBe("fresh");
        const data = JSON.parse(row.data_json) as {
            dirtyCount: number;
            dirtyRepos: string[];
            missingRepos: string[];
            repos: Array<{
                branch?: string;
                dirty: boolean;
                exists: boolean;
                key: string;
                remote?: string;
                statusSummary: Record<string, number>;
                statusTruncated?: boolean;
            }>;
        };
        expect(data.dirtyRepos).toEqual(["openclaw", "mira-dashboard", "docker"]);
        expect(data.missingRepos).toEqual([]);
        expect(data.dirtyCount).toBe(3);
        expect(data.repos.find((repo) => repo.key === "mira-dashboard")).toMatchObject({
            branch: "main",
            dirty: true,
            exists: true,
            remote: "https://example.com/mira-dashboard.git",
            statusSummary: {
                conflicted: 1,
                deleted: 1,
                modified: 1,
                renamed: 1,
                staged: 3,
                total: 6,
                untracked: 1,
            },
            statusTruncated: false,
        });
        expect(JSON.parse(row.metadata_json)).toMatchObject({
            summary: {
                dirtyCount: 3,
                dirtyRepos: ["openclaw", "mira-dashboard", "docker"],
                missingRepos: [],
                repoCount: 3,
            },
        });
    });

    it("refreshes quota cache from provider and Codex status output", async () => {
        for (const key of [
            "OPENROUTER_API_KEY",
            "ELEVENLABS_API_KEY",
            "SYNTHETIC_API_KEY",
            "QUOTAS_CODEX_HOME",
            "CODEX_BIN",
        ]) {
            rememberEnvironment(key);
        }
        const codexHome = createTemporaryRoot("mira-quota-codex-home-");
        process.env.OPENROUTER_API_KEY = "openrouter-key";
        process.env.ELEVENLABS_API_KEY = "elevenlabs-key";
        process.env.SYNTHETIC_API_KEY = "synthetic-key";
        process.env.QUOTAS_CODEX_HOME = codexHome;
        process.env.CODEX_BIN = "/usr/local/bin/codex";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = String(input);
            if (url === "https://openrouter.ai/api/v1/key") {
                return Response.json({
                    data: { usage: 2, usage_monthly: 7 },
                });
            }
            if (url === "https://openrouter.ai/api/v1/credits") {
                return Response.json({
                    data: { total_credits: 10 },
                });
            }
            if (url === "https://api.elevenlabs.io/v1/user") {
                return Response.json({
                    subscription: {
                        character_count: 250,
                        character_limit: 1000,
                        next_character_count_reset_unix: 1_800_000_000,
                        tier: "creator",
                    },
                });
            }
            if (url === "https://api.synthetic.new/v2/quotas") {
                return Response.json({
                    rollingFiveHourLimit: {
                        limited: false,
                        max: 100,
                        nextTickAt: "soon",
                        remaining: 75,
                        tickPercent: 10,
                    },
                    search: {
                        hourly: {
                            limit: 20,
                            renewsAt: "later",
                            requests: 5,
                        },
                    },
                    subscription: {
                        limit: 50,
                        renewsAt: "tomorrow",
                        requests: 10,
                    },
                    weeklyTokenLimit: {
                        maxCredits: "$100.00",
                        nextRegenAt: "weekly",
                        nextRegenCredits: "$20.00",
                        remainingCredits: "$40.00",
                    },
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValueOnce({
                code: 0,
                stderr: "",
                stdout: [
                    "5h limit: loading",
                    "Weekly limit: 65% left (resets Monday)",
                ].join("\n"),
            })
            .mockResolvedValue({
                code: 0,
                stderr: "",
                stdout: [
                    "Account: raymond@example.com",
                    "Model: gpt-5.5 (high)",
                    "5h limit: 80% left (resets 13:00)",
                    "Weekly limit: 65% left (resets Monday)",
                    "",
                ].join("\n"),
            });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");

        expect(
            await refreshCacheProducer("quotas.summary", undefined, { force: true })
        ).toEqual({ refreshed: ["quotas.summary"] });

        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'quotas.summary'"
            )
            .get() as { data_json: string; metadata_json: string; status: string };
        expect(row.status).toBe("fresh");
        expect(runProcessSpy).toHaveBeenCalledTimes(2);
        expect(runProcessSpy.mock.calls[0]?.[1]?.[1]).toContain(
            'grep -Eiq "Weekly limit:"'
        );
        const data = JSON.parse(row.data_json);
        expect(data.openrouter).toMatchObject({
            percentUsed: 20,
            remaining: 8,
            totalCredits: 10,
            usage: 2,
            usageMonthly: 7,
        });
        expect(data.elevenlabs).toMatchObject({
            percentUsed: 25,
            remaining: 750,
            tier: "creator",
            total: 1000,
            used: 250,
        });
        expect(data.synthetic).toMatchObject({
            rollingFiveHourLimit: { percentUsed: 25, remaining: 75 },
            searchHourly: { percentUsed: 25, remaining: 15 },
            subscription: { percentUsed: 20, remaining: 40 },
            weeklyTokenLimit: {
                nextRegenPercent: 20,
                percentRemaining: 40,
            },
        });
        expect(data.openai).toMatchObject({
            fiveHourLeftPercent: 80,
            percentUsed: 35,
            weeklyLeftPercent: 65,
        });
        expect(data.openai.account).toBeUndefined();
        expect(JSON.parse(row.metadata_json)).toMatchObject({
            missing: [],
            producers: ["openrouter", "elevenlabs", "synthetic", "openai"],
        });

        runProcessSpy.mockReset().mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: [
                "Account: raymond@example.com",
                "Model: gpt-5.6-sol (max)",
                "Weekly limit: 65% left (resets Monday)",
                "",
            ].join("\n"),
        });
        await refreshCacheProducer("quotas.summary", undefined, { force: true });
        expect(runProcessSpy).toHaveBeenCalledTimes(1);
        const weeklyOnlyQuota = JSON.parse(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as { data_json: string }
            ).data_json
        );
        expect(weeklyOnlyQuota.openai).toMatchObject({
            percentUsed: 35,
            weeklyLeftPercent: 65,
        });
        expect(weeklyOnlyQuota.openai.fiveHourLeftPercent).toBeUndefined();

        runProcessSpy.mockReset().mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: "Codex update screen without quota limits",
        });
        await refreshCacheProducer("quotas.summary", undefined, { force: true });
        expect(runProcessSpy).toHaveBeenCalledTimes(2);
        const repeatedParseFailure = JSON.parse(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as { data_json: string }
            ).data_json
        );
        expect(repeatedParseFailure.openai).toEqual({
            note: "Could not parse Codex /status output",
            status: "error",
        });

        runProcessSpy.mockReset().mockResolvedValue({
            code: 1,
            stderr: "update failed",
            stdout: "",
        });
        await refreshCacheProducer("quotas.summary", undefined, { force: true });
        expect(runProcessSpy).toHaveBeenCalledTimes(1);
        const commandFailure = JSON.parse(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as { data_json: string }
            ).data_json
        );
        expect(commandFailure.openai).toEqual({
            note: "codex quota exited 1: update failed",
            status: "error",
        });
    });

    it("refreshes weather through the Open-Meteo fallback when wttr.in fails", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = String(input);
            if (url.startsWith("https://wttr.in/Spydeberg")) {
                return new Response("upstream unavailable", { status: 503 });
            }
            if (url.startsWith("https://api.open-meteo.com/")) {
                return Response.json({
                    current: {
                        apparent_temperature: 12.5,
                        relative_humidity_2m: 94,
                        temperature_2m: 13,
                        weather_code: 61,
                        wind_speed_10m: 5,
                    },
                    daily: {
                        temperature_2m_max: [21, 22, 20],
                        temperature_2m_min: [14, 15, 13],
                        time: ["2026-06-26", "2026-06-27", "2026-06-28"],
                        weather_code: [0, 95, "bad"],
                    },
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");

        await expect(
            refreshCacheProducer("weather.spydeberg", undefined, { force: true })
        ).resolves.toEqual({ refreshed: ["weather.spydeberg"] });

        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'weather.spydeberg'"
            )
            .get() as { data_json: string; metadata_json: string; status: string };
        expect(row.status).toBe("fresh");
        const data = JSON.parse(row.data_json);
        expect(data).toMatchObject({
            description: "Rain",
            forecast: [
                { date: "2026-06-26", description: "Clear" },
                { date: "2026-06-27", description: "Thunderstorm" },
                { date: "2026-06-28", description: "Unknown" },
            ],
            humidityPercent: 94,
            location: "Spydeberg",
            temperatureC: 13,
        });
        expect(JSON.parse(row.metadata_json)).toMatchObject({
            fallbackReason: expect.stringContaining("HTTP 503"),
            fallbackUsed: true,
            providerPriority: ["wttr.in", "open-meteo"],
        });
    });

    it("records Moltbook sub-request failures without discarding successful cache writes", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "moltbook-key";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = String(input);
            if (url.endsWith("/home")) {
                return Response.json({
                    activity_on_your_posts: [{ id: "activity-1" }],
                    latest_moltbook_announcement: {
                        author_name: "OpenClaw",
                        created_at: "2026-06-25T10:00:00.000Z",
                        post_id: "post-1",
                        preview: "Hello",
                        title: "Announcement",
                    },
                    posts_from_accounts_you_follow: [{ id: "followed-1" }],
                    what_to_do_next: [{ label: "reply" }],
                    your_direct_messages: {
                        pending_request_count: "2",
                        unread_message_count: "3",
                    },
                });
            }
            if (url.endsWith("/feed?sort=hot&limit=25")) {
                return Response.json({
                    feed_filter: "all",
                    feed_type: "hot",
                    has_more: true,
                    posts: [{ id: "hot-1" }],
                    tip: "keep going",
                });
            }
            if (url.endsWith("/feed?sort=new&limit=25")) {
                return new Response("feed failed", { status: 502 });
            }
            if (url.endsWith("/agents/profile?name=mira_2026")) {
                return Response.json({
                    agent: { name: "mira_2026" },
                    recentComments: [{ id: "comment-1" }],
                    recentPosts: [{ id: "post-2" }],
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");

        await expect(
            refreshCacheProducer("moltbook", undefined, { force: true })
        ).rejects.toThrow("Moltbook refresh had sub-request failures");

        const rows = database
            .prepare(
                "SELECT key, data_json, error_message, status FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
            )
            .all() as Array<{
            data_json: string | null;
            error_message: string | null;
            key: string;
            status: string;
        }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["moltbook.feed.hot", "fresh"],
            ["moltbook.feed.new", "error"],
            ["moltbook.home", "fresh"],
            ["moltbook.my-content", "fresh"],
            ["moltbook.profile", "fresh"],
        ]);
        expect(
            JSON.parse(rows.find((row) => row.key === "moltbook.home")?.data_json ?? "{}")
        ).toMatchObject({
            activityOnYourPostsCount: 1,
            pendingRequestCount: 2,
            unreadMessageCount: 3,
        });
        expect(
            rows.find((row) => row.key === "moltbook.feed.new")?.error_message
        ).toContain("Moltbook refresh had sub-request failures");
    });

    it("coordinates cache refresh in-flight sharing and abort handling", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        let weatherResponses = 0;
        let releaseWeather: (() => void) | undefined;
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = String(input);
            if (url.startsWith("https://wttr.in/Spydeberg")) {
                weatherResponses += 1;
                const gate = Promise.withResolvers<void>();
                releaseWeather = gate.resolve;
                await gate.promise;
                return Response.json({
                    current_condition: [
                        {
                            FeelsLikeC: "13",
                            humidity: "80",
                            temp_C: "14",
                            weatherDesc: [{ value: "Clear" }],
                            windspeedKmph: "5",
                        },
                    ],
                    weather: [
                        {
                            date: "2026-06-26",
                            hourly: [{ weatherDesc: [{ value: "Clear" }] }],
                            maxtempC: "21",
                            mintempC: "14",
                        },
                    ],
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        const firstRefresh = refreshCacheProducer("weather.spydeberg", undefined, {
            force: true,
        });
        await waitFor(() => weatherResponses === 1);
        const secondRefresh = refreshCacheProducer("weather.spydeberg");
        const abortController = new AbortController();
        const abortedRefresh = refreshCacheProducer(
            "weather.spydeberg",
            abortController.signal
        );
        abortController.abort();
        const abortedRefreshState = (async () => {
            try {
                await abortedRefresh;
                return "resolved" as const;
            } catch (error) {
                return error instanceof Error ? error.message : "rejected without error";
            }
        })();
        expect(
            await Promise.race([
                abortedRefreshState,
                (async () => {
                    await Bun.sleep(10);
                    return "pending" as const;
                })(),
            ])
        ).toBe("pending");
        releaseWeather?.();

        await expect(firstRefresh).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        await expect(secondRefresh).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        await expect(abortedRefreshState).resolves.toBe("Cache refresh aborted");
        expect(weatherResponses).toBe(1);
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
        const connectErrors: string[] = [];
        const closeEvents: Array<{ code: number; reason: string }> = [];
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        const identityRoot = createTemporaryRoot("mira-gateway-device-identity-");
        const { loadOrCreateDeviceIdentity, OpenClawGatewayClient } =
            await import("../src/lib/openclawGatewayClient.ts");
        const deviceIdentity = loadOrCreateDeviceIdentity(
            path.join(identityRoot, "device.json")
        );
        const client = new OpenClawGatewayClient({
            clientName: "dashboard-client",
            deviceFamily: "SERVER",
            deviceIdentity,
            onClose: (code, reason) => {
                closeEvents.push({ code, reason });
            },
            onConnectError: (error) => {
                connectErrors.push(error.message);
            },
            onEvent: (event) => {
                events.push(event);
            },
            onHelloOk: (payload) => {
                helloPayloads.push(payload);
            },
            platform: "LINUX",
            requestTimeoutMs: 100,
            token: " gateway-token ",
            url: "ws://gateway.test",
        });

        client.start();
        const socket = FakeGatewayWebSocket.instances.at(-1);
        expect(socket).toBeDefined();
        expect(socket?.url).toBe("ws://gateway.test");

        socket?.open();
        socket?.message("{");
        socket?.message(JSON.stringify({ type: "noop" }));
        expect(socket?.sent).toHaveLength(0);
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
            params: {
                auth: { token: string };
                client: { deviceFamily: string; id: string; platform: string };
                device: {
                    id: string;
                    nonce: string;
                    publicKey: string;
                    signature: string;
                };
                role: string;
            };
            type: string;
        };
        expect(connectFrame).toMatchObject({
            method: "connect",
            params: {
                auth: { token: "gateway-token" },
                client: {
                    deviceFamily: "SERVER",
                    id: "dashboard-client",
                    platform: "LINUX",
                },
                device: {
                    id: deviceIdentity.deviceId,
                    nonce: "nonce-1",
                    publicKey: expect.any(String),
                    signature: expect.any(String),
                },
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

        const extendedRequest = client.request("demo.extended", {}, { timeoutMs: 500 });
        await waitFor(() => socket!.sent.length === 4);
        const extendedFrame = JSON.parse(socket!.sent[3]!) as { id: string };
        await Bun.sleep(150);
        socket?.message(
            JSON.stringify({
                id: extendedFrame.id,
                isOk: true,
                payload: { extended: true },
                type: "response",
            })
        );
        await expect(extendedRequest).resolves.toEqual({ extended: true });

        const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
        try {
            const fractionalRequest = client.request(
                "demo.fractional",
                {},
                {
                    timeoutMs: 0.5,
                }
            );
            expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(1);
            await waitFor(() => socket!.sent.length === 5);
            const fractionalFrame = JSON.parse(socket!.sent[4]!) as { id: string };
            socket?.message(
                JSON.stringify({
                    id: fractionalFrame.id,
                    ok: true,
                    payload: { fractional: true },
                    type: "res",
                })
            );
            await expect(fractionalRequest).resolves.toEqual({ fractional: true });

            const timeoutCallCount = timeoutSpy.mock.calls.length;
            const noDeadlineRequest = client.request(
                "demo.no-deadline",
                {},
                { shouldWaitIndefinitely: true }
            );
            expect(timeoutSpy).toHaveBeenCalledTimes(timeoutCallCount);
            const noDeadlineFrame = JSON.parse(socket!.sent[5]!) as { id: string };
            socket?.message(
                JSON.stringify({
                    id: noDeadlineFrame.id,
                    ok: true,
                    payload: { completed: true },
                    type: "res",
                })
            );
            await expect(noDeadlineRequest).resolves.toEqual({ completed: true });
        } finally {
            timeoutSpy.mockRestore();
        }

        socket!.sendError = new Error("send failed");
        await expect(client.request("demo.send-fail")).rejects.toThrow("send failed");
        socket!.sendError = undefined;

        const closedRequest = client.request("demo.closed");
        await waitFor(() => socket!.sent.length === 7);
        socket?.close(4001, "gone");
        await expect(closedRequest).rejects.toThrow("gateway closed (4001): gone");
        expect(closeEvents).toContainEqual({ code: 4001, reason: "gone" });

        const missingNonceClient = new OpenClawGatewayClient({
            onConnectError: (error) => {
                connectErrors.push(error.message);
            },
            requestTimeoutMs: 100,
            url: "ws://gateway.test/missing-nonce",
        });
        missingNonceClient.start();
        const missingNonceSocket = FakeGatewayWebSocket.instances.at(-1);
        missingNonceSocket?.open();
        missingNonceSocket?.message(
            JSON.stringify({
                event: "connect.challenge",
                payload: {},
                type: "event",
            })
        );
        await waitFor(
            () => missingNonceSocket?.closeReason === "connect challenge missing nonce"
        );
        expect(connectErrors).toContain("gateway connect challenge missing nonce");
        missingNonceClient.stop();

        client.stop();
        expect(socket?.closeCode).toBe(4001);
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
        const {
            clearNeedsAttentionBackupJob,
            getCurrentBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await import("../src/services/backups.ts");
        const { getScheduledJob, runScheduledJob, upsertScheduledJob } =
            await import("../src/services/scheduledJobs.ts");

        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            expect(getScheduledJob("backup.walg")).toMatchObject({
                actionKey: "backup.run",
                enabled: true,
                scheduleType: "daily",
                timeOfDay: "03:20",
            });
            upsertScheduledJob({
                id: "backup.invalid",
                name: "Invalid backup",
                enabled: false,
                scheduleType: "interval",
                intervalSeconds: 3600,
                actionKey: "backup.run",
                actionPayload: { type: "invalid" },
            });
            const invalidRun = await runScheduledJob("backup.invalid");
            expect(invalidRun).toMatchObject({
                jobId: "backup.invalid",
                status: "failed",
            });

            const job = await startManualBackup("walg");
            const completed = await job.completed;

            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                stdout: expect.stringContaining("backup ok"),
                type: "walg",
            });
            await expect(clearNeedsAttentionBackupJob("walg")).rejects.toMatchObject({
                statusCode: 404,
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("reports WAL-G preflight failures without starting a backup job", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-preflight-bin-");
        writeFailingWalgPreflightDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            await expect(startManualBackup("walg")).rejects.toMatchObject({
                statusCode: 503,
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("cleans backup route state when backup process spawn fails", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-spawn-fail-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const processModule = await import("../src/lib/processes.ts");
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                throw new Error("spawn unavailable");
            });
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            await expect(startManualBackup("walg")).rejects.toThrow("spawn unavailable");
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            spawnSpy.mockRestore();
            warnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("reuses an already running WAL-G backup job instead of spawning another", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");
        const exit = Promise.withResolvers<number>();
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (_command, arguments_) => {
                const joined = arguments_.join(" ");
                if (joined.includes("pgrep -f")) {
                    return {
                        code: 1,
                        stderr: "",
                        stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                    };
                }
                if (joined.includes("wal-g backup-list")) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "[]",
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: () => {},
                    pid: 789,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream("backup still running\n"),
                }) as unknown as processModule.BunProcess
        );

        try {
            registerBackupScheduledJobs();
            const first = await startManualBackup("walg");
            const second = await startManualBackup("walg");
            expect(second.id).toBe(first.id);
            expect(spawnSpy).toHaveBeenCalledTimes(1);

            exit.resolve(0);
            await expect(first.completed).resolves.toMatchObject({
                code: 0,
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toMatchObject({
                id: first.id,
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("trims oversized output in the worker backup primitive", async () => {
        const { getCurrentBackupJob, startManualBackup } =
            await import("../src/services/backups.ts");
        const largeOutput = `${"x".repeat(100_200)}tail-marker\n`;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (_command, arguments_) => {
                const joined = arguments_.join(" ");
                if (joined.includes("pgrep -f")) {
                    return {
                        code: 1,
                        stderr: "",
                        stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(largeOutput),
                }) as unknown as processModule.BunProcess
        );

        try {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
            const job = await startManualBackup("walg");
            const completed = await job.completed;

            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                type: "walg",
            });
            expect(completed.stdout.length).toBeLessThanOrEqual(100_000);
            expect(completed.stdout).toEndWith("tail-marker\n");
            expect(
                database
                    .prepare(
                        "SELECT COUNT(*) AS count FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'"
                    )
                    .get()
            ).toEqual({ count: 0 });
            expect(getCurrentBackupJob("walg")).toMatchObject({ status: "done" });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("records backup process promise failures after startup", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (_command, arguments_) => {
                const joined = arguments_.join(" ");
                if (joined.includes("pgrep -f")) {
                    return {
                        code: 1,
                        stderr: "",
                        stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.reject(new Error("child process promise failed")),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream("stderr before failure\n"),
                    stdout: readableUtf8Stream("stdout before failure\n"),
                }) as unknown as processModule.BunProcess
        );

        try {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
            registerBackupScheduledJobs();
            const job = await startManualBackup("walg");
            const completed = await job.completed;

            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(completed).toMatchObject({
                code: 1,
                status: "done",
                type: "walg",
            });
            expect(completed.stdout).toContain("stdout before failure");
            expect(completed.stderr).toContain("stderr before failure");
            expect(completed.stderr).toContain("child process promise failed");
            expect(getCurrentBackupJob("walg")).toMatchObject({ status: "done" });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("cancels queued backups before worker preflight starts", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs } =
            await import("../src/services/backups.ts");
        const { cancelJobExecution } =
            await import("../src/services/jobExecutionQueue.ts");
        const { enqueueScheduledJob } = await import("../src/services/scheduledJobs.ts");

        try {
            registerBackupScheduledJobs();
            const run = enqueueScheduledJob("backup.walg", "manual");
            cancelJobExecution(run.executionId as string);
            expect(
                database
                    .prepare(
                        "SELECT job_id AS jobId, status FROM scheduled_job_runs WHERE id = ?"
                    )
                    .get(run.id)
            ).toMatchObject({
                jobId: "backup.walg",
                status: "cancelled",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("marks scheduled backups failed when the spawned process exits nonzero", async () => {
        const { registerBackupScheduledJobs } =
            await import("../src/services/backups.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (_command, arguments_) => {
                const joined = arguments_.join(" ");
                if (joined.includes("pgrep -f")) {
                    return {
                        code: 1,
                        stderr: "",
                        stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                    };
                }
                if (joined.includes("wal-g backup-list")) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "[]",
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(2),
                    kill: () => {},
                    pid: 456,
                    stderr: readableUtf8Stream("backup exploded\n"),
                    stdout: readableUtf8Stream("backup started\n"),
                }) as unknown as processModule.BunProcess
        );

        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("backup.walg");

            expect(run).toMatchObject({
                jobId: "backup.walg",
                status: "failed",
            });
            expect(run.message).toContain("WALG backup failed with code 2");
            expect(run.message).toContain("backup exploded");
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("runs scheduled Kopia backups through host preflight and records success", async () => {
        const { registerBackupScheduledJobs } =
            await import("../src/services/backups.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (command, arguments_) => {
                if (command === "pgrep") {
                    expect(arguments_).toEqual([
                        "-f",
                        "/opt/docker/apps/kopia/backup.sh",
                    ]);
                    return { code: 1, stderr: "", stdout: "" };
                }
                return { code: 0, stderr: "", stdout: "{}" };
            });
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation((command, arguments_) => {
                expect(command).toBe("bash");
                expect(arguments_).toEqual(["-lc", "/opt/docker/apps/kopia/backup.sh"]);
                return {
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 654,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream("kopia ok\n"),
                } as unknown as processModule.BunProcess;
            });

        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("backup.kopia");

            expect(run).toMatchObject({
                jobId: "backup.kopia",
                status: "success",
            });
            expect(run.output).toMatchObject({
                backup: {
                    code: 0,
                    status: "done",
                    stdout: "kopia ok\n",
                    type: "kopia",
                },
            });
            expect(spawnSpy).toHaveBeenCalledTimes(1);
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("terminates running WAL-G backups when a scheduled run is aborted", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs } =
            await import("../src/services/backups.ts");
        const { cancelJobExecution } =
            await import("../src/services/jobExecutionQueue.ts");
        const { waitForJobExecution } =
            await import("../src/services/queuedJobExecution.ts");
        const { enqueueScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const exit = Promise.withResolvers<number>();
        const runProcessCalls: string[] = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (command, arguments_) => {
                const joined = `${command} ${arguments_.join(" ")}`;
                runProcessCalls.push(joined);
                if (joined.includes("pgrep -f")) {
                    return {
                        code: 1,
                        stderr: "",
                        stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                    };
                }
                if (joined.includes("pkill")) {
                    return { code: 0, stderr: "", stdout: "" };
                }
                if (joined.includes("wal-g backup-list")) {
                    return { code: 0, stderr: "", stdout: "[]" };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const killSignals: NodeJS.Signals[] = [];
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: (signal: NodeJS.Signals) => {
                        killSignals.push(signal);
                    },
                    pid: undefined,
                    stderr: readableUtf8Stream("backup output before abort\n"),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = enqueueScheduledJob("backup.walg", "manual");
            await waitFor(() => spawnSpy.mock.calls.length === 1, 3000);
            cancelJobExecution(run.executionId as string);
            await waitFor(() => killSignals.includes("SIGTERM"), 3000);
            exit.resolve(143);

            const execution = await waitForJobExecution(run.executionId as string, {
                timeoutMs: 3000,
            });
            expect(execution.status).toBe("cancelled");
            expect(execution.message).toBe("Job cancelled");
            expect(killSignals).toContain("SIGTERM");
            expect(runProcessCalls).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("pkill -TERM"),
                    expect.stringContaining("pgrep -f"),
                ])
            );
            expect(getCurrentBackupJob("walg")).toMatchObject({
                code: 130,
                stderr: expect.stringContaining("Backup aborted by scheduler"),
                status: "done",
            });
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("records and clears WAL-G needs-attention state when container preflight detects a running process", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-walg-running-bin-");
        writeRunningWalgPreflightDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const {
            clearPersistedBackupAttention,
            getCurrentBackupJob,
            getPersistedBackupJob,
            mapBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await import("../src/services/backups.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");

        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            await expect(startManualBackup("walg")).rejects.toMatchObject({
                statusCode: 409,
            });
            expect(mapBackupJob(getCurrentBackupJob("walg"))).toMatchObject({
                code: 130,
                status: "needs_attention",
                stderr: expect.stringContaining("backup process is still running"),
                type: "walg",
            });
            await expect(startManualBackup("walg")).rejects.toThrow(
                "WALG backup needs attention"
            );

            await expect(runScheduledJob("backup.walg")).resolves.toMatchObject({
                status: "failed",
            });
            expect(getPersistedBackupJob("walg")).toBeDefined();

            const clearedJob = await clearPersistedBackupAttention("walg");
            expect(clearedJob).toMatchObject({
                status: "needs_attention",
                type: "walg",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
            expect(getPersistedBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("clears persisted backup attention without in-memory worker state", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-persisted-clear-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const {
            clearPersistedBackupAttention,
            getCurrentBackupJob,
            getPersistedBackupJob,
            registerBackupScheduledJobs,
        } = await import("../src/services/backups.ts");
        const { enqueueScheduledJob } = await import("../src/services/scheduledJobs.ts");

        try {
            registerBackupScheduledJobs();
            const run = enqueueScheduledJob("backup.walg", "manual");
            const executionId = run.executionId;
            if (!executionId) throw new Error("Backup execution id was missing");
            const completedAt = "2026-07-22T02:00:00.000Z";
            const backup = {
                code: 130,
                endedAt: Date.parse(completedAt),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse(completedAt),
                status: "needs_attention",
                stderr: "Worker restarted before attention was cleared",
                stdout: "",
                type: "walg",
            };
            database
                .prepare(
                    `UPDATE job_executions
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'WALG backup needs attention', output_json = ?
                     WHERE id = ?`
                )
                .run(completedAt, completedAt, JSON.stringify({ backup }), executionId);
            database
                .prepare(
                    `UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'WALG backup needs attention', output_json = ?
                     WHERE id = ?`
                )
                .run(completedAt, completedAt, JSON.stringify({ backup }), run.id);

            expect(getCurrentBackupJob("walg")).toBeUndefined();
            expect(getPersistedBackupJob("walg")).toMatchObject(backup);

            await startTestScheduledExecutor();
            await expect(clearPersistedBackupAttention("walg")).resolves.toMatchObject({
                code: backup.code,
                endedAt: backup.endedAt,
                id: backup.id,
                startedAt: backup.startedAt,
                status: backup.status,
                stdout: backup.stdout,
                type: backup.type,
            });
            expect(getPersistedBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("does not clear a newer persisted backup than the requested execution", async () => {
        const {
            clearPersistedBackupAttention,
            getPersistedBackupJob,
            registerBackupScheduledJobs,
        } = await import("../src/services/backups.ts");
        const { enqueueScheduledJob } = await import("../src/services/scheduledJobs.ts");

        try {
            registerBackupScheduledJobs();
            const oldRun = enqueueScheduledJob("backup.walg", "manual");
            const oldExecutionId = oldRun.executionId;
            if (!oldExecutionId) throw new Error("Old backup execution id was missing");
            const oldBackup = {
                code: 130,
                endedAt: Date.parse("2026-07-22T02:00:00.000Z"),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse("2026-07-22T02:00:00.000Z"),
                status: "needs_attention",
                stderr: "Old backup needs attention",
                stdout: "",
                type: "walg",
            };
            database
                .prepare(
                    `UPDATE job_executions
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Old WALG backup needs attention', output_json = ?
                     WHERE id = ?`
                )
                .run(
                    "2026-07-22T02:00:00.000Z",
                    "2026-07-22T02:00:00.000Z",
                    JSON.stringify({ backup: oldBackup }),
                    oldExecutionId
                );
            database
                .prepare(
                    `UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Old WALG backup needs attention', output_json = ?
                     WHERE id = ?`
                )
                .run(
                    "2026-07-22T02:00:00.000Z",
                    "2026-07-22T02:00:00.000Z",
                    JSON.stringify({ backup: oldBackup }),
                    oldRun.id
                );

            const clearPromise = clearPersistedBackupAttention("walg");
            const newerRun = enqueueScheduledJob("backup.walg", "manual");
            const newerExecutionId = newerRun.executionId;
            if (!newerExecutionId) {
                throw new Error("Newer backup execution id was missing");
            }
            const newerBackup = {
                ...oldBackup,
                endedAt: Date.parse("2026-07-22T03:00:00.000Z"),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse("2026-07-22T03:00:00.000Z"),
                stderr: "Newer backup needs attention",
            };
            database
                .prepare(
                    `UPDATE job_executions
                     SET status = 'failed', queued_at = ?, started_at = ?,
                         finished_at = ?, message = 'Newer WALG backup needs attention',
                         output_json = ?
                     WHERE id = ?`
                )
                .run(
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    JSON.stringify({ backup: newerBackup }),
                    newerExecutionId
                );
            database
                .prepare(
                    `UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Newer WALG backup needs attention', output_json = ?
                     WHERE id = ?`
                )
                .run(
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    JSON.stringify({ backup: newerBackup }),
                    newerRun.id
                );

            await startTestScheduledExecutor();
            await expect(clearPromise).rejects.toMatchObject({
                message: "WALG backup attention changed before clearing",
                statusCode: 409,
            });
            expect(getPersistedBackupJob("walg")).toMatchObject(newerBackup);
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("reports Kopia host pgrep failures without recording needs-attention state", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-host-pgrep-error-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        const fakePgrep = path.join(fakeBin, "pgrep");
        writeFileSync(
            fakePgrep,
            "#!/usr/bin/env bash\nprintf 'pgrep unavailable\\n' >&2\nexit 2\n"
        );
        chmodSync(fakePgrep, 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            await expect(startManualBackup("kopia")).rejects.toMatchObject({
                statusCode: 503,
            });
            expect(getCurrentBackupJob("kopia")).toBeUndefined();
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
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("rejects invalid log rotation policy configs before touching files", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-validation-");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const logFile = path.join(rotationRoot, "service.log");
        writeFileSync(logFile, "do not touch\n");
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const validBase = {
            approvedRoots: [rotationRoot],
            groups: [{ name: "unit", paths: [logFile] }],
            version: 1,
        };
        const invalidCases: Array<{
            config: unknown;
            message: string | RegExp;
            name: string;
        }> = [
            {
                config: JSON.parse("null") as unknown,
                message: "Config must be an object",
                name: "non-object config",
            },
            {
                config: { ...validBase, defaults: JSON.parse("null") as unknown },
                message: "Config defaults must be an object",
                name: "null defaults",
            },
            {
                config: { ...validBase, version: 2 },
                message: "Config version must be 1",
                name: "unsupported version",
            },
            {
                config: { ...validBase, groups: {} },
                message: "Config groups must be an array",
                name: "non-array groups",
            },
            {
                config: { ...validBase, approvedRoots: [] },
                message: "approvedRoots must include at least one entry",
                name: "empty approved roots",
            },
            {
                config: { ...validBase, defaults: { paths: [""] } },
                message: "defaults.paths must be an array of non-empty strings",
                name: "blank default path",
            },
            {
                config: { ...validBase, defaults: { archiveRetentionScope: "all" } },
                message:
                    "defaults.archiveRetentionScope must be directory, basename, or parent",
                name: "bad default retention scope",
            },
            {
                config: { ...validBase, defaults: { strategy: "move" } },
                message: "defaults.strategy has unsupported strategy",
                name: "bad default strategy",
            },
            {
                config: { ...validBase, groups: [{ name: "", paths: [logFile] }] },
                message: "Every group needs a string name",
                name: "blank group name",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        { daily: true, name: "unit", paths: [logFile], weekly: true },
                    ],
                },
                message: "Group unit cannot set both daily and weekly rotation",
                name: "daily and weekly",
            },
            {
                config: { ...validBase, groups: [{ archiveOnly: true, name: "unit" }] },
                message:
                    "Archive-only group unit needs at least one archivePaths pattern",
                name: "archive-only without archives",
            },
            {
                config: { ...validBase, groups: [{ name: "unit" }] },
                message: "Group unit needs at least one path pattern",
                name: "group without paths",
            },
            {
                config: {
                    ...validBase,
                    groups: [{ name: "unit", paths: [logFile], strategy: "move" }],
                },
                message: "Group unit has unsupported strategy",
                name: "bad group strategy",
            },
            {
                config: {
                    ...validBase,
                    groups: [{ enabled: "yes", name: "unit", paths: [logFile] }],
                },
                message: "Group unit.enabled must be a boolean",
                name: "bad boolean",
            },
            {
                config: {
                    ...validBase,
                    groups: [{ maxSizeMb: -1, name: "unit", paths: [logFile] }],
                },
                message: "Group unit.maxSizeMb must be a non-negative number",
                name: "bad number",
            },
            {
                config: {
                    ...validBase,
                    groups: [{ keep: 0, name: "unit", paths: [logFile] }],
                },
                message: "Group unit.keep must be a positive integer",
                name: "bad keep",
            },
        ];

        for (const { config, message, name } of invalidCases) {
            writeFileSync(configFile, `${JSON.stringify(config)}\n`);
            await expect(
                runLogRotationService({ config: configFile, isDryRun: true }),
                name
            ).rejects.toThrow(message);
        }
        expect(readFileSync(logFile, "utf8")).toBe("do not touch\n");
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

    it("reclaims stale log rotation locks before live rotation", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-stale-lock-");
        const logFile = path.join(rotationRoot, "stale-lock.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const lockFile = path.join(process.cwd(), "data", "log-rotation.lock");
        mkdirSync(path.dirname(lockFile), { recursive: true });
        writeFileSync(lockFile, "999999999\n");
        const staleTime = new Date(Date.now() - 13 * 60 * 60 * 1000);
        utimesSync(lockFile, staleTime, staleTime);
        cleanupCallbacks.push(() => {
            rmSync(lockFile, { force: true });
            rmSync(`${lockFile}.reclaim`, { force: true, recursive: true });
        });
        writeFileSync(logFile, "rotate after stale lock\n");
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
                groups: [{ name: "stale-lock", paths: [logFile] }],
                version: 1,
            })
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
        });

        expect(summary).toMatchObject({
            checkedFiles: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(logFile, "utf8")).toBe("");
        expect(existsSync(lockFile)).toBe(false);
        expect(existsSync(`${lockFile}.reclaim`)).toBe(false);
    });

    it("rotates logs with rename strategy and applies archive-only retention", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-rename-test-");
        const logFile = path.join(rotationRoot, "rename.log");
        const archiveRoot = path.join(rotationRoot, "archives");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        mkdirSync(archiveRoot, { recursive: true });
        writeFileSync(logFile, "rename me\n");
        const oldArchive = path.join(archiveRoot, "app.1.log");
        const retainedArchive = path.join(archiveRoot, "app.2.log");
        writeFileSync(oldArchive, "old archive\n");
        writeFileSync(retainedArchive, "new archive\n");
        const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const retainedTime = new Date(Date.now() - 5 * 60 * 1000);
        utimesSync(oldArchive, oldTime, oldTime);
        utimesSync(retainedArchive, retainedTime, retainedTime);
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                },
                groups: [
                    {
                        compress: true,
                        name: "rename",
                        paths: [logFile],
                        strategy: "rename",
                    },
                    {
                        archiveOnly: true,
                        archivePaths: [path.join(archiveRoot, "*.log")],
                        archiveRetentionScope: "directory",
                        keep: 1,
                        keepDays: 1,
                        name: "archives",
                        shouldCompress: false,
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
            verbose: true,
        });
        const hasCompressionStream = "CompressionStream" in globalThis;

        expect(summary).toMatchObject({
            checkedGroups: 2,
            checkedFiles: 3,
            compressedFiles: hasCompressionStream ? 1 : 0,
            deletedArchives: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(logFile, "utf8")).toBe("");
        expect(existsSync(oldArchive)).toBe(false);
        expect(existsSync(retainedArchive)).toBe(true);
        expect(readdirSync(rotationRoot).some((name) => name.endsWith(".gz"))).toBe(
            hasCompressionStream
        );

        const row = database
            .prepare(
                "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
            )
            .get() as { data_json?: string } | undefined;
        const state = JSON.parse(row?.data_json ?? "{}") as {
            files?: Record<string, { lastArchive?: string }>;
            lastRun?: { isOk?: boolean };
        };
        expect(state.lastRun?.isOk).toBe(true);
        expect(state.files?.[logFile]?.lastArchive?.endsWith(".gz")).toBe(
            hasCompressionStream
        );
    });

    it("includes configured archives when applying log rotation retention", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-archives-test-");
        const logFile = path.join(rotationRoot, "app.log");
        const archiveRoot = path.join(rotationRoot, "archives");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        mkdirSync(archiveRoot, { recursive: true });
        writeFileSync(logFile, "rotate me\n");
        const configuredArchive = path.join(archiveRoot, "app.previous.log");
        writeFileSync(configuredArchive, "older archive\n");
        const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        utimesSync(configuredArchive, oldTime, oldTime);
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                },
                groups: [
                    {
                        archivePaths: [path.join(archiveRoot, "*.log")],
                        archiveRetentionScope: "directory",
                        name: "logs",
                        paths: [logFile],
                        strategy: "rename",
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: true,
            verbose: true,
        });

        expect(summary).toMatchObject({
            checkedFiles: 1,
            deletedArchives: 0,
            isDryRun: true,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(existsSync(configuredArchive)).toBe(true);
    });

    it("copy-truncates logs, honors exclusions, and reports unsafe rotation errors", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-copy-test-");
        const outsideRoot = createTemporaryRoot("mira-log-rotation-outside-");
        const logsRoot = path.join(rotationRoot, "logs");
        mkdirSync(logsRoot, { recursive: true });
        const liveLog = path.join(logsRoot, "live.log");
        const emptyLog = path.join(logsRoot, "empty.log");
        const excludedLog = path.join(logsRoot, "excluded.log");
        const linkedSource = path.join(logsRoot, "linked-source.log");
        const outsideLog = path.join(outsideRoot, "outside.log");
        const hardlink = path.join(logsRoot, "linked-hardlink.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        writeFileSync(liveLog, "copytruncate me\n");
        writeFileSync(emptyLog, "");
        writeFileSync(excludedLog, "leave me\n");
        writeFileSync(linkedSource, "do not rotate linked files\n");
        writeFileSync(outsideLog, "outside root\n");
        symlinkSync(liveLog, path.join(logsRoot, "live-symlink.log"));
        try {
            // Hard links are refused by the service because rotating one would mutate
            // another path with the same inode.
            Bun.spawnSync(["ln", linkedSource, hardlink]);
        } catch {
            // Some filesystems may not support hard links in tmp; the main path still
            // exercises copytruncate and exclusions.
        }
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: true,
                    skipEmpty: true,
                    strategy: "copytruncate",
                },
                excludePaths: [excludedLog],
                groups: [
                    {
                        name: "copy",
                        paths: [
                            path.join(logsRoot, "*.log"),
                            path.join(logsRoot, "missing.log"),
                            outsideLog,
                        ],
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } = await import("../src/services/logRotation.ts");

        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
            verbose: true,
        });

        expect(summary).toMatchObject({
            checkedGroups: 1,
            deletedArchives: 0,
            isDryRun: false,
            isOk: false,
            rotatedFiles: 1,
        });
        expect(readFileSync(liveLog, "utf8")).toBe("");
        expect(readFileSync(excludedLog, "utf8")).toBe("leave me\n");
        expect(summary.skippedFiles).toBeGreaterThanOrEqual(1);
        expect(summary.errors).toContainEqual(
            expect.objectContaining({
                filePath: outsideLog,
                message: expect.stringContaining("Unsafe path outside approved roots"),
            })
        );
        if (existsSync(hardlink)) {
            expect(summary.errors).toContainEqual(
                expect.objectContaining({
                    filePath: hardlink,
                    message: expect.stringContaining("Refusing multi-linked file"),
                })
            );
        }
        const stateRow = database
            .prepare(
                "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
            )
            .get() as { data_json?: string } | undefined;
        const state = JSON.parse(stateRow?.data_json ?? "{}") as {
            files?: Record<string, { lastArchive?: string; lastSizeBytes?: number }>;
        };
        expect(state.files?.[liveLog]).toMatchObject({
            lastArchive: expect.stringContaining("live.log."),
            lastSizeBytes: "copytruncate me\n".length,
        });
    });

    it("normalizes elevated log rotation command output and failures", async () => {
        const { runElevatedLogRotationService } =
            await import("../src/services/logRotation.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValueOnce({
                code: 0,
                stderr: "sudo notice",
                stdout: 'banner before json\n{"isOk":true,"checkedFiles":2}\n',
            })
            .mockResolvedValueOnce({
                code: 0,
                stderr: "",
                stdout: "",
            })
            .mockResolvedValueOnce({
                code: 1,
                stderr: "sudo failed",
                stdout: '{"isOk":false,"error":"policy denied","stdout":"details"}\n',
            })
            .mockResolvedValueOnce({
                code: 0,
                stderr: "bad json stderr",
                stdout: "not json",
            });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(runElevatedLogRotationService({ isDryRun: true })).resolves.toEqual({
            result: { checkedFiles: 2, isOk: true },
            stderr: "sudo notice",
        });
        await expect(
            runElevatedLogRotationService({ isDryRun: false })
        ).resolves.toMatchObject({
            result: {
                error: "Elevated log rotation returned empty JSON output",
                isOk: false,
            },
            stderr: "Elevated log rotation returned empty JSON output",
        });
        await expect(runElevatedLogRotationService({ isDryRun: false })).resolves.toEqual(
            {
                result: { error: "policy denied", isOk: false, stdout: "details" },
                stderr: "sudo failed",
            }
        );
        await expect(
            runElevatedLogRotationService({ isDryRun: false })
        ).resolves.toMatchObject({
            result: {
                error: "Failed to parse elevated log rotation JSON",
                isOk: false,
                stdout: "not json",
            },
            stderr: expect.stringContaining("bad json stderr"),
        });
    });

    it("records scheduled log-rotation failures in cache state", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../src/services/logRotation.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 1,
            stderr: "sudo denied",
            stdout: JSON.stringify({
                errors: [{ message: "policy denied" }],
                groups: [{ name: "docker" }],
                isOk: false,
                warnings: [{ message: "warn" }],
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");

            expect(run.status).toBe("failed");
            expect(run.message).toContain("sudo denied");
            expect(run.output).toMatchObject({
                logRotation: {
                    result: { isOk: false },
                    stderr: "sudo denied",
                },
            });
            const row = database
                .prepare(
                    "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                )
                .get() as { data_json?: string } | undefined;
            const state = JSON.parse(row?.data_json ?? "{}") as {
                lastRun?: { isDryRun?: boolean; isOk?: boolean; stderr?: string };
            };
            expect(state.lastRun).toMatchObject({
                isDryRun: false,
                isOk: false,
                stderr: "sudo denied",
            });
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
    });

    it("records structured scheduled log-rotation failures when sudo exits cleanly", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../src/services/logRotation.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
                errors: [{ message: "policy rejected group" }],
                groups: [{ name: "docker" }],
                isOk: false,
                stdout: "x".repeat(100_050),
                warnings: [{ message: "matched no files" }],
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");

            expect(run.status).toBe("failed");
            expect(run.message).toContain("Log rotation failed");
            expect(run.message).toContain("policy rejected group");
            expect(run.message).toContain("matched no files");
            expect(run.message).toContain("docker");
            expect(run.output).toMatchObject({
                logRotation: {
                    result: {
                        errors: [{ message: "policy rejected group" }],
                        isOk: false,
                    },
                },
            });
            expect(
                (
                    run.output.logRotation as {
                        result: { stdout?: string };
                    }
                ).result.stdout
            ).toHaveLength(100_000);
            const row = database
                .prepare(
                    "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                )
                .get() as { data_json?: string } | undefined;
            const state = JSON.parse(row?.data_json ?? "{}") as {
                lastRun?: { isOk?: boolean; stdout?: string };
            };
            expect(state.lastRun).toMatchObject({ isOk: false });
            expect(state.lastRun?.stdout).toHaveLength(100_000);
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
    });

    it("records successful scheduled log-rotation runs", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../src/services/logRotation.ts");
        const { runScheduledJob } = await import("../src/services/scheduledJobs.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 0,
            stderr: "sudo notice",
            stdout: JSON.stringify({
                checkedGroups: 1,
                isDryRun: false,
                isOk: true,
                rotatedFiles: 0,
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");

            expect(run.status).toBe("success");
            expect(run.message).toBeUndefined();
            expect(run.output).toMatchObject({
                logRotation: {
                    result: {
                        checkedGroups: 1,
                        isOk: true,
                    },
                    stderr: "sudo notice",
                },
            });
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
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
            await expect(updateAgentCurrentTask("../bad", "Task")).rejects.toMatchObject({
                statusCode: 400,
            });
            await expect(updateAgentCurrentTask(agentId, " ")).rejects.toMatchObject({
                statusCode: 400,
            });

            const firstMetadata = await updateAgentCurrentTask(agentId, "First task");
            const secondMetadata = await updateAgentCurrentTask(agentId, "Second task");
            const repeatedMetadata = await updateAgentCurrentTask(agentId, "Second task");

            expect(firstMetadata.currentTask).toBe("First task");
            expect(secondMetadata.currentTask).toBe("Second task");
            expect(repeatedMetadata.currentTask).toBe("Second task");
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
            const historyRows = database
                .prepare(
                    `SELECT task, status
                     FROM agent_task_history
                     WHERE agent_id = ?
                     ORDER BY id`
                )
                .all(agentId) as Array<{ task: string; status: string }>;
            expect(historyRows).toEqual([
                { task: "First task", status: "completed" },
                { task: "Second task", status: "active" },
            ]);
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
        const researcherSessions = path.join(
            agentsRoot,
            "researcher",
            "agent",
            "codex-home",
            "sessions",
            "2026",
            "06"
        );
        const auditorSessions = path.join(agentsRoot, "auditor", "sessions");
        const writerSessions = path.join(agentsRoot, "writer", "sessions");
        const browserSessions = path.join(agentsRoot, "browser", "sessions");
        const staleSessions = path.join(agentsRoot, "stale", "sessions");
        const responseItemAgents = [
            {
                activity: "edit files",
                id: "patcher",
                input: "await tools.apply_patch({})",
                task: "Patch files",
            },
            {
                activity: "session_status",
                id: "session-checker",
                input: "await tools.openclaw_session_status({})",
                task: "Check session",
            },
            {
                activity: "terminal output",
                id: "terminal-reader",
                input: "await tools.write_stdin({session_id:1})",
                task: "Read terminal",
            },
            {
                activity: "memory_search",
                id: "memory-agent",
                input: 'await tools.memory_search({"query":"dashboard coverage"})',
                task: "Search memory",
            },
        ];
        mkdirSync(miraSessions, { recursive: true });
        mkdirSync(coderSessions, { recursive: true });
        mkdirSync(researcherSessions, { recursive: true });
        mkdirSync(auditorSessions, { recursive: true });
        mkdirSync(writerSessions, { recursive: true });
        mkdirSync(browserSessions, { recursive: true });
        mkdirSync(staleSessions, { recursive: true });
        for (const agent of responseItemAgents) {
            mkdirSync(path.join(agentsRoot, agent.id, "sessions"), { recursive: true });
        }
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
                        { id: "researcher" },
                        { id: "auditor" },
                        { id: "writer" },
                        { id: "browser" },
                        { id: "stale" },
                        ...responseItemAgents.map((agent) => ({ id: agent.id })),
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
        writeFileSync(
            path.join(researcherSessions, "researcher.trajectory.jsonl"),
            [
                {
                    data: {
                        prompt: [
                            "Research coverage gaps",
                            "[media attached: ignored]",
                            "Conversation info: ignored",
                        ].join("\n"),
                    },
                    runId: "research-run",
                    type: "prompt.submitted",
                },
                {
                    data: {
                        arguments: { path: "/tmp/coverage.ts" },
                        name: "read",
                        turnId: "research-turn",
                    },
                    runId: "research-run",
                    type: "tool.call",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
        );
        writeFileSync(
            path.join(writerSessions, "session.jsonl"),
            [
                "{malformed",
                JSON.stringify({
                    message: {
                        content: "Write task from session file",
                        role: "user",
                    },
                    runId: "writer-run",
                }),
                JSON.stringify({
                    message: {
                        content: [
                            {
                                partialJson: '{"file_path":"/tmp/output.md"}',
                                type: "toolCall",
                                name: "write",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "writer-run",
                }),
            ].join("\n")
        );
        writeFileSync(
            path.join(browserSessions, "session.jsonl"),
            [
                {
                    data: {
                        args: {
                            parameters: {
                                action: "navigate",
                                url: "https://dashboard.test",
                            },
                        },
                        name: "browser",
                        prompt: "Browse dashboard",
                    },
                    runId: "browser-run",
                    type: "prompt.submitted",
                },
                {
                    data: {
                        args: {
                            parameters: {
                                action: "navigate",
                                url: "https://dashboard.test",
                            },
                        },
                        name: "browser",
                    },
                    runId: "browser-run",
                    type: "tool.result",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
        );
        const staleFile = path.join(staleSessions, "session.jsonl");
        writeFileSync(
            staleFile,
            JSON.stringify({
                message: {
                    content: "Old task should not be active",
                    role: "user",
                },
                runId: "stale-run",
            })
        );
        const staleDate = new Date(Date.now() - 10 * 60_000);
        await Bun.write(staleFile, await Bun.file(staleFile).text());
        utimesSync(staleFile, staleDate, staleDate);
        for (const agent of responseItemAgents) {
            writeFileSync(
                path.join(agentsRoot, agent.id, "sessions", "session.jsonl"),
                [
                    {
                        message: { content: agent.task, role: "user" },
                        runId: `${agent.id}-run`,
                    },
                    {
                        payload: {
                            input: agent.input,
                            name: "exec",
                            type: "custom_tool_call",
                        },
                        runId: `${agent.id}-run`,
                        type: "response_item",
                    },
                ]
                    .map((entry) => JSON.stringify(entry))
                    .join("\n")
            );
        }
        writeFileSync(
            path.join(auditorSessions, "session.jsonl"),
            [
                {
                    message: {
                        __openclaw: { mirrorIdentity: "audit-turn:user" },
                        content: [
                            { text: "Audit backend coverage", type: "text" },
                            { text: '```json\n{"ignore":true}\n```', type: "text" },
                        ],
                        role: "user",
                    },
                    runId: "audit-run",
                },
                {
                    payload: {
                        input: 'await tools.exec_command({"cmd":"git status --short"})',
                        name: "exec",
                        type: "custom_tool_call",
                    },
                    runId: "audit-run",
                    type: "response_item",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
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
            list: [
                { id: "mira-2026" },
                { id: "coder" },
                { id: "researcher" },
                { id: "auditor" },
                { id: "writer" },
                { id: "browser" },
                { id: "stale" },
                ...responseItemAgents.map((agent) => ({ id: agent.id })),
            ],
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
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "read /tmp/coverage.ts",
                currentTask: "Research coverage gaps",
                id: "researcher",
                model: "gpt-5.5",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "exec git status --short",
                currentTask: "Audit backend coverage",
                id: "auditor",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "write /tmp/output.md",
                currentTask: "Write task from session file",
                id: "writer",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "browser navigate https://dashboard.test",
                currentTask: "Browse dashboard",
                id: "browser",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: undefined,
                currentTask: undefined,
                id: "stale",
                status: "idle",
            })
        );
        for (const agent of responseItemAgents) {
            expect(statuses).toContainEqual(
                expect.objectContaining({
                    currentActivity: agent.activity,
                    currentTask: agent.task,
                    id: agent.id,
                    status: "active",
                })
            );
        }
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
        await expect(runExecOnce({ args: [], command: "node/child" })).rejects.toThrow(
            "command must be an approved executable name"
        );
        await expect(runExecOnce({ args: [], command: "node" })).rejects.toThrow(
            "command executable is not approved"
        );
        await expect(
            runExecOnce({ args: ["-lc", "echo hi"], command: "bash" })
        ).rejects.toThrow("bash argv execution requires job tracking");
        await expect(
            runExecOnce({
                args: "not-array",
                command: "__mira_dashboard_shell_smoke_test__",
            })
        ).rejects.toThrow("args must be an array");
        await expect(
            runExecOnce({ args: [42], command: "__mira_dashboard_shell_smoke_test__" })
        ).rejects.toThrow("all args must be strings");
        await expect(
            runExecOnce({
                args: ["bad\0arg"],
                command: "__mira_dashboard_shell_smoke_test__",
            })
        ).rejects.toThrow("args cannot contain null bytes");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: 42,
                shell: true,
            })
        ).rejects.toThrow("cwd must be a string");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: "relative",
                shell: true,
            })
        ).rejects.toThrow("cwd must be an absolute path");
        const execFileCwd = path.join(createTemporaryRoot("mira-exec-cwd-"), "file");
        writeFileSync(execFileCwd, "not a directory");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: execFileCwd,
                shell: true,
            })
        ).rejects.toThrow("cwd must be a directory");
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
        expect(() =>
            startExecJob({ args: ["-lc", "x".repeat(4097)], command: "bash" })
        ).toThrow("command exceeds maximum length");
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

    it("starts, stops, and reports exec jobs through the service lifecycle", async () => {
        const { getExecJob, registerExecExecutionActions, startExecJob, stopExecJob } =
            await import("../src/services/execJobs.ts");
        const exit = Promise.withResolvers<number>();
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: () => {
                        exit.resolve(143);
                    },
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const { jobId } = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(getExecJob(jobId)).toMatchObject({
                jobId,
                status: "running",
            });
            await waitFor(() => spawnSpy.mock.calls.length === 1, 3000);
            expect(stopExecJob(jobId)).toEqual({
                isSuccess: true,
                message: "Stop signal sent",
            });
            await waitFor(() => getExecJob(jobId).status === "done", 3000);
            expect(() => stopExecJob(jobId)).toThrow("Job is not running");
        } finally {
            exit.resolve(0);
            await Bun.sleep(0);
            spawnSpy.mockRestore();
        }
    });

    it("serializes concurrent exec jobs through global execution capacity", async () => {
        const { registerExecExecutionActions, startExecJob } =
            await import("../src/services/execJobs.ts");
        const exits: Array<ReturnType<typeof Promise.withResolvers<number>>> = [];
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                const exit = Promise.withResolvers<number>();
                exits.push(exit);
                return {
                    exited: exit.promise,
                    kill: () => {},
                    pid: 987,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(""),
                } as unknown as processModule.BunProcess;
            });
        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const first = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            const second = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(first.jobId).not.toBe(second.jobId);
            await waitFor(() => exits.length === 1, 3000);
            exits[0]?.resolve(0);
            await waitFor(() => exits.length === 2, 3000);
            exits[1]?.resolve(0);
        } finally {
            for (const exit of exits) {
                exit.resolve(0);
            }
            await Bun.sleep(0);
            spawnSpy.mockRestore();
        }
    });

    it("records exec process failures and trims oversized output", async () => {
        const { getExecJob, registerExecExecutionActions, runExecOnce, startExecJob } =
            await import("../src/services/execJobs.ts");
        const longOutput = `${"x".repeat(101_000)}tail`;
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(longOutput),
                }) as unknown as processModule.BunProcess
        );

        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const once = await runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(once.code).toBe(0);
            expect(once.stdout).toHaveLength(10_000);
            expect(once.stdout.endsWith("tail")).toBe(true);
        } finally {
            spawnSpy.mockRestore();
        }

        const failingSpawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(
                () =>
                    ({
                        exited: Promise.reject(new Error("spawn exit failed")),
                        kill: () => {},
                        pid: 456,
                        stderr: readableUtf8Stream("before failure"),
                        stdout: readableUtf8Stream(""),
                    }) as unknown as processModule.BunProcess
            );
        try {
            const started = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            const deadline = Date.now() + 2000;
            let job = getExecJob(started.jobId);
            while (job.status === "running" && Date.now() < deadline) {
                await Bun.sleep(10);
                job = getExecJob(started.jobId);
            }
            expect(job).toMatchObject({
                code: 1,
                status: "done",
            });
            expect(job.stderr).toContain("spawn exit failed");
        } finally {
            failingSpawnSpy.mockRestore();
        }
    });

    it("validates scheduled job action and schedule boundaries", async () => {
        const {
            calculateNextRunAt,
            listScheduledJobRuns,
            registerScheduledJobAction,
            updateScheduledJob,
            upsertScheduledJob,
        } = await import("../src/services/scheduledJobs.ts");
        const jobId = `test-job-validation-${Bun.randomUUIDv7()}`;

        try {
            expect(() => registerScheduledJobAction("Bad.Action", () => {})).toThrow(
                "Job action key is invalid"
            );
            expect(() =>
                registerScheduledJobAction("test.timeout", () => {}, { timeoutMs: 0 })
            ).toThrow(
                "Scheduled job action timeout must be an integer between 1 and 2147483647"
            );
            expect(() =>
                upsertScheduledJob({
                    actionKey: "test.validation",
                    enabled: true,
                    id: jobId,
                    intervalSeconds: 30,
                    name: "Coverage validation job",
                    scheduleType: "interval",
                })
            ).toThrow("Interval must be at least 60 seconds");
            expect(() =>
                calculateNextRunAt({
                    cronExpression: "61 * * * *",
                    enabled: true,
                    intervalSeconds: 3600,
                    scheduleType: "cron",
                    timeOfDay: undefined,
                })
            ).toThrow("Cron jobs require a valid cronExpression");

            const job = upsertScheduledJob({
                actionKey: "test.validation",
                enabled: true,
                id: jobId,
                intervalSeconds: 3600,
                name: "Coverage validation job",
                scheduleType: "daily",
                timeOfDay: "23:59",
            });
            expect(job.nextRunAt).toEqual(expect.any(String));
            expect(updateScheduledJob("missing-job", { enabled: false })).toBeUndefined();
            expect(() =>
                updateScheduledJob(jobId, {
                    cronExpression: "not cron",
                    scheduleType: "cron",
                })
            ).toThrow("Cron jobs require a valid cronExpression");
            expect(listScheduledJobRuns(jobId, -20)).toEqual([]);
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id = ?")
                .run(jobId);
            database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(jobId);
        }
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

        const { registerOpenClawExecutionActions } =
            await import("../src/services/openclawActions.ts");
        registerOpenClawExecutionActions();
        await startTestScheduledExecutor();
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
        const dockerRunSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (_command, arguments_) => {
                const joined = arguments_.join(" ");
                if (joined.includes("ps -a")) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: `${JSON.stringify({
                            Command: "sleep 100",
                            CreatedAt: "2026-06-26 01:00:00 +0000 UTC",
                            ID: "abc123",
                            Image: "unit/web:latest",
                            Labels: "",
                            Mounts: "",
                            Names: "unit-web",
                            Networks: "bridge",
                            Ports: "",
                            RunningFor: "1 minute",
                            State: "running",
                            Status: "Up 1 minute",
                        })}\n`,
                    };
                }
                if (joined.includes("stats --no-stream")) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: `${JSON.stringify({
                            BlockIO: "0B / 0B",
                            CPUPerc: "0.00%",
                            ID: "abc123",
                            MemPerc: "0.00%",
                            MemUsage: "1MiB / 1GiB",
                            NetIO: "0B / 0B",
                            PIDs: "1",
                        })}\n`,
                    };
                }
                if (arguments_[0] === "inspect") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: JSON.stringify([
                            {
                                Config: {
                                    Env: ["API_TOKEN=secret", "PLAIN=value"],
                                    Labels: { "com.docker.compose.service": "web" },
                                },
                                Created: "2026-06-26T01:00:00.000Z",
                                Id: "abc123full",
                                Image: "sha256:image",
                                Mounts: [],
                                NetworkSettings: { Networks: {} },
                                RestartCount: 0,
                                State: { StartedAt: "2026-06-26T01:00:00.000Z" },
                            },
                        ]),
                    };
                }
                return { code: 1, stderr: `unexpected docker ${joined}`, stdout: "" };
            });
        const dockerSpawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                throw new Error("docker exec spawn failed");
            });
        try {
            const { registerDockerExecutionActions } =
                await import("../src/services/dockerActions.ts");
            registerDockerExecutionActions();
            await startTestScheduledExecutor();
            const execStart = await dockerRoutes["/api/docker/exec/start"].POST(
                new Request("https://dashboard.test/api/docker/exec/start", {
                    body: JSON.stringify({
                        command: "echo hello",
                        containerId: "unit-web",
                    }),
                    method: "POST",
                })
            );
            const execStartBody = (await execStart.json()) as { jobId: string };
            await waitFor(() => {
                const row = database
                    .prepare("SELECT status FROM job_executions WHERE id = ?")
                    .get(execStartBody.jobId) as { status?: string } | undefined;
                return row?.status === "failed";
            }, 3000);
            const failedExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
                Object.assign(
                    new Request(
                        `https://dashboard.test/api/docker/exec/${execStartBody.jobId}`
                    ),
                    { params: { jobId: execStartBody.jobId } }
                )
            );
            await expect(failedExec.json()).resolves.toMatchObject({
                code: 1,
                containerId: "abc123",
                stderr: "docker exec spawn failed",
                status: "done",
            });
            const stopFinished = await dockerRoutes["/api/docker/exec/:jobId/stop"].POST(
                Object.assign(
                    new Request(
                        `https://dashboard.test/api/docker/exec/${execStartBody.jobId}/stop`,
                        { method: "POST" }
                    ),
                    { params: { jobId: execStartBody.jobId } }
                )
            );
            expect(stopFinished.status).toBe(400);
            await expect(stopFinished.json()).resolves.toEqual({
                error: "Job is not running",
            });
        } finally {
            dockerRunSpy.mockRestore();
            dockerSpawnSpy.mockRestore();
        }
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

            rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
            const appsRoot = createTemporaryRoot("mira-docker-route-unsupported-");
            const appRoot = path.join(appsRoot, appSlug);
            mkdirSync(appRoot, { recursive: true });
            writeFileSync(
                path.join(appRoot, "compose.yaml"),
                [
                    "services:",
                    "  api:",
                    "    image: example.com/unit/api:1.0.0",
                    "    labels:",
                    "      mira.updater.enabled: 'true'",
                    "",
                ].join("\n")
            );
            process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;
            const { registerDockerUpdaterScheduledJobs, registerDockerUpdaterServices } =
                await import("../src/services/dockerUpdater.ts");
            registerDockerUpdaterScheduledJobs();
            await expect(registerDockerUpdaterServices()).resolves.toMatchObject({
                isOk: true,
            });
            const unsupportedService = database
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE app_slug = ? AND service_name = 'api'"
                )
                .get(appSlug) as { id: number };
            const unsupportedRequest = Object.assign(
                new Request(
                    `https://dashboard.test/api/docker/updater/services/${unsupportedService.id}/update`,
                    { method: "POST" }
                ),
                { params: { serviceId: String(unsupportedService.id) } }
            );
            const unsupportedResponse =
                await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                    unsupportedRequest
                );
            expect(unsupportedResponse.status).toBe(422);
            await expect(unsupportedResponse.json()).resolves.toEqual({
                error: "Unsupported image registry: example.com",
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
        const scheduledDueId = `test-job-scheduled-due-${Bun.randomUUIDv7()}`;
        const scheduledFutureId = `test-job-scheduled-future-${Bun.randomUUIDv7()}`;
        const scheduledDisabledId = `test-job-scheduled-disabled-${Bun.randomUUIDv7()}`;
        const {
            calculateNextRunAt,
            enqueueScheduledJob,
            getScheduledJob,
            isScheduledJobValidationError,
            listScheduledJobs,
            listScheduledJobRuns,
            registerScheduledJobAction,
            removeScheduledJobsNotInAction,
            runScheduledJob,
            startScheduledJobExecutor,
            stopScheduledJobExecutor,
            updateScheduledJob,
            upsertScheduledJob,
        } = await import("../src/services/scheduledJobs.ts");
        const { cancelJobExecution } =
            await import("../src/services/jobExecutionQueue.ts");

        try {
            startScheduledJobExecutor();
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
                        enabled: false,
                        intervalSeconds: 90,
                        scheduleType: "interval",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBeUndefined();
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "daily",
                        timeOfDay: "12:30",
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-24T12:30:00.000Z");
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
            expect(
                calculateNextRunAt(
                    {
                        cronExpression: "0 9 * * 7",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toBe("2026-06-28T09:00:00.000Z");
            expect(() =>
                calculateNextRunAt(
                    {
                        cronExpression: "bad cron",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toThrow("Cron jobs require a valid cronExpression");
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
            expect(() =>
                upsertScheduledJob({
                    actionKey,
                    enabled: true,
                    id: `test-job-invalid-daily-${Bun.randomUUIDv7()}`,
                    intervalSeconds: 120,
                    name: "Invalid daily job",
                    scheduleType: "daily",
                    timeOfDay: "25:00",
                })
            ).toThrow("Daily jobs require HH:MM timeOfDay");
            expect(() =>
                registerScheduledJobAction(
                    `bad-timeout-${Bun.randomUUIDv7()}`,
                    () => ({}),
                    {
                        timeoutMs: 0,
                    }
                )
            ).toThrow(
                "Scheduled job action timeout must be an integer between 1 and 2147483647"
            );

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

            const manualRun = enqueueScheduledJob(keepId);
            expect(() => enqueueScheduledJob(keepId)).toThrow(
                "Scheduled job is already queued or running"
            );
            cancelJobExecution(manualRun.executionId as string);

            const result = await runScheduledJob(keepId);
            expect(result).toMatchObject({
                jobId: keepId,
                output: { jobId: keepId, payloadValue: 42 },
                status: "success",
                triggerType: "manual",
            });
            expect(listScheduledJobRuns(keepId, 2)).toHaveLength(2);

            upsertScheduledJob({
                actionKey,
                actionPayload: { value: "scheduled" },
                enabled: true,
                id: scheduledDueId,
                intervalSeconds: 120,
                name: "Scheduled due job",
                scheduleType: "interval",
            });
            database
                .prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?")
                .run("2026-01-01T00:00:00.000Z", scheduledDueId);
            const scheduledRun = await runScheduledJob(scheduledDueId, "schedule");
            expect(scheduledRun).toMatchObject({
                jobId: scheduledDueId,
                output: { jobId: scheduledDueId, payloadValue: "scheduled" },
                status: "success",
                triggerType: "schedule",
            });
            expect(getScheduledJob(scheduledDueId)?.nextRunAt).not.toBe(
                "2026-01-01T00:00:00.000Z"
            );

            upsertScheduledJob({
                actionKey,
                actionPayload: { value: "future" },
                enabled: true,
                id: scheduledFutureId,
                intervalSeconds: 120,
                name: "Scheduled future job",
                scheduleType: "interval",
            });
            await expect(
                runScheduledJob(scheduledFutureId, "schedule")
            ).rejects.toMatchObject({
                statusCode: 409,
            });

            upsertScheduledJob({
                actionKey,
                actionPayload: { value: "disabled" },
                enabled: false,
                id: scheduledDisabledId,
                intervalSeconds: 120,
                name: "Scheduled disabled job",
                scheduleType: "interval",
            });
            await expect(
                runScheduledJob(scheduledDisabledId, "schedule")
            ).rejects.toMatchObject({
                statusCode: 409,
            });

            database
                .prepare("UPDATE scheduled_job_runs SET output_json = ? WHERE job_id = ?")
                .run("not json", keepId);
            expect(listScheduledJobRuns(keepId, 0)).toHaveLength(2);
            expect(listScheduledJobRuns(keepId, 1)).toHaveLength(1);
            expect(getScheduledJob(keepId)?.lastRun?.output).toEqual({});
            expect(
                listScheduledJobs().find((job) => job.id === keepId)?.lastRun?.output
            ).toEqual({});

            removeScheduledJobsNotInAction(actionKey, [keepId]);
            expect(getScheduledJob(keepId)).toBeDefined();
            expect(getScheduledJob(pruneId)).toBeUndefined();
            expect(getScheduledJob(scheduledDueId)).toBeUndefined();

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

            const timeoutActionKey = `test-timeout-action-${Bun.randomUUIDv7()}`;
            const timeoutJobId = `test-job-timeout-${Bun.randomUUIDv7()}`;
            let isTimeoutHandlerSettled = false;
            registerScheduledJobAction(
                timeoutActionKey,
                async () => {
                    try {
                        await Bun.sleep(50);
                        return { late: true };
                    } finally {
                        isTimeoutHandlerSettled = true;
                    }
                },
                { timeoutMs: 1 }
            );
            upsertScheduledJob({
                actionKey: timeoutActionKey,
                id: timeoutJobId,
                intervalSeconds: 120,
                name: "Timeout job",
                scheduleType: "interval",
            });
            const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await expect(runScheduledJob(timeoutJobId)).resolves.toMatchObject({
                    jobId: timeoutJobId,
                    message: "Scheduled job timed out",
                    output: {},
                    status: "failed",
                });
                expect(isTimeoutHandlerSettled).toBe(true);
            } finally {
                warnSpy.mockRestore();
            }

            const abortActionKey = `test-abort-action-${Bun.randomUUIDv7()}`;
            const abortJobId = `test-job-abort-${Bun.randomUUIDv7()}`;
            registerScheduledJobAction(abortActionKey, () => ({ reached: true }));
            upsertScheduledJob({
                actionKey: abortActionKey,
                id: abortJobId,
                intervalSeconds: 120,
                name: "Abort job",
                scheduleType: "interval",
            });
            const controller = new AbortController();
            controller.abort();
            await expect(
                runScheduledJob(abortJobId, "manual", controller.signal)
            ).rejects.toHaveProperty("name", "AbortError");
        } finally {
            await stopScheduledJobExecutor();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'test-job-%'")
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'test-job-%'")
                .run();
        }
    });
});
