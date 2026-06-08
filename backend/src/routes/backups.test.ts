import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";

import { withEnv } from "../testUtils/env.js";
import backupRoutes from "./backups.js";
import { __testing as backupTesting } from "./backups.js";

type FakeBackupListener = (...args: unknown[]) => void;

function createFakeBackupChild() {
    const listeners = new Map<string, Set<FakeBackupListener>>();
    const child = {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on(event: string, listener: FakeBackupListener) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
            return this;
        },
        once(event: string, listener: FakeBackupListener) {
            const onceListener: FakeBackupListener = (...args) => {
                this.off(event, onceListener);
                listener(...args);
            };
            return this.on(event, onceListener);
        },
        off(event: string, listener: FakeBackupListener) {
            listeners.get(event)?.delete(listener);
            return this;
        },
        emit(event: string, ...args: unknown[]) {
            for (const listener of listeners.get(event) ?? []) {
                listener(...args);
            }
        },
    };
    return child;
}

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalBackupShell = process.env.MIRA_BACKUP_SHELL;

async function installFakeShell(tempDir: string): Promise<string> {
    const shellPath = path.join(tempDir, "backup-shell");
    await writeFile(
        shellPath,
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const command = args.at(-1) || "";
if (process.env.FAKE_BACKUP_SIGNAL === "1") {
    process.kill(process.pid, "SIGTERM");
    setInterval(() => {}, 1000);
} else {
    process.stdout.write("started backup\n" + command + "\n");
    process.stderr.write("backup warning\n");
    if (process.env.FAKE_BACKUP_HOLD_UNTIL) {
        const fs = require("node:fs");
        const timer = setInterval(() => {
            if (fs.existsSync(process.env.FAKE_BACKUP_HOLD_UNTIL)) {
                clearInterval(timer);
                process.exit(0);
            }
        }, 10);
        return;
    }
    setTimeout(() => process.exit(0), 10);
}
`,
        "utf8"
    );
    await chmod(shellPath, 0o755);
    return shellPath;
}

async function createTestServer(backupShell: string): Promise<TestServer> {
    const savedBackupShell = process.env.MIRA_BACKUP_SHELL;
    const restoreEnv = () => {
        if (savedBackupShell === undefined) {
            delete process.env.MIRA_BACKUP_SHELL;
        } else {
            process.env.MIRA_BACKUP_SHELL = savedBackupShell;
        }
    };

    process.env.MIRA_BACKUP_SHELL = backupShell;
    try {
        const app = express();
        app.use(express.json());
        backupRoutes(app, express);
        const server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise<void>((resolve, reject) =>
                    server.close((error) => {
                        restoreEnv();
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    })
                ),
        };
    } catch (error) {
        restoreEnv();
        throw error;
    }
}

async function startServer(tempDir: string): Promise<TestServer> {
    return createTestServer(await installFakeShell(tempDir));
}

async function startServerWithBackupShell(backupShell: string): Promise<TestServer> {
    return createTestServer(backupShell);
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

async function waitForDone(
    server: TestServer,
    pathName: string
): Promise<{ status: string; code: number; stdout: string; stderr: string }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await requestJson<{
            job: { status: string; code: number; stdout: string; stderr: string } | null;
        }>(server, pathName);
        if (response.body.job?.status === "done") {
            return response.body.job;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Backup job did not finish");
}

async function waitForRefresh(key: string, refreshedKeys: string[]): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (refreshedKeys.includes(key)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Backup refresh did not finish for ${key}`);
}

