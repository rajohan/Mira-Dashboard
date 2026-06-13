import assert from "node:assert/strict";
import { type ChildProcess, type spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import express from "express";

import { db } from "../db.js";
import {
    __testing as scheduledJobsTesting,
    getScheduledJob,
    runScheduledJob,
    upsertScheduledJob,
} from "../services/scheduledJobs.js";
import { withEnv } from "../testUtils/env.js";
import backupRoutes, { registerBackupScheduledJobs } from "./backups.js";
import { __testing as backupTesting } from "./backups.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

interface FakeBackupProcess extends ChildProcess {
    stderr: PassThrough;
    stdout: PassThrough;
    killedWithSignal?: NodeJS.Signals | number;
}

const originalDockerBin = process.env.MIRA_DOCKER_BIN;
let lastFakeBackupProcess: FakeBackupProcess | null = null;
const fakeDockerExecCalls: string[][] = [];
let fakeContainerPgrepCalls = 0;

async function installFakeDocker(tempDir: string): Promise<string> {
    const dockerPath = path.join(tempDir, "docker");
    await writeFile(
        dockerPath,
        `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "exec kopia kopia snapshot list --all --json-verbose --json") {
    const writeSnapshots = () => process.stdout.write(JSON.stringify([
        {
            id: "kopia-1",
            source: { path: "/source/docker" },
            description: "Docker snapshot",
            startTime: "2099-01-01T00:00:00.000Z",
            endTime: "2099-01-01T00:01:00.000Z",
            stats: { fileCount: 2, totalSize: 512, errorCount: 0, ignoredErrorCount: 0 },
            retentionReason: ["latest"]
        },
        {
            id: "kopia-2",
            source: { path: "/source/projects" },
            endTime: "2099-01-01T00:01:00.000Z",
            stats: { fileCount: 1, totalSize: 256, errorCount: 0, ignoredErrorCount: 0 },
            retentionReason: ["latest"]
        },
        {
            id: "kopia-3",
            source: { path: "/source/openclaw" },
            endTime: "2099-01-01T00:01:00.000Z",
            stats: { fileCount: 1, totalSize: 128, errorCount: 0, ignoredErrorCount: 0 },
            retentionReason: ["latest"]
        }
    ]));
    const delayMs = Number(process.env.FAKE_DOCKER_STATUS_DELAY_MS || 0);
    if (delayMs > 0) setTimeout(writeSnapshots, delayMs);
    else writeSnapshots();
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
    if (process.env.FAKE_BACKUP_PID) {
        Object.defineProperty(child, "pid", {
            configurable: true,
            value: Number(process.env.FAKE_BACKUP_PID),
        });
    }
    child.kill = ((signal?: NodeJS.Signals | number) => {
        if (process.env.FAKE_BACKUP_KILL_THROWS === "1") {
            throw new Error("kill unavailable");
        }
        if (process.env.FAKE_BACKUP_KILL_RETURNS_FALSE === "1") {
            return false;
        }
        child.killedWithSignal = signal ?? "SIGTERM";
        if (process.env.FAKE_BACKUP_CLOSE_ON_KILL === "1") {
            queueMicrotask(() => {
                child.emit("close", null, child.killedWithSignal);
            });
        }
        return true;
    }) as ChildProcess["kill"];
    return child;
}

function createFakeBackupSpawn(): typeof spawn {
    return ((file: string, args: readonly string[]) => {
        const child = createFakeBackupProcess();
        if (file === "docker") {
            fakeDockerExecCalls.push([...args].map(String));
            queueMicrotask(() => {
                if (process.env.FAKE_DOCKER_EXEC_ERROR === "1") {
                    child.emit("error", new Error("docker exec failed"));
                    return;
                }
                if (process.env.FAKE_DOCKER_EXEC_NEVER_CLOSE === "1") {
                    return;
                }
                if (process.env.FAKE_DOCKER_EXEC_STDOUT) {
                    child.stdout.write(process.env.FAKE_DOCKER_EXEC_STDOUT);
                }
                if (process.env.FAKE_DOCKER_EXEC_STDERR) {
                    child.stderr.write(process.env.FAKE_DOCKER_EXEC_STDERR);
                }
                if (args.includes("pgrep")) {
                    fakeContainerPgrepCalls += 1;
                    let code = 1;
                    if (process.env.FAKE_CONTAINER_PGREP_CODE) {
                        code = Number(process.env.FAKE_CONTAINER_PGREP_CODE);
                    } else if (
                        process.env.FAKE_CONTAINER_PGREP_RUNNING === "1" ||
                        (process.env.FAKE_CONTAINER_PGREP_RUNNING_ONCE === "1" &&
                            fakeContainerPgrepCalls === 1)
                    ) {
                        code = 0;
                    }
                    child.emit(
                        "close",
                        process.env.FAKE_DOCKER_EXEC_NULL_CLOSE === "1" ? null : code,
                        null
                    );
                    return;
                }
                let code = 0;
                if (
                    args.includes("-KILL") &&
                    process.env.FAKE_CONTAINER_PKILL_KILL_CODE
                ) {
                    code = Number(process.env.FAKE_CONTAINER_PKILL_KILL_CODE);
                } else if (process.env.FAKE_CONTAINER_PKILL_CODE) {
                    code = Number(process.env.FAKE_CONTAINER_PKILL_CODE);
                }
                child.emit(
                    "close",
                    process.env.FAKE_DOCKER_EXEC_NULL_CLOSE === "1" ? null : code,
                    null
                );
            });
            return child;
        }

        lastFakeBackupProcess = child;
        const command = String(args.at(-1) ?? "");
        queueMicrotask(() => {
            if (process.env.FAKE_BACKUP_SIGNAL === "1") {
                child.emit("close", null, "SIGTERM");
                return;
            }
            if (process.env.FAKE_BACKUP_NULL_CLOSE === "1") {
                child.emit("close", null, null);
                return;
            }
            if (process.env.FAKE_BACKUP_EMPTY_OUTPUT !== "1") {
                child.stdout?.write(`started backup\n${command}\n`);
                child.stderr?.write("backup warning\n");
            }
            if (process.env.FAKE_BACKUP_HOLD_UNTIL) {
                const timer = setInterval(() => {
                    if (existsSync(process.env.FAKE_BACKUP_HOLD_UNTIL || "")) {
                        clearInterval(timer);
                        child.emit("close", 0, null);
                    }
                }, 10);
                return;
            }
            if (process.env.FAKE_BACKUP_NEVER_CLOSE === "1") {
                return;
            }
            setTimeout(() => {
                child.emit("close", Number(process.env.FAKE_BACKUP_EXIT_CODE || 0), null);
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

async function waitForDoneWithRefreshFailure(
    server: TestServer,
    pathName: string
): Promise<{ status: string; code: number; stdout: string; stderr: string }> {
    const deadline = Date.now() + 5_000;
    let latest = await waitForDone(server, pathName);
    while (Date.now() < deadline) {
        if (
            /Status refresh failed/u.test(latest.stderr) &&
            /missing-docker|ENOENT/u.test(latest.stderr)
        ) {
            return latest;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const response = await requestJson<{
            job: { status: string; code: number; stdout: string; stderr: string } | null;
        }>(server, pathName);
        latest = response.body.job ?? latest;
    }
    throw new Error(`Backup status refresh failure was not recorded: ${latest.stderr}`);
}

async function waitForCacheEntry(key: string): Promise<Record<string, unknown>> {
    return waitForCacheEntryAttempts(key, 40);
}

async function waitForCacheEntryAttempts(
    key: string,
    attempts: number
): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
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

async function assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
    server: TestServer,
    runPromise: Promise<{ status: string; message?: string | null }>,
    stderrPattern: RegExp,
    release: () => void
): Promise<void> {
    const result = await Promise.race([
        runPromise.then(() => "settled"),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    assert.equal(result, "pending");

    const activeWalg = await requestJson<{
        job: { status: string; stderr: string } | null;
    }>(server, "/api/backups/walg");
    assert.equal(activeWalg.status, 200);
    assert.equal(activeWalg.body.job?.status, "running");
    assert.match(activeWalg.body.job?.stderr ?? "", stderrPattern);

    release();
    lastFakeBackupProcess?.emit("close", null, "SIGTERM");
    const run = await runPromise;
    assert.equal(run.status, "failed");
    assert.match(run.message ?? "", /Backup aborted by scheduler/u);
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
        lastFakeBackupProcess = null;
        fakeDockerExecCalls.length = 0;
        fakeContainerPgrepCalls = 0;
        backupTesting.resetJobsForTest();
        backupTesting.setBackupAbortContainerTimeoutsForTest(30_000, 1_000);
        backupTesting.setBackupAbortContainerConfirmAttemptsForTest(3);
        backupTesting.setBackupAbortDockerExecTimeoutForTest(5_000);
        db.prepare(
            "DELETE FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status')"
        ).run();
        db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
    });

    after(async () => {
        await server.close();
        backupTesting.setSpawnBackupProcessForTest();
        backupTesting.setBackupAbortContainerTimeoutsForTest(30_000, 1_000);
        backupTesting.setBackupAbortContainerConfirmAttemptsForTest(3);
        backupTesting.setBackupAbortDockerExecTimeoutForTest(5_000);
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

    it("registers nightly backup schedules and starts backup jobs from scheduler", async () => {
        upsertScheduledJob({
            id: "backup.legacy",
            name: "Legacy backup",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "02:00",
            actionKey: "backup.run",
            actionPayload: { type: "walg" },
        });
        upsertScheduledJob({
            id: "cache.backup.walg",
            name: "Legacy WAL-G status refresh",
            enabled: false,
            scheduleType: "daily",
            intervalSeconds: 7200,
            timeOfDay: "04:10",
            actionKey: "cache.refresh",
            actionPayload: { key: "backup.walg.status" },
        });
        upsertScheduledJob({
            id: "cache.backup.kopia",
            name: "Legacy Kopia status refresh",
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 1800,
            actionKey: "cache.refresh",
            actionPayload: { key: "backup.kopia.status" },
        });

        registerBackupScheduledJobs();

        assert.equal(getScheduledJob("backup.legacy"), null);

        const walgJob = getScheduledJob("backup.walg");
        assert.equal(walgJob?.scheduleType, "daily");
        assert.equal(walgJob?.timeOfDay, "03:20");
        assert.equal(walgJob?.actionKey, "backup.run");
        assert.deepEqual(walgJob?.actionPayload, { type: "walg" });

        const kopiaJob = getScheduledJob("backup.kopia");
        assert.equal(kopiaJob?.scheduleType, "daily");
        assert.equal(kopiaJob?.timeOfDay, "03:50");
        assert.equal(kopiaJob?.actionKey, "backup.run");
        assert.deepEqual(kopiaJob?.actionPayload, { type: "kopia" });

        const walgStatusJob = getScheduledJob("backup.status.walg");
        assert.equal(walgStatusJob?.enabled, false);
        assert.equal(walgStatusJob?.scheduleType, "daily");
        assert.equal(walgStatusJob?.intervalSeconds, 7200);
        assert.equal(walgStatusJob?.timeOfDay, "04:10");
        assert.equal(walgStatusJob?.actionKey, "backup.status.refresh");
        assert.deepEqual(walgStatusJob?.actionPayload, { type: "walg" });

        const kopiaStatusJob = getScheduledJob("backup.status.kopia");
        assert.equal(kopiaStatusJob?.enabled, true);
        assert.equal(kopiaStatusJob?.scheduleType, "interval");
        assert.equal(kopiaStatusJob?.intervalSeconds, 1800);
        assert.equal(kopiaStatusJob?.actionKey, "backup.status.refresh");
        assert.deepEqual(kopiaStatusJob?.actionPayload, { type: "kopia" });

        const seededKopiaStatus = await waitForCacheEntry("backup.kopia.status");
        assert.equal(seededKopiaStatus.ok, true);
        assert.equal(
            (
                db
                    .prepare("SELECT COUNT(*) AS count FROM cache_entries WHERE key = ?")
                    .get("backup.walg.status") as { count: number }
            ).count,
            0
        );

        const walgRun = await runScheduledJob("backup.walg");
        assert.equal(walgRun.status, "success");
        assert.equal(
            (walgRun.output as { backup?: { type?: string; status?: string } }).backup
                ?.type,
            "walg"
        );
        assert.equal(
            (walgRun.output as { backup?: { type?: string; status?: string } }).backup
                ?.status,
            "done"
        );

        const kopiaRun = await runScheduledJob("backup.kopia");
        assert.equal(kopiaRun.status, "success");
        assert.equal(
            (kopiaRun.output as { backup?: { type?: string; status?: string } }).backup
                ?.type,
            "kopia"
        );
        assert.equal(
            (kopiaRun.output as { backup?: { type?: string; status?: string } }).backup
                ?.status,
            "done"
        );

        db.prepare("DELETE FROM cache_entries WHERE key = ?").run("backup.walg.status");
        const statusRun = await runScheduledJob("backup.status.walg");
        assert.equal(statusRun.status, "success");
        assert.deepEqual(statusRun.output, {
            key: "backup.walg.status",
            refreshed: ["backup.walg.status"],
        });
        const refreshedWalgStatus = await waitForCacheEntry("backup.walg.status");
        assert.equal(refreshedWalgStatus.ok, true);
    });

    it("rejects invalid scheduled backup payloads", async () => {
        registerBackupScheduledJobs();
        db.prepare("UPDATE scheduled_jobs SET action_payload_json = ? WHERE id = ?").run(
            JSON.stringify({ type: "postgres" }),
            "backup.walg"
        );

        const run = await runScheduledJob("backup.walg");
        assert.equal(run.status, "failed");
        assert.match(run.message ?? "", /invalid backup type/u);

        for (const payload of ["null", JSON.stringify("walg")]) {
            db.prepare(
                "UPDATE scheduled_jobs SET action_payload_json = ? WHERE id = ?"
            ).run(payload, "backup.walg");

            const shapeRun = await runScheduledJob("backup.walg");
            assert.equal(shapeRun.status, "failed");
            assert.match(shapeRun.message ?? "", /invalid backup type/u);
        }

        db.prepare("UPDATE scheduled_jobs SET action_payload_json = ? WHERE id = ?").run(
            JSON.stringify({ type: "postgres" }),
            "backup.status.walg"
        );

        const statusRun = await runScheduledJob("backup.status.walg");
        assert.equal(statusRun.status, "failed");
        assert.match(statusRun.message ?? "", /invalid backup type/u);
    });

    it("records scheduled backup failures after the process exits", async () => {
        registerBackupScheduledJobs();
        await withEnv({ FAKE_BACKUP_EXIT_CODE: "12" }, async () => {
            const run = await runScheduledJob("backup.walg");
            assert.equal(run.status, "failed");
            assert.match(run.message ?? "", /WALG backup failed with code 12/u);
            assert.match(run.message ?? "", /backup warning/u);
            const refreshedStatus = await waitForCacheEntry("backup.walg.status");
            assert.equal(refreshedStatus.ok, true);
        });
    });

    it("records scheduled backup failures without process output", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_EMPTY_OUTPUT: "1", FAKE_BACKUP_EXIT_CODE: "12" },
            async () => {
                const run = await runScheduledJob("backup.walg");
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /^WALG backup failed with code 12$/u);
            }
        );
    });

    it("refreshes backup status after manual backup failures", async () => {
        await withEnv({ FAKE_BACKUP_EXIT_CODE: "12" }, async () => {
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
            assert.equal(done.code, 12);
            const refreshedStatus = await waitForCacheEntry("backup.walg.status");
            assert.equal(refreshedStatus.ok, true);
        });
    });

    it("rejects scheduled backups when a manual backup is already running", async () => {
        const releasePath = path.join(tempDir, "release-active-manual-walg");
        await withEnv({ FAKE_BACKUP_HOLD_UNTIL: releasePath }, async () => {
            const started = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string };
            }>(server, "/api/backups/walg/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.status, "running");

            registerBackupScheduledJobs();
            const run = await runScheduledJob("backup.walg");

            assert.equal(run.status, "failed");
            assert.match(run.message ?? "", /WALG backup is already running/u);

            await writeFile(releasePath, "release", "utf8");
            const done = await waitForDone(server, "/api/backups/walg");
            assert.equal(done.status, "done");
            assert.equal(done.code, 0);
        });
    });

    it("terminates scheduled backup jobs when the scheduler aborts them", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_DOCKER_EXEC_NULL_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                const earlyResult = await Promise.race([
                    runPromise.then(() => "settled"),
                    new Promise<"pending">((resolve) => {
                        setTimeout(() => resolve("pending"), 20);
                    }),
                ]);
                assert.equal(earlyResult, "pending");
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /WALG backup failed with code 130/u);
                assert.match(run.message ?? "", /Backup aborted by scheduler/u);
                assert.equal(lastFakeBackupProcess?.killedWithSignal, "SIGTERM");

                const current = await requestJson<{
                    job: { status: string; code: number; stderr: string } | null;
                }>(server, "/api/backups/walg");
                assert.equal(current.body.job?.status, "done");
                assert.equal(current.body.job?.code, 130);
                assert.match(
                    current.body.job?.stderr ?? "",
                    /Backup aborted by scheduler/u
                );
            }
        );
    });

    it("waits for process-group close after aborting scheduled backup jobs", async () => {
        registerBackupScheduledJobs();
        const originalKill = process.kill;
        const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            signals.push([pid, signal]);
            return true;
        }) as typeof process.kill;

        try {
            await withEnv(
                { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_BACKUP_PID: "4321" },
                async () => {
                    const controller = new AbortController();
                    const runPromise = runScheduledJob(
                        "backup.walg",
                        "manual",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();

                    const earlyResult = await Promise.race([
                        runPromise.then(() => "settled"),
                        new Promise<"pending">((resolve) => {
                            setTimeout(() => resolve("pending"), 20);
                        }),
                    ]);
                    assert.equal(earlyResult, "pending");
                    assert.deepEqual(signals, [[-4321, "SIGTERM"]]);

                    lastFakeBackupProcess?.emit("close", null, "SIGTERM");
                    const run = await runPromise;

                    assert.equal(run.status, "failed");
                    assert.match(run.message ?? "", /Backup aborted by scheduler/u);
                    assert.deepEqual(signals, [[-4321, "SIGTERM"]]);
                }
            );
        } finally {
            process.kill = originalKill;
        }
    });

    it("waits for in-container WAL-G process exit after aborting scheduled backups", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            {
                FAKE_BACKUP_NEVER_CLOSE: "1",
                FAKE_CONTAINER_PGREP_RUNNING_ONCE: "1",
            },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                const earlyResult = await Promise.race([
                    runPromise.then(() => "settled"),
                    new Promise<"pending">((resolve) => {
                        setTimeout(() => resolve("pending"), 20);
                    }),
                ]);
                assert.equal(earlyResult, "pending");

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /Backup aborted by scheduler/u);
                assert.ok(
                    fakeDockerExecCalls.some((args) =>
                        args
                            .join(" ")
                            .includes("walg pkill -TERM -f /usr/local/bin/backup-push.sh")
                    )
                );
                assert.ok(
                    fakeDockerExecCalls.some((args) =>
                        args
                            .join(" ")
                            .includes("walg pgrep -f /usr/local/bin/backup-push.sh")
                    )
                );
                assert.equal(fakeContainerPgrepCalls, 2);
            }
        );
    });

    it("records in-container WAL-G termination failures", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            {
                FAKE_BACKUP_NEVER_CLOSE: "1",
                FAKE_CONTAINER_PKILL_CODE: "2",
                FAKE_DOCKER_EXEC_STDERR: "container pkill failed",
            },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                await new Promise<void>((resolve) => setImmediate(resolve));
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /container pkill failed/u);
            }
        );
    });

    it("records fallback messages for in-container WAL-G termination failures", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            {
                FAKE_BACKUP_NEVER_CLOSE: "1",
                FAKE_CONTAINER_PKILL_CODE: "2",
            },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                await new Promise<void>((resolve) => setImmediate(resolve));
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /docker exec pkill exited 2/u);
            }
        );
    });

    it("records in-container WAL-G process lookup failures", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            {
                FAKE_BACKUP_NEVER_CLOSE: "1",
                FAKE_CONTAINER_PGREP_CODE: "2",
                FAKE_DOCKER_EXEC_STDOUT: "still running",
                FAKE_DOCKER_EXEC_STDERR: "container pgrep failed",
            },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /container pgrep failed/u,
                    () => {
                        process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                    }
                );
            }
        );
    });

    it("records fallback messages for in-container WAL-G process lookup failures", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_CONTAINER_PGREP_CODE: "2" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /docker exec pgrep exited 2/u,
                    () => {
                        process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                    }
                );
            }
        );
    });

    it("bounds hung in-container WAL-G process probes", async () => {
        registerBackupScheduledJobs();
        backupTesting.setBackupAbortDockerExecTimeoutForTest(1);
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_DOCKER_EXEC_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /Timed out waiting for docker exec/u,
                    () => {
                        delete process.env.FAKE_DOCKER_EXEC_NEVER_CLOSE;
                        process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                    }
                );
            }
        );
    });

    it("records docker exec probe spawn failures", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_DOCKER_EXEC_ERROR: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /docker exec failed/u,
                    () => {
                        delete process.env.FAKE_DOCKER_EXEC_ERROR;
                        process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                    }
                );
            }
        );
    });

    it("records in-container WAL-G process termination wait timeouts", async () => {
        registerBackupScheduledJobs();
        backupTesting.setBackupAbortContainerTimeoutsForTest(10, 1);
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_CONTAINER_PGREP_CODE: "0" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /Timed out waiting/u,
                    () => {
                        process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                    }
                );
            }
        );
    });

    it("finishes aborted WAL-G jobs as needing attention after bounded confirmation retries", async () => {
        registerBackupScheduledJobs();
        backupTesting.setBackupAbortContainerTimeoutsForTest(1, 1);
        backupTesting.setBackupAbortContainerConfirmAttemptsForTest(2);
        await withEnv(
            { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_CONTAINER_PGREP_CODE: "0" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /needs attention/u);
                assert.match(run.message ?? "", /2 failed confirmation attempts/u);
                const activeWalg = await requestJson<{
                    job: { status: string } | null;
                }>(server, "/api/backups/walg");
                assert.equal(activeWalg.body.job?.status, "done");
            }
        );
    });

    it("records in-container WAL-G force termination failures", async () => {
        registerBackupScheduledJobs();
        const originalKill = process.kill;
        process.kill = ((_pid: number, _signal?: NodeJS.Signals | number) =>
            true) as typeof process.kill;

        try {
            mock.timers.enable({ apis: ["setTimeout"] });
            await withEnv(
                {
                    FAKE_BACKUP_NEVER_CLOSE: "1",
                    FAKE_BACKUP_PID: "1357",
                    FAKE_CONTAINER_PKILL_KILL_CODE: "2",
                    FAKE_DOCKER_EXEC_STDERR: "container force kill failed",
                },
                async () => {
                    const controller = new AbortController();
                    const runPromise = runScheduledJob(
                        "backup.walg",
                        "manual",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    await new Promise<void>((resolve) => setImmediate(resolve));
                    lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                    const run = await runPromise;
                    assert.equal(run.status, "failed");
                    assert.match(run.message ?? "", /container force kill failed/u);
                }
            );
        } finally {
            mock.timers.reset();
            process.kill = originalKill;
        }
    });

    it("force terminates process groups when aborted backups do not exit", async () => {
        registerBackupScheduledJobs();
        const originalKill = process.kill;
        const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            signals.push([pid, signal]);
            return true;
        }) as typeof process.kill;

        try {
            backupTesting.setBackupAbortDockerExecTimeoutForTest(20_000);
            mock.timers.enable({ apis: ["setTimeout"] });
            await withEnv(
                { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_BACKUP_PID: "9876" },
                async () => {
                    const controller = new AbortController();
                    const runPromise = runScheduledJob(
                        "backup.walg",
                        "manual",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                    const run = await runPromise;
                    assert.equal(run.status, "failed");
                    assert.deepEqual(signals, [
                        [-9876, "SIGTERM"],
                        [-9876, "SIGKILL"],
                    ]);
                }
            );
        } finally {
            mock.timers.reset();
            process.kill = originalKill;
        }
    });

    it("records process-group force termination failures", async () => {
        registerBackupScheduledJobs();
        const originalKill = process.kill;
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            assert.equal(pid, -2468);
            if (signal === "SIGKILL") {
                throw new Error("group kill unavailable");
            }
            return true;
        }) as typeof process.kill;

        try {
            mock.timers.enable({ apis: ["setTimeout"] });
            await withEnv(
                { FAKE_BACKUP_NEVER_CLOSE: "1", FAKE_BACKUP_PID: "2468" },
                async () => {
                    const controller = new AbortController();
                    const runPromise = runScheduledJob(
                        "backup.walg",
                        "manual",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    lastFakeBackupProcess?.emit("close", null, "SIGTERM");

                    const run = await runPromise;
                    assert.equal(run.status, "failed");
                    assert.match(run.message ?? "", /Failed to force terminate/u);
                    assert.match(run.message ?? "", /group kill unavailable/u);
                }
            );
        } finally {
            mock.timers.reset();
            process.kill = originalKill;
        }
    });

    it("records termination failures when aborting scheduled backup jobs", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_KILL_THROWS: "1", FAKE_BACKUP_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /Failed to terminate backup process/u);
                assert.match(run.message ?? "", /kill unavailable/u);
            }
        );
    });

    it("records failed termination signals when aborting scheduled backup jobs", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_KILL_RETURNS_FALSE: "1", FAKE_BACKUP_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                const run = await runPromise;
                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /Failed to terminate backup process/u);
            }
        );
    });

    it("terminates scheduled backup jobs when the signal is already aborted", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_CLOSE_ON_KILL: "1", FAKE_BACKUP_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                controller.abort();

                const run = await runScheduledJob(
                    "backup.walg",
                    "manual",
                    controller.signal
                );

                assert.equal(run.status, "failed");
                assert.match(run.message ?? "", /Backup aborted by scheduler/u);
                assert.equal(lastFakeBackupProcess?.killedWithSignal, "SIGTERM");
            }
        );
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

                const done = await waitForDoneWithRefreshFailure(
                    server,
                    "/api/backups/kopia"
                );
                assert.match(done.stderr, /Status refresh failed/u);
                assert.match(done.stderr, /missing-docker|ENOENT/u);
            }
        );
    });

    it("marks successful backup jobs done before status refresh completes", async () => {
        await withEnv({ FAKE_DOCKER_STATUS_DELAY_MS: "1000" }, async () => {
            const started = await requestJson<{
                ok: boolean;
                job: { id: string; status: string };
            }>(server, "/api/backups/kopia/run", { method: "POST" });

            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.status, "done");
            assert.equal(done.code, 0);

            const nextStarted = await requestJson<{
                ok: boolean;
                job: { id: string; status: string };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            assert.equal(nextStarted.status, 200);
            assert.equal(nextStarted.body.ok, true);
            assert.notEqual(nextStarted.body.job.id, started.body.job.id);
            await waitForDone(server, "/api/backups/kopia");
        });
    });

    it("resolves successful scheduled backups before status refresh completes", async () => {
        await withEnv({ FAKE_DOCKER_STATUS_DELAY_MS: "1000" }, async () => {
            const scheduledRun = backupTesting.startScheduledBackup("kopia");
            const result = await Promise.race([
                scheduledRun.then(() => "settled"),
                new Promise<"pending">((resolve) =>
                    setTimeout(() => resolve("pending"), 100)
                ),
            ]);

            assert.equal(result, "settled");
            const cache = await waitForCacheEntryAttempts("backup.kopia.status", 150);
            assert.equal(cache.ok, true);
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

    it("maps missing backup exit codes to failure", async () => {
        await withEnv({ FAKE_BACKUP_NULL_CLOSE: "1" }, async () => {
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
            assert.equal(done.code, 1);
        });
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

    it("marks scheduled jobs done when the backup process emits an error", async () => {
        backupTesting.setSpawnBackupProcessForTest((() => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                child.emit("error", new Error("spawn failed"));
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            registerBackupScheduledJobs();
            const run = await runScheduledJob(
                "backup.walg",
                "manual",
                new AbortController().signal
            );
            assert.equal(run.status, "failed");
            assert.match(run.message ?? "", /spawn failed/u);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }
    });

    it("keeps the first backup process terminal event", async () => {
        backupTesting.setSpawnBackupProcessForTest((() => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                child.emit("error", new Error("spawn failed first"));
                child.emit("close", 0, null);
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

            const done = await waitForDone(server, "/api/backups/walg");
            assert.equal(done.code, 1);
            assert.match(done.stderr, /spawn failed first/);
            assert.doesNotMatch(done.stderr, /Status refresh failed/u);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }

        backupTesting.setSpawnBackupProcessForTest((() => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                child.emit("close", 0, null);
                child.emit("error", new Error("late spawn error"));
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

            const done = await waitForDone(server, "/api/backups/walg");
            assert.equal(done.code, 0);
            assert.doesNotMatch(done.stderr, /late spawn error/u);
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
        assert.equal(backupTesting.getScheduledBackupType(null), undefined);
        assert.equal(backupTesting.getScheduledBackupType("walg"), undefined);
        assert.equal(backupTesting.getScheduledBackupType({ type: "kopia" }), "kopia");
        assert.equal(backupTesting.trimOutput("x".repeat(100_001)).length, 100_000);
    });
});
