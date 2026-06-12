import assert from "node:assert/strict";
import { type ChildProcess, type spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";

import { db } from "../db.js";
import { withEnv } from "../testUtils/env.js";
import backupRoutes from "./backups.js";
import { __testing as backupTesting } from "./backups.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

interface FakeBackupProcess extends ChildProcess {
    stderr: PassThrough;
    stdout: PassThrough;
}

const originalDockerBin = process.env.MIRA_DOCKER_BIN;

async function installFakeDocker(tempDir: string): Promise<string> {
    const dockerPath = path.join(tempDir, "docker");
    await writeFile(
        dockerPath,
        `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "exec kopia kopia snapshot list --all --json") {
    process.stdout.write(JSON.stringify([
        {
            id: "kopia-1",
            source: { path: "/source/docker" },
            description: "Docker snapshot",
            startTime: "2099-01-01T00:00:00.000Z",
            endTime: "2099-01-01T00:01:00.000Z",
            stats: { fileCount: 2, totalSize: 512, errorCount: 0, ignoredErrorCount: 0 },
            retentionReason: ["latest"]
        }
    ]));
} else if (args === "exec walg wal-g backup-list --detail --json") {
    process.stdout.write(JSON.stringify([
        {
            backup_name: "base_2099",
            modified: "2099-01-01T00:02:00.000Z",
            wal_file_name: "000000010000000000000001",
            storage_name: "default"
        }
    ]));
} else {
    process.stderr.write("unexpected docker args: " + args);
    process.exit(2);
}
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    return dockerPath;
}

function createFakeBackupProcess(): FakeBackupProcess {
    const child = new PassThrough() as unknown as FakeBackupProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

function createFakeBackupSpawn(): typeof spawn {
    return ((_file: string, args: readonly string[]) => {
        const child = createFakeBackupProcess();
        const command = String(args.at(-1) ?? "");
        queueMicrotask(() => {
            if (process.env.FAKE_BACKUP_SIGNAL === "1") {
                child.emit("close", null, "SIGTERM");
                return;
            }
            child.stdout?.write(`started backup\n${command}\n`);
            child.stderr?.write("backup warning\n");
            if (process.env.FAKE_BACKUP_HOLD_UNTIL) {
                const timer = setInterval(() => {
                    if (existsSync(process.env.FAKE_BACKUP_HOLD_UNTIL || "")) {
                        clearInterval(timer);
                        child.emit("close", 0, null);
                    }
                }, 10);
                return;
            }
            setTimeout(() => {
                child.emit("close", 0, null);
            }, 10);
        });
        return child;
    }) as unknown as typeof spawn;
}

async function createTestServer(tempDir: string): Promise<TestServer> {
    const savedDockerBin = process.env.MIRA_DOCKER_BIN;
    const restoreEnv = () => {
        if (savedDockerBin === undefined) {
            delete process.env.MIRA_DOCKER_BIN;
        } else {
            process.env.MIRA_DOCKER_BIN = savedDockerBin;
        }
    };

    process.env.MIRA_DOCKER_BIN = await installFakeDocker(tempDir);
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
    return createTestServer(tempDir);
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

async function waitForCacheEntry(key: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const row = db
            .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
            .get(key) as { data_json: string | null } | undefined;
        if (row?.data_json) {
            return JSON.parse(row.data_json) as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Cache entry ${key} was not refreshed`);
}

describe("backup routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-backup-routes-"));
        backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        server = await startServer(tempDir);
    });

    beforeEach(() => {
        db.prepare(
            "DELETE FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status')"
        ).run();
    });

    after(async () => {
        await server.close();
        backupTesting.setSpawnBackupProcessForTest();
        if (originalDockerBin === undefined) {
            delete process.env.MIRA_DOCKER_BIN;
        } else {
            process.env.MIRA_DOCKER_BIN = originalDockerBin;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it("reports no active backup jobs initially", async () => {
        const [kopia, walg] = await Promise.all([
            requestJson<{ job: null }>(server, "/api/backups/kopia"),
            requestJson<{ job: null }>(server, "/api/backups/walg"),
        ]);

        assert.equal(kopia.status, 200);
        assert.deepEqual(kopia.body, { job: null });
        assert.equal(walg.status, 200);
        assert.deepEqual(walg.body, { job: null });
    });

    it("starts and completes Kopia backup jobs", async () => {
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
        assert.doesNotMatch(done.stdout, /backup-kopia-status\.mjs/);
        assert.equal(done.stderr, "backup warning\n");
        const cache = await waitForCacheEntry("backup.kopia.status");
        assert.equal(cache.ok, true);
        assert.equal(cache.tool, "kopia");
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

    it("starts and completes WAL-G backup jobs", async () => {
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
        assert.match(done.stdout, /docker exec walg/);
        assert.doesNotMatch(done.stdout, /backup-walg-status\.mjs/);
        assert.equal(done.stderr, "backup warning\n");
        const cache = await waitForCacheEntry("backup.walg.status");
        assert.equal(cache.ok, true);
        assert.equal(cache.tool, "wal-g");
    });

    it("records status refresh failures on successful backup jobs", async () => {
        await withEnv(
            { MIRA_DOCKER_BIN: path.join(tempDir, "missing-docker") },
            async () => {
                const started = await requestJson<{
                    ok: boolean;
                    job: { id: string; status: string };
                }>(server, "/api/backups/kopia/run", { method: "POST" });

                assert.equal(started.status, 200);
                assert.equal(started.body.ok, true);

                await new Promise((resolve) => setTimeout(resolve, 100));
                const done = await waitForDone(server, "/api/backups/kopia");
                assert.match(done.stderr, /Status refresh failed/u);
                assert.match(done.stderr, /missing-docker|ENOENT/u);
            }
        );
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

    it("marks jobs done when the backup process emits an error", async () => {
        backupTesting.setSpawnBackupProcessForTest((() => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                child.emit("error", new Error("spawn failed"));
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/walg/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.status, "running");
            assert.equal(started.body.job.code, null);

            const done = await waitForDone(server, "/api/backups/walg");
            assert.equal(done.status, "done");
            assert.equal(done.code, 1);
            assert.match(done.stderr, /spawn failed/);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
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
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
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
    });
});