describe("backup routes", () => {
    let server: TestServer;
    let tempDir: string;
    const refreshedKeys: string[] = [];

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-backup-routes-"));
        backupTesting.clearJobsForTest();
        backupTesting.setRefreshBackupCacheForTest(async (key) => {
            refreshedKeys.push(key);
            return { refreshed: [key] };
        });
        server = await startServer(tempDir);
    });

    beforeEach(() => {
        backupTesting.clearJobsForTest();
        refreshedKeys.length = 0;
    });

    after(async () => {
        backupTesting.clearJobsForTest();
        backupTesting.setRefreshBackupCacheForTest();
        await server.close();
        if (originalBackupShell === undefined) {
            delete process.env.MIRA_BACKUP_SHELL;
        } else {
            process.env.MIRA_BACKUP_SHELL = originalBackupShell;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it("reports no active backup jobs initially", async () => {
        const kopia = await requestJson<{ job: null }>(server, "/api/backups/kopia");
        const walg = await requestJson<{ job: null }>(server, "/api/backups/walg");

        assert.equal(kopia.status, 200);
        assert.deepEqual(kopia.body, { job: null });
        assert.equal(walg.status, 200);
        assert.deepEqual(walg.body, { job: null });
    });

    it("reclaims completed active jobs before starting replacement backup jobs", async () => {
        backupTesting.clearJobsForTest();
        backupTesting.setSpawnBackupProcessForTest(() => {
            const child = createFakeBackupChild();
            queueMicrotask(() => {
                child.emit("spawn");
            });
            return child as never;
        });
        try {
            for (const type of ["kopia", "walg"] as const) {
                backupTesting.setActiveJobForTest(type, {
                    id: `old-${type}`,
                    type,
                    status: "done",
                    code: 0,
                    stdout: "",
                    stderr: "",
                    startedAt: 1,
                    endedAt: 2,
                    refreshPending: true,
                });
                const job = await backupTesting.startBackupJob(type, "true");
                assert.equal(job.id, `old-${type}`);
                assert.equal(job.refreshPending, true);
            }
        } finally {
            backupTesting.setSpawnBackupProcessForTest();
            backupTesting.clearJobsForTest();
        }
    });

    it("clears completed active job ids before starting replacements", async () => {
        backupTesting.clearJobsForTest();
        backupTesting.setSpawnBackupProcessForTest(() => {
            const child = createFakeBackupChild();
            queueMicrotask(() => {
                child.emit("spawn");
            });
            return child as never;
        });
        try {
            for (const type of ["kopia", "walg"] as const) {
                backupTesting.clearJobsForTest();

                backupTesting.setActiveJobForTest(type, {
                    id: `done-${type}`,
                    type,
                    status: "done",
                    code: 0,
                    stdout: "",
                    stderr: "",
                    startedAt: 1,
                    endedAt: 2,
                    refreshPending: false,
                });
                const replacement = await backupTesting.startBackupJob(type, "true");
                assert.notEqual(replacement.id, `done-${type}`);
                assert.equal(replacement.status, "running");
            }
        } finally {
            backupTesting.setSpawnBackupProcessForTest();
            backupTesting.clearJobsForTest();
        }
    });

    it("does not acknowledge backup jobs that fail to spawn", async () => {
        backupTesting.setSpawnBackupProcessForTest(() => {
            const child = createFakeBackupChild();
            queueMicrotask(() => {
                child.emit("error", new Error("spawn failed"));
            });
            return child as never;
        });
        try {
            const response = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );

            assert.equal(response.status, 500);
            assert.match(response.body.error, /spawn failed/u);
            const current = await requestJson<{ job: null }>(
                server,
                "/api/backups/kopia"
            );
            assert.equal(current.status, 200);
            assert.equal(current.body.job, null);
        } finally {
            backupTesting.setSpawnBackupProcessForTest();
            backupTesting.clearJobsForTest();
        }
    });

    it("starts and completes Kopia backup jobs through the configured shell", async () => {
        const started = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/kopia/run", { method: "POST" });

        assert.equal(started.status, 200);
        assert.equal(started.body.ok, true);
        assert.equal(started.body.job.type, "kopia");
        assert.equal(started.body.job.status, "running");
        assert.equal(started.body.job.code, null);

        const done = await waitForDone(server, "/api/backups/kopia");
        assert.equal(done.status, "done");
        assert.equal(done.code, 0);
        assert.match(done.stdout, /\/opt\/docker\/apps\/kopia\/backup\.sh/);
        assert.equal(done.stderr, "backup warning\n");
        await waitForRefresh("backup.kopia.status", refreshedKeys);
        assert.ok(refreshedKeys.includes("backup.kopia.status"));

        const restarted = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/kopia/run", { method: "POST" });
        assert.equal(restarted.status, 200);
        assert.notEqual(restarted.body.job.id, started.body.job.id);
        await waitForDone(server, "/api/backups/kopia");
    });

    it("starts and completes WAL-G backup jobs through the configured shell", async () => {
        const started = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/walg/run", { method: "POST" });

        assert.equal(started.status, 200);
        assert.equal(started.body.ok, true);
        assert.equal(started.body.job.type, "walg");
        assert.equal(started.body.job.status, "running");
        assert.equal(started.body.job.code, null);

        const done = await waitForDone(server, "/api/backups/walg");
        assert.equal(done.status, "done");
        assert.equal(done.code, 0);
        assert.match(done.stdout, /'docker' exec walg/);
        assert.equal(done.stderr, "backup warning\n");
        await waitForRefresh("backup.walg.status", refreshedKeys);
        assert.ok(refreshedKeys.includes("backup.walg.status"));

        const restarted = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/walg/run", { method: "POST" });
        assert.equal(restarted.status, 200);
        assert.notEqual(restarted.body.job.id, started.body.job.id);
        await waitForDone(server, "/api/backups/walg");
    });

    it("uses configured Docker binary for WAL-G backup jobs", async () => {
        await withEnv({ MIRA_DOCKER_BIN: "/tmp/mira docker" }, async () => {
            const started = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string; code: number | null };
            }>(server, "/api/backups/walg/run", { method: "POST" });

            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.type, "walg");

            const done = await waitForDone(server, "/api/backups/walg");
            assert.equal(done.status, "done");
            assert.equal(done.code, 0);
            assert.match(
                done.stdout,
                /'\/tmp\/mira docker' exec walg \/bin\/sh \/usr\/local\/bin\/backup-push\.sh/u
            );
            await waitForRefresh("backup.walg.status", refreshedKeys);
            assert.ok(refreshedKeys.includes("backup.walg.status"));
        });
    });

    it("returns the active job when a Kopia backup is already running", async () => {
        const releasePath = path.join(tempDir, "release-kopia");
        await withEnv({ FAKE_BACKUP_HOLD_UNTIL: releasePath }, async () => {
            const firstResp = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            const secondResp = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string };
            }>(server, "/api/backups/kopia/run", { method: "POST" });

            assert.equal(firstResp.status, 200);
            assert.equal(firstResp.body.ok, true);
            assert.equal(firstResp.body.job.status, "running");
            assert.equal(secondResp.status, 200);
            assert.equal(secondResp.body.ok, true);
            assert.equal(secondResp.body.job.id, firstResp.body.job.id);
            assert.equal(secondResp.body.job.status, "running");

            await writeFile(releasePath, "release", "utf8");
            await waitForDone(server, "/api/backups/kopia");
        });
    });

    it("maps signaled backup exits to interrupted status code", async () => {
        process.env.FAKE_BACKUP_SIGNAL = "1";
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/kopia/run", { method: "POST" });

            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.status, "running");
            assert.equal(started.body.job.code, null);

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.status, "done");
            assert.equal(done.code, 130);
        } finally {
            delete process.env.FAKE_BACKUP_SIGNAL;
        }
    });

    it("does not acknowledge backup jobs when the configured shell is missing", async () => {
        const brokenTempDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-backup-broken-")
        );
        const brokenServer = await startServerWithBackupShell(
            path.join(brokenTempDir, "missing-shell")
        );
        try {
            const started = await requestJson<{ error: string }>(
                brokenServer,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(started.status, 500);
            assert.match(started.body.error, /ENOENT|missing-shell/u);

            const current = await requestJson<{ job: null }>(
                brokenServer,
                "/api/backups/kopia"
            );
            assert.equal(current.status, 200);
            assert.equal(current.body.job, null);
        } finally {
            try {
                await brokenServer.close();
            } finally {
                await rm(brokenTempDir, { recursive: true, force: true });
            }
        }
    });

    it("clears active jobs when spawn throws synchronously", async () => {
        backupTesting.setSpawnBackupProcessForTest(() => {
            throw new Error("spawn crashed");
        });
        try {
            const failed = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, "spawn crashed");

            const active = await requestJson<{ job: unknown }>(
                server,
                "/api/backups/kopia"
            );
            assert.equal(active.status, 200);
            assert.equal(active.body.job, null);

            const failedWalg = await requestJson<{ error: string }>(
                server,
                "/api/backups/walg/run",
                { method: "POST" }
            );
            assert.equal(failedWalg.status, 500);
            assert.equal(failedWalg.body.error, "spawn crashed");

            const activeWalg = await requestJson<{ job: unknown }>(
                server,
                "/api/backups/walg"
            );
            assert.equal(activeWalg.status, 200);
            assert.equal(activeWalg.body.job, null);
        } finally {
            backupTesting.setSpawnBackupProcessForTest();
        }
    });

    it("records status refresh failures after successful backup jobs", async () => {
        const refresh = {
            reject: undefined as ((error: Error) => void) | undefined,
        };
        backupTesting.setRefreshBackupCacheForTest(async () => {
            return await new Promise<{ refreshed: string[] }>((_resolve, reject) => {
                refresh.reject = reject;
            });
        });
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { type: string; status: string };
            }>(server, "/api/backups/walg/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.type, "walg");

            let sawPendingRefresh = false;
            for (let attempt = 0; attempt < 30; attempt += 1) {
                const pending = await requestJson<{
                    job: {
                        refreshPending: boolean;
                        status: string;
                        stderr: string;
                    } | null;
                }>(server, "/api/backups/walg");
                if (pending.body.job?.refreshPending && refresh.reject) {
                    assert.equal(pending.body.job.status, "done");
                    assert.equal(
                        pending.body.job.stderr.includes("Status refresh failed"),
                        false
                    );
                    sawPendingRefresh = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (!refresh.reject) {
                assert.fail("Backup refresh did not start");
            }
            assert.equal(sawPendingRefresh, true);
            refresh.reject(new Error("refresh crashed"));

            for (let attempt = 0; attempt < 30; attempt += 1) {
                const done = await requestJson<{
                    job: { status: string; stderr: string } | null;
                }>(server, "/api/backups/walg");
                if (
                    done.body.job?.status === "done" &&
                    done.body.job.stderr.includes(
                        "Status refresh failed: refresh crashed"
                    )
                ) {
                    assert.match(done.body.job.stderr, /backup warning/);
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.fail("Backup refresh failure was not recorded");
        } finally {
            backupTesting.setRefreshBackupCacheForTest(async (key) => {
                refreshedKeys.push(key);
                return { refreshed: [key] };
            });
        }
    });

    it("covers backup helper edge cases directly", async () => {
        let cleared = false;
        const missing = backupTesting.getCurrentJob("missing-job", () => {
            cleared = true;
        });

        assert.equal(missing, null);
        assert.equal(cleared, true);
        assert.equal(
            backupTesting.getCurrentJob(null, () => {}),
            null
        );
        assert.equal(backupTesting.mapJob(null), null);
        assert.equal(backupTesting.trimOutput("x".repeat(100_001)).length, 100_000);
        await withEnv({ MIRA_BACKUP_SHELL: "" }, async () => {
            assert.equal(backupTesting.getBackupShell(), "bash");
        });
        assert.equal(typeof backupTesting.getBackupShell(), "string");
        await withEnv({ MIRA_DOCKER_BIN: "" }, async () => {
            assert.equal(backupTesting.getDockerBin(), "docker");
        });
        assert.equal(backupTesting.shellQuote("can't"), String.raw`'can'\''t'`);
    });
});
