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
let fakeBackupSpawnCalls = 0;
let fakeHostPgrepCalls = 0;
let fakeContainerPreStartPgrepCalls = 0;
let fakeContainerPostStartPgrepCalls = 0;
const fakeBackupHoldTimers = new Set<NodeJS.Timeout>();

function clearFakeBackupHoldTimers(): void {
    for (const timer of fakeBackupHoldTimers) {
        clearInterval(timer);
    }
    fakeBackupHoldTimers.clear();
}

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
    const writeBackups = () => process.stdout.write(JSON.stringify([
        {
            backup_name: "base_2099",
            modified: "2099-01-01T00:02:00.000Z",
            wal_file_name: "000000010000000000000001",
            storage_name: "default"
        }
    ]));
    const delayMs = Number(process.env.FAKE_DOCKER_WALG_STATUS_DELAY_MS || 0);
    if (delayMs > 0) setTimeout(writeBackups, delayMs);
    else writeBackups();
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
        if (process.env.FAKE_BACKUP_CLOSE_ZERO_ON_KILL === "1") {
            queueMicrotask(() => {
                child.stdout.end();
                child.stderr.end();
                child.emit("close", 0, null);
            });
        }
        if (process.env.FAKE_BACKUP_CLOSE_ON_KILL === "1") {
            queueMicrotask(() => {
                child.stdout.end();
                child.stderr.end();
                child.emit("close", null, child.killedWithSignal);
            });
        }
        return true;
    }) as ChildProcess["kill"];
    return child;
}

function handleHostPgrepSpawn(child: FakeBackupProcess): FakeBackupProcess {
    fakeHostPgrepCalls += 1;
    const hostPgrepCall = fakeHostPgrepCalls;
    queueMicrotask(() => {
        if (process.env.FAKE_HOST_PGREP_ERROR === "1") {
            child.emit("error", new Error("host pgrep failed"));
            return;
        }
        if (process.env.FAKE_HOST_PGREP_NEVER_CLOSE === "1") {
            return;
        }
        if (process.env.FAKE_HOST_PGREP_STDERR) {
            child.stderr.write(process.env.FAKE_HOST_PGREP_STDERR);
        }
        const closePgrep = () => {
            let code = 1;
            if (process.env.FAKE_HOST_PGREP_SEQUENCE) {
                const codes = process.env.FAKE_HOST_PGREP_SEQUENCE.split(",");
                code = Number(codes[hostPgrepCall - 1] ?? codes.at(-1) ?? 1);
            } else if (process.env.FAKE_HOST_PGREP_CODE) {
                code = Number(process.env.FAKE_HOST_PGREP_CODE);
            }
            child.emit("close", code, null);
        };
        let delayMs = 0;
        if (process.env.FAKE_HOST_PGREP_DELAY_SEQUENCE) {
            const delays = process.env.FAKE_HOST_PGREP_DELAY_SEQUENCE.split(",");
            delayMs = Number(delays[hostPgrepCall - 1] ?? delays.at(-1) ?? 0);
        } else if (process.env.FAKE_HOST_PGREP_DELAY_MS) {
            delayMs = Number(process.env.FAKE_HOST_PGREP_DELAY_MS);
        }
        if (delayMs > 0) {
            setTimeout(closePgrep, delayMs);
            return;
        }
        closePgrep();
    });
    return child;
}

function handleDockerExecSpawn(
    child: FakeBackupProcess,
    args: readonly string[]
): FakeBackupProcess {
    fakeDockerExecCalls.push([...args].map(String));
    queueMicrotask(() => {
        if (process.env.FAKE_DOCKER_EXEC_ERROR === "1" && fakeBackupSpawnCalls > 0) {
            child.emit("error", new Error("docker exec failed"));
            return;
        }
        if (
            process.env.FAKE_DOCKER_EXEC_NEVER_CLOSE === "1" &&
            fakeBackupSpawnCalls > 0
        ) {
            return;
        }
        if (process.env.FAKE_DOCKER_EXEC_STDOUT) {
            child.stdout.write(process.env.FAKE_DOCKER_EXEC_STDOUT);
        }
        if (process.env.FAKE_DOCKER_EXEC_STDERR) {
            child.stderr.write(process.env.FAKE_DOCKER_EXEC_STDERR);
        }
        if (args.includes("pgrep")) {
            const preStartProbe = fakeBackupSpawnCalls === 0;
            let preStartCall = 0;
            if (preStartProbe) {
                fakeContainerPreStartPgrepCalls += 1;
                preStartCall = fakeContainerPreStartPgrepCalls;
            }
            if (!preStartProbe) {
                fakeContainerPostStartPgrepCalls += 1;
            }
            const closePgrep = () => {
                let code = 1;
                if (preStartProbe && process.env.FAKE_CONTAINER_PGREP_PRESTART_SEQUENCE) {
                    const codes =
                        process.env.FAKE_CONTAINER_PGREP_PRESTART_SEQUENCE.split(",");
                    code = Number(codes[preStartCall - 1] ?? codes.at(-1) ?? 1);
                } else if (
                    preStartProbe &&
                    process.env.FAKE_CONTAINER_PGREP_PRESTART_CODE
                ) {
                    code = Number(process.env.FAKE_CONTAINER_PGREP_PRESTART_CODE);
                } else if (
                    preStartProbe &&
                    !process.env.FAKE_CONTAINER_PGREP_PRESTART_CODE
                ) {
                    code = 1;
                } else if (process.env.FAKE_CONTAINER_PGREP_CODE) {
                    code = Number(process.env.FAKE_CONTAINER_PGREP_CODE);
                } else if (
                    process.env.FAKE_CONTAINER_PGREP_RUNNING === "1" ||
                    (process.env.FAKE_CONTAINER_PGREP_RUNNING_ONCE === "1" &&
                        fakeContainerPostStartPgrepCalls === 1)
                ) {
                    code = 0;
                }
                child.emit(
                    "close",
                    process.env.FAKE_DOCKER_EXEC_NULL_CLOSE === "1" ? null : code,
                    null
                );
            };
            let delayMs = 0;
            if (
                preStartProbe &&
                process.env.FAKE_CONTAINER_PGREP_PRESTART_DELAY_SEQUENCE
            ) {
                const delays =
                    process.env.FAKE_CONTAINER_PGREP_PRESTART_DELAY_SEQUENCE.split(",");
                delayMs = Number(delays[preStartCall - 1] ?? delays.at(-1) ?? 0);
            } else if (
                preStartProbe &&
                process.env.FAKE_CONTAINER_PGREP_PRESTART_DELAY_MS
            ) {
                delayMs = Number(process.env.FAKE_CONTAINER_PGREP_PRESTART_DELAY_MS);
            }
            if (delayMs > 0) {
                setTimeout(closePgrep, delayMs);
                return;
            }
            closePgrep();
            return;
        }
        let code = 0;
        if (args.includes("-KILL") && process.env.FAKE_CONTAINER_PKILL_KILL_CODE) {
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

function handleBackupSpawn(
    child: FakeBackupProcess,
    args: readonly string[]
): FakeBackupProcess {
    lastFakeBackupProcess = child;
    fakeBackupSpawnCalls += 1;
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
                    fakeBackupHoldTimers.delete(timer);
                    child.emit("close", 0, null);
                }
            }, 10);
            timer.unref();
            fakeBackupHoldTimers.add(timer);
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
}

function createFakeBackupSpawn(): typeof spawn {
    return ((file: string, args: readonly string[]) => {
        const child = createFakeBackupProcess();
        if (file === "pgrep") {
            return handleHostPgrepSpawn(child);
        }
        if (file === "docker") {
            return handleDockerExecSpawn(child, args);
        }

        return handleBackupSpawn(child, args);
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

async function waitForCondition(
    condition: () => boolean,
    message: string
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
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

async function assertScheduledBackupRejects(
    promise: Promise<unknown>,
    pattern: RegExp
): Promise<void> {
    await assert.rejects(promise, (error) => {
        assert.match(error instanceof Error ? error.message : String(error), pattern);
        return true;
    });
}

function startTestScheduledBackup(
    ...args: Parameters<typeof backupTesting.startScheduledBackup>
): ReturnType<typeof backupTesting.startScheduledBackup> {
    const promise = backupTesting.startScheduledBackup(...args);
    promise.catch(() => {
        // Expected failure paths are asserted later; observe them immediately.
    });
    return promise;
}

async function assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
    server: TestServer,
    runPromise: Promise<unknown>,
    stderrPattern: RegExp,
    release: () => void
): Promise<void> {
    const result = await Promise.race([
        runPromise.then(
            () => "settled",
            () => "settled"
        ),
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
    closeLastFakeBackupProcess();
    await assertScheduledBackupRejects(runPromise, /Backup aborted by scheduler/u);
}

function closeLastFakeBackupProcess(
    code: number | null = null,
    signal: NodeJS.Signals | null = "SIGTERM"
): void {
    assert.ok(lastFakeBackupProcess, "Expected fake backup process to be spawned");
    lastFakeBackupProcess.emit("close", code, signal);
}

async function closeLastFakeBackupProcessAndWaitForStatusRefresh(
    type: "kopia" | "walg"
): Promise<void> {
    closeLastFakeBackupProcess();
    await waitForCacheEntry(`backup.${type}.status`);
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
        clearFakeBackupHoldTimers();
        lastFakeBackupProcess = null;
        fakeDockerExecCalls.length = 0;
        fakeBackupSpawnCalls = 0;
        fakeHostPgrepCalls = 0;
        fakeContainerPreStartPgrepCalls = 0;
        fakeContainerPostStartPgrepCalls = 0;
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
        clearFakeBackupHoldTimers();
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

    it("evicts older completed backup jobs before starting the next run", async () => {
        const first = await requestJson<{
            ok: boolean;
            job: { id: string; status: string };
        }>(server, "/api/backups/kopia/run", { method: "POST" });
        assert.equal(first.status, 200);
        assert.equal(first.body.ok, true);
        await waitForDone(server, "/api/backups/kopia");
        assert.equal(backupTesting.getBackupJobCountForTest(), 1);

        const second = await requestJson<{
            ok: boolean;
            job: { id: string; status: string };
        }>(server, "/api/backups/kopia/run", { method: "POST" });
        assert.equal(second.status, 200);
        assert.equal(second.body.ok, true);
        assert.notEqual(second.body.job.id, first.body.job.id);
        await waitForDone(server, "/api/backups/kopia");
        assert.equal(backupTesting.getBackupJobCountForTest(), 1);
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

    it("returns the active job when a WAL-G backup is already running", async () => {
        const releasePath = path.join(tempDir, "release-walg");
        await withEnv({ FAKE_BACKUP_HOLD_UNTIL: releasePath }, async () => {
            const firstResp = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string };
            }>(server, "/api/backups/walg/run", { method: "POST" });
            const secondResp = await requestJson<{
                ok: boolean;
                job: { id: string; type: string; status: string };
            }>(server, "/api/backups/walg/run", { method: "POST" });

            assert.equal(firstResp.status, 200);
            assert.equal(firstResp.body.ok, true);
            assert.equal(firstResp.body.job.status, "running");
            assert.equal(secondResp.status, 200);
            assert.equal(secondResp.body.ok, true);
            assert.equal(secondResp.body.job.id, firstResp.body.job.id);
            assert.equal(secondResp.body.job.status, "running");

            await writeFile(releasePath, "release", "utf8");
            await waitForDone(server, "/api/backups/walg");
        });
    });

    it("returns the active WAL-G job when overlapping prestart probes see the new process", async () => {
        const releasePath = path.join(tempDir, "release-walg-race");
        await withEnv(
            {
                FAKE_BACKUP_HOLD_UNTIL: releasePath,
                FAKE_CONTAINER_PGREP_PRESTART_DELAY_SEQUENCE: "10,20",
                FAKE_CONTAINER_PGREP_PRESTART_SEQUENCE: "1,0",
            },
            async () => {
                const [first, second] = await Promise.all([
                    requestJson<{ job: { id: string; status: string } }>(
                        server,
                        "/api/backups/walg/run",
                        { method: "POST" }
                    ),
                    requestJson<{ job: { id: string; status: string } }>(
                        server,
                        "/api/backups/walg/run",
                        { method: "POST" }
                    ),
                ]);

                assert.equal(first.status, 200);
                assert.equal(second.status, 200);
                assert.equal(first.body.job.id, second.body.job.id);
                assert.equal(first.body.job.status, "running");
                assert.equal(second.body.job.status, "running");
                assert.equal(fakeBackupSpawnCalls, 1);
                assert.equal(fakeContainerPreStartPgrepCalls, 2);

                await writeFile(releasePath, "ok");
                await waitForDone(server, "/api/backups/walg");
            }
        );
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

        assert.equal(getScheduledJob("backup.status.walg"), null);
        assert.equal(getScheduledJob("backup.status.kopia"), null);
        assert.equal(
            (
                db
                    .prepare("SELECT COUNT(*) AS count FROM cache_entries WHERE key = ?")
                    .get("backup.walg.status") as { count: number }
            ).count,
            0
        );
        assert.equal(
            (
                db
                    .prepare("SELECT COUNT(*) AS count FROM cache_entries WHERE key = ?")
                    .get("backup.kopia.status") as { count: number }
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
        const refreshedWalgStatus = await waitForCacheEntry("backup.walg.status");
        assert.equal(refreshedWalgStatus.ok, true);

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
        const refreshedKopiaStatus = await waitForCacheEntry("backup.kopia.status");
        assert.equal(refreshedKopiaStatus.ok, true);
    });

    it("rolls back backup schedule pruning when schedule registration fails", (t) => {
        upsertScheduledJob({
            id: "backup.legacy",
            name: "Legacy backup",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "02:00",
            actionKey: "backup.run",
            actionPayload: { type: "walg" },
        });

        const prepare = db.prepare.bind(db);
        let scheduleWriteCount = 0;
        const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
            if (sql.includes("INSERT INTO scheduled_jobs")) {
                const statement = prepare(sql);
                return {
                    run: (...args: Parameters<typeof statement.run>) => {
                        scheduleWriteCount += 1;
                        if (scheduleWriteCount === 2) {
                            throw new Error("schedule write failed");
                        }
                        return statement.run(...args);
                    },
                } as unknown as ReturnType<typeof db.prepare>;
            }
            return prepare(sql);
        });

        try {
            assert.throws(registerBackupScheduledJobs, /schedule write failed/u);
        } finally {
            prepareMock.mock.restore();
        }

        assert.notEqual(getScheduledJob("backup.legacy"), null);
        assert.equal(getScheduledJob("backup.walg"), null);
        assert.equal(getScheduledJob("backup.kopia"), null);
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

        assert.equal(getScheduledJob("backup.status.walg"), null);
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

    it("resolves failed scheduled backups before status refresh completes", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            {
                FAKE_BACKUP_EXIT_CODE: "12",
                FAKE_DOCKER_WALG_STATUS_DELAY_MS: "1000",
            },
            async () => {
                const scheduledRun = runScheduledJob("backup.walg");
                const result = await Promise.race([
                    scheduledRun,
                    new Promise<"pending">((resolve) =>
                        setTimeout(() => resolve("pending"), 100)
                    ),
                ]);

                if (result === "pending") {
                    assert.fail(
                        "Scheduled backup failure did not resolve before refresh"
                    );
                }
                assert.equal(result.status, "failed");
                assert.match(result.message ?? "", /WALG backup failed with code 12/u);
                const refreshedStatus = await waitForCacheEntryAttempts(
                    "backup.walg.status",
                    150
                );
                assert.equal(refreshedStatus.ok, true);
            }
        );
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                const earlyResult = await Promise.race([
                    runPromise.then(
                        () => "settled",
                        () => "settled"
                    ),
                    new Promise<"pending">((resolve) => {
                        setTimeout(() => resolve("pending"), 20);
                    }),
                ]);
                assert.equal(earlyResult, "pending");
                closeLastFakeBackupProcess();

                await assertScheduledBackupRejects(
                    runPromise,
                    /WALG backup failed with code 130[\s\S]*Backup aborted by scheduler/u
                );
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
                const refreshedStatus = await waitForCacheEntry("backup.walg.status");
                assert.equal(refreshedStatus.ok, true);
            }
        );
    });

    it("marks aborted backup jobs interrupted when the child exits cleanly", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_CLOSE_ZERO_ON_KILL: "1", FAKE_BACKUP_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = startTestScheduledBackup("kopia", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                await assertScheduledBackupRejects(
                    runPromise,
                    /KOPIA backup failed with code 130[\s\S]*Backup aborted by scheduler/u
                );

                const current = await requestJson<{
                    job: { status: string; code: number; stderr: string } | null;
                }>(server, "/api/backups/kopia");
                assert.equal(current.body.job?.status, "done");
                assert.equal(current.body.job?.code, 130);
                assert.match(
                    current.body.job?.stderr ?? "",
                    /Backup aborted by scheduler/u
                );
                const refreshedStatus = await waitForCacheEntry("backup.kopia.status");
                assert.equal(refreshedStatus.ok, true);
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
                    const runPromise = startTestScheduledBackup(
                        "walg",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();

                    const earlyResult = await Promise.race([
                        runPromise.then(
                            () => "settled",
                            () => "settled"
                        ),
                        new Promise<"pending">((resolve) => {
                            setTimeout(() => resolve("pending"), 20);
                        }),
                    ]);
                    assert.equal(earlyResult, "pending");
                    assert.deepEqual(signals, [[-4321, "SIGTERM"]]);

                    closeLastFakeBackupProcess();
                    await assertScheduledBackupRejects(
                        runPromise,
                        /Backup aborted by scheduler/u
                    );
                    assert.deepEqual(signals, [[-4321, "SIGTERM"]]);
                }
            );
        } finally {
            process.kill = originalKill;
        }
    });

    it("clears host force-kill timer before waiting for in-container WAL-G exit", async () => {
        registerBackupScheduledJobs();
        const originalKill = process.kill;
        const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            signals.push([pid, signal]);
            return true;
        }) as typeof process.kill;

        try {
            mock.timers.enable({ apis: ["setTimeout"] });
            await withEnv(
                {
                    FAKE_BACKUP_NEVER_CLOSE: "1",
                    FAKE_BACKUP_PID: "4321",
                    FAKE_CONTAINER_PGREP_RUNNING_ONCE: "1",
                },
                async () => {
                    const controller = new AbortController();
                    const runPromise = startTestScheduledBackup(
                        "walg",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    closeLastFakeBackupProcess();
                    await new Promise<void>((resolve) => setImmediate(resolve));

                    mock.timers.tick(10_000);
                    await new Promise<void>((resolve) => setImmediate(resolve));

                    await assertScheduledBackupRejects(
                        runPromise,
                        /Backup aborted by scheduler/u
                    );
                    assert.deepEqual(
                        signals.filter(([pid]) => pid === -4321),
                        [[-4321, "SIGTERM"]]
                    );
                }
            );
        } finally {
            mock.timers.reset();
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

                const earlyResult = await Promise.race([
                    runPromise.then(
                        () => "settled",
                        () => "settled"
                    ),
                    new Promise<"pending">((resolve) => {
                        setTimeout(() => resolve("pending"), 20);
                    }),
                ]);
                assert.equal(earlyResult, "pending");

                await assertScheduledBackupRejects(
                    runPromise,
                    /Backup aborted by scheduler/u
                );
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
                assert.equal(fakeContainerPostStartPgrepCalls, 2);
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                await new Promise<void>((resolve) => setImmediate(resolve));
                closeLastFakeBackupProcess();

                await assertScheduledBackupRejects(runPromise, /container pkill failed/u);
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                await new Promise<void>((resolve) => setImmediate(resolve));
                closeLastFakeBackupProcess();

                await assertScheduledBackupRejects(
                    runPromise,
                    /docker exec pkill exited 2/u
                );
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

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

    it("bounds hung docker exec probes when fallback kill throws", async () => {
        registerBackupScheduledJobs();
        backupTesting.setBackupAbortDockerExecTimeoutForTest(1);
        await withEnv(
            {
                FAKE_BACKUP_NEVER_CLOSE: "1",
                FAKE_BACKUP_KILL_THROWS: "1",
                FAKE_DOCKER_EXEC_NEVER_CLOSE: "1",
            },
            async () => {
                const controller = new AbortController();
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

                await assertAbortedWalgRemainsRunningUntilTerminationConfirmed(
                    server,
                    runPromise,
                    /Timed out waiting for docker exec/u,
                    () => {
                        delete process.env.FAKE_DOCKER_EXEC_NEVER_CLOSE;
                        delete process.env.FAKE_BACKUP_KILL_THROWS;
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();
                closeLastFakeBackupProcess();

                await assertScheduledBackupRejects(
                    runPromise,
                    /needs attention[\s\S]*2 failed confirmation attempts/u
                );
                const activeWalg = await requestJson<{
                    job: { status: string } | null;
                }>(server, "/api/backups/walg");
                assert.equal(activeWalg.body.job?.status, "needs_attention");

                const blockedRun = await runScheduledJob("backup.walg", "manual");
                assert.equal(blockedRun.status, "failed");
                assert.match(blockedRun.message ?? "", /WALG backup needs attention/u);

                const blockedManual = await requestJson<{ error: string }>(
                    server,
                    "/api/backups/walg/run",
                    { method: "POST" }
                );
                assert.equal(blockedManual.status, 409);
                assert.match(blockedManual.body.error, /WALG backup needs attention/u);

                const cleared = await requestJson<{
                    ok: boolean;
                    cleared: { status: string };
                }>(server, "/api/backups/walg/clear-needs-attention", {
                    method: "POST",
                });
                assert.equal(cleared.status, 200);
                assert.equal(cleared.body.ok, true);
                assert.equal(cleared.body.cleared.status, "needs_attention");

                const afterClear = await requestJson<{ job: unknown }>(
                    server,
                    "/api/backups/walg"
                );
                assert.equal(afterClear.body.job, null);

                process.env.FAKE_CONTAINER_PGREP_CODE = "1";
                const restarted = await requestJson<{
                    ok: boolean;
                    job: { status: string };
                }>(server, "/api/backups/walg/run", { method: "POST" });
                assert.equal(restarted.status, 200);
                assert.equal(restarted.body.job.status, "running");

                backupTesting.markActiveJobNeedsAttentionForTest("walg");
                const clearedRestart = await requestJson<{ ok: boolean }>(
                    server,
                    "/api/backups/walg/clear-needs-attention",
                    { method: "POST" }
                );
                assert.equal(clearedRestart.status, 200);
                await closeLastFakeBackupProcessAndWaitForStatusRefresh("walg");
            }
        );
    });

    it("blocks WAL-G starts after restart when the container backup is still running", async () => {
        registerBackupScheduledJobs();
        await withEnv({ FAKE_CONTAINER_PGREP_PRESTART_CODE: "0" }, async () => {
            backupTesting.resetJobsForTest();

            const manual = await requestJson<{ error: string }>(
                server,
                "/api/backups/walg/run",
                { method: "POST" }
            );
            assert.equal(manual.status, 409);
            assert.match(manual.body.error, /WALG backup needs attention/u);
            assert.equal(fakeBackupSpawnCalls, 0);

            const active = await requestJson<{ job: { status: string; stderr: string } }>(
                server,
                "/api/backups/walg"
            );
            assert.equal(active.status, 200);
            assert.equal(active.body.job.status, "needs_attention");
            assert.match(active.body.job.stderr, /backup process is still running/u);

            const scheduled = await runScheduledJob("backup.walg", "manual");
            assert.equal(scheduled.status, "failed");
            assert.match(scheduled.message ?? "", /WALG backup needs attention/u);
            assert.equal(fakeBackupSpawnCalls, 0);
        });
    });

    it("keeps WAL-G attention state when it appears during prestart probing", async () => {
        await withEnv(
            {
                FAKE_CONTAINER_PGREP_PRESTART_CODE: "0",
                FAKE_CONTAINER_PGREP_PRESTART_DELAY_MS: "20",
            },
            async () => {
                const pending = requestJson<{ error: string }>(
                    server,
                    "/api/backups/walg/run",
                    { method: "POST" }
                );
                await waitForCondition(
                    () => fakeContainerPreStartPgrepCalls === 1,
                    "WAL-G prestart probe did not start"
                );
                backupTesting.recordBackupNeedsAttentionForTest("walg");

                const response = await pending;
                assert.equal(response.status, 409);
                assert.match(response.body.error, /WALG backup needs attention/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );
    });

    it("blocks Kopia starts after restart when a host backup is still running", async () => {
        registerBackupScheduledJobs();
        await withEnv({ FAKE_HOST_PGREP_CODE: "0" }, async () => {
            backupTesting.resetJobsForTest();

            const manual = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(manual.status, 409);
            assert.match(manual.body.error, /KOPIA backup needs attention/u);
            assert.equal(fakeBackupSpawnCalls, 0);

            const active = await requestJson<{ job: { status: string; stderr: string } }>(
                server,
                "/api/backups/kopia"
            );
            assert.equal(active.status, 200);
            assert.equal(active.body.job.status, "needs_attention");
            assert.match(active.body.job.stderr, /backup process is still running/u);

            const scheduled = await runScheduledJob("backup.kopia", "manual");
            assert.equal(scheduled.status, "failed");
            assert.match(scheduled.message ?? "", /KOPIA backup needs attention/u);
            assert.equal(fakeBackupSpawnCalls, 0);
        });
    });

    it("keeps Kopia attention state when it appears during host probing", async () => {
        await withEnv(
            {
                FAKE_HOST_PGREP_CODE: "0",
                FAKE_HOST_PGREP_DELAY_MS: "20",
            },
            async () => {
                const pending = requestJson<{ error: string }>(
                    server,
                    "/api/backups/kopia/run",
                    { method: "POST" }
                );
                await waitForCondition(
                    () => fakeHostPgrepCalls === 1,
                    "Kopia host probe did not start"
                );
                backupTesting.recordBackupNeedsAttentionForTest("kopia");

                const response = await pending;
                assert.equal(response.status, 409);
                assert.match(response.body.error, /KOPIA backup needs attention/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );
    });

    it("returns the active Kopia job when overlapping host probes see the new process", async () => {
        const releasePath = path.join(tempDir, "release-kopia-race");
        await withEnv(
            {
                FAKE_BACKUP_HOLD_UNTIL: releasePath,
                FAKE_HOST_PGREP_DELAY_SEQUENCE: "10,20",
                FAKE_HOST_PGREP_SEQUENCE: "1,0",
            },
            async () => {
                const [first, second] = await Promise.all([
                    requestJson<{ job: { id: string; status: string } }>(
                        server,
                        "/api/backups/kopia/run",
                        { method: "POST" }
                    ),
                    requestJson<{ job: { id: string; status: string } }>(
                        server,
                        "/api/backups/kopia/run",
                        { method: "POST" }
                    ),
                ]);

                assert.equal(first.status, 200);
                assert.equal(second.status, 200);
                assert.equal(first.body.job.id, second.body.job.id);
                assert.equal(first.body.job.status, "running");
                assert.equal(second.body.job.status, "running");
                assert.equal(fakeBackupSpawnCalls, 1);
                assert.equal(fakeHostPgrepCalls, 2);

                await writeFile(releasePath, "ok");
                await waitForDone(server, "/api/backups/kopia");
            }
        );
    });

    it("reports Kopia host prestart probe failures", async () => {
        await withEnv({ FAKE_HOST_PGREP_ERROR: "1" }, async () => {
            const failed = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(failed.status, 500);
            assert.match(failed.body.error, /host pgrep failed/u);
            assert.equal(fakeBackupSpawnCalls, 0);
        });

        await withEnv(
            {
                FAKE_HOST_PGREP_CODE: "2",
                FAKE_HOST_PGREP_STDERR: "host pgrep unavailable",
            },
            async () => {
                const failed = await requestJson<{ error: string }>(
                    server,
                    "/api/backups/kopia/run",
                    { method: "POST" }
                );
                assert.equal(failed.status, 503);
                assert.match(failed.body.error, /host pgrep unavailable/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );

        await withEnv({ FAKE_HOST_PGREP_CODE: "2" }, async () => {
            const failed = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(failed.status, 503);
            assert.match(failed.body.error, /pgrep exited 2/u);
            assert.equal(fakeBackupSpawnCalls, 0);
        });
    });

    it("bounds hung Kopia host prestart probes", async () => {
        backupTesting.setBackupAbortDockerExecTimeoutForTest(10);
        await withEnv(
            { FAKE_BACKUP_CLOSE_ON_KILL: "1", FAKE_HOST_PGREP_NEVER_CLOSE: "1" },
            async () => {
                const failed = await requestJson<{ error: string }>(
                    server,
                    "/api/backups/kopia/run",
                    { method: "POST" }
                );
                assert.equal(failed.status, 500);
                assert.match(failed.body.error, /Timed out waiting for pgrep/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );

        await withEnv(
            {
                FAKE_BACKUP_CLOSE_ON_KILL: "1",
                FAKE_BACKUP_PID: "4567",
                FAKE_HOST_PGREP_NEVER_CLOSE: "1",
            },
            async () => {
                const failed = await requestJson<{ error: string }>(
                    server,
                    "/api/backups/kopia/run",
                    { method: "POST" }
                );
                assert.equal(failed.status, 500);
                assert.match(failed.body.error, /Timed out waiting for pgrep/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );
    });

    it("reports WAL-G prestart container probe failures", async () => {
        await withEnv(
            {
                FAKE_CONTAINER_PGREP_PRESTART_CODE: "2",
                FAKE_DOCKER_EXEC_STDERR: "pgrep unavailable",
            },
            async () => {
                const failed = await requestJson<{ error: string }>(
                    server,
                    "/api/backups/walg/run",
                    { method: "POST" }
                );
                assert.equal(failed.status, 503);
                assert.match(failed.body.error, /pgrep unavailable/u);
                assert.equal(fakeBackupSpawnCalls, 0);
            }
        );

        await withEnv({ FAKE_CONTAINER_PGREP_PRESTART_CODE: "2" }, async () => {
            const failed = await requestJson<{ error: string }>(
                server,
                "/api/backups/walg/run",
                { method: "POST" }
            );
            assert.equal(failed.status, 503);
            assert.match(failed.body.error, /docker exec pgrep exited 2/u);
            assert.equal(fakeBackupSpawnCalls, 0);
        });
    });

    it("rejects clearing backup attention when no attention is required", async () => {
        const missing = await requestJson<{ error: string }>(
            server,
            "/api/backups/kopia/clear-needs-attention",
            { method: "POST" }
        );
        assert.equal(missing.status, 404);
        assert.match(missing.body.error, /KOPIA backup job not found/u);

        const releasePath = path.join(tempDir, "release-kopia-clear-attention");
        await withEnv({ FAKE_BACKUP_HOLD_UNTIL: releasePath }, async () => {
            const started = await requestJson<{ job: { status: string } }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(started.status, 200);

            const active = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/clear-needs-attention",
                { method: "POST" }
            );
            assert.equal(active.status, 409);
            assert.match(active.body.error, /KOPIA backup does not need attention/u);

            backupTesting.markActiveJobNeedsAttentionForTest("kopia");
            const blocked = await requestJson<{ error: string }>(
                server,
                "/api/backups/kopia/run",
                { method: "POST" }
            );
            assert.equal(blocked.status, 409);
            assert.match(blocked.body.error, /KOPIA backup needs attention/u);

            const cleared = await requestJson<{
                ok: boolean;
                cleared: { status: string };
            }>(server, "/api/backups/kopia/clear-needs-attention", {
                method: "POST",
            });
            assert.equal(cleared.status, 200);
            assert.equal(cleared.body.cleared.status, "needs_attention");
            await writeFile(releasePath, "ok");
            await closeLastFakeBackupProcessAndWaitForStatusRefresh("kopia");
        });

        const afterClear = await requestJson<{ job: unknown }>(
            server,
            "/api/backups/kopia"
        );
        assert.equal(afterClear.body.job, null);
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
                    const runPromise = startTestScheduledBackup(
                        "walg",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    await new Promise<void>((resolve) => setImmediate(resolve));
                    closeLastFakeBackupProcess();

                    await assertScheduledBackupRejects(
                        runPromise,
                        /container force kill failed/u
                    );
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
                    const runPromise = startTestScheduledBackup(
                        "walg",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    closeLastFakeBackupProcess();

                    await assertScheduledBackupRejects(
                        runPromise,
                        /Backup aborted by scheduler/u
                    );
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
        const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            signals.push([pid, signal]);
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
                    const runPromise = startTestScheduledBackup(
                        "walg",
                        controller.signal
                    );

                    await new Promise<void>((resolve) => setImmediate(resolve));
                    controller.abort();
                    mock.timers.tick(10_000);
                    closeLastFakeBackupProcess();

                    await assertScheduledBackupRejects(
                        runPromise,
                        /Failed to force terminate[\s\S]*group kill unavailable/u
                    );
                    assert.deepEqual(signals.at(0), [-2468, "SIGTERM"]);
                    assert.ok(
                        signals.some(
                            ([pid, signal]) => pid === -2468 && signal === "SIGKILL"
                        )
                    );
                    assert.ok(
                        signals.some(
                            ([pid, signal]) => pid === 2468 && signal === "SIGKILL"
                        )
                    );
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
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                await assertScheduledBackupRejects(
                    runPromise,
                    /Failed to terminate backup process[\s\S]*kill unavailable/u
                );
            }
        );
    });

    it("records failed termination signals when aborting scheduled backup jobs", async () => {
        registerBackupScheduledJobs();
        await withEnv(
            { FAKE_BACKUP_KILL_RETURNS_FALSE: "1", FAKE_BACKUP_NEVER_CLOSE: "1" },
            async () => {
                const controller = new AbortController();
                const runPromise = startTestScheduledBackup("walg", controller.signal);

                await new Promise<void>((resolve) => setImmediate(resolve));
                controller.abort();

                await assertScheduledBackupRejects(
                    runPromise,
                    /Failed to terminate backup process/u
                );
            }
        );
    });

    it("does not start scheduled backup jobs when the signal is already aborted", async () => {
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
                assert.match(run.message ?? "", /Scheduled job aborted/u);
                assert.equal(fakeBackupSpawnCalls, 0);
                assert.equal(lastFakeBackupProcess, null);
                const activeWalg = await requestJson<{
                    job: { status: string } | null;
                }>(server, "/api/backups/walg");
                assert.equal(activeWalg.body.job, null);
            }
        );
    });

    it("does not start direct scheduled backup helpers when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();

        await assertScheduledBackupRejects(
            startTestScheduledBackup("walg", controller.signal),
            /Backup aborted by scheduler/u
        );
        assert.equal(fakeBackupSpawnCalls, 0);
        assert.equal(lastFakeBackupProcess, null);
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

            process.env.FAKE_DOCKER_STATUS_DELAY_MS = "1";
            const nextStarted = await requestJson<{
                ok: boolean;
                job: { id: string; status: string };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            assert.equal(nextStarted.status, 200);
            assert.equal(nextStarted.body.ok, true);
            assert.notEqual(nextStarted.body.job.id, started.body.job.id);
            await waitForDone(server, "/api/backups/kopia");
            await new Promise<void>((resolve) => setTimeout(resolve, 1100));
        });
    });

    it("resolves successful scheduled backups before status refresh completes", async () => {
        await withEnv({ FAKE_DOCKER_STATUS_DELAY_MS: "1000" }, async () => {
            const scheduledRun = startTestScheduledBackup("kopia");
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

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.status, "done");
            assert.equal(done.code, 1);
        });
    });

    it("marks jobs done when the backup process emits an error", async () => {
        backupTesting.setSpawnBackupProcessForTest(((file: string) => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                if (file === "pgrep") {
                    child.emit("close", 1, null);
                    return;
                }
                child.emit("error", new Error("spawn failed"));
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.status, "done");
            assert.equal(done.code, 1);
            assert.match(done.stderr, /spawn failed/);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }
    });

    it("marks scheduled jobs done when the backup process emits an error", async () => {
        backupTesting.setSpawnBackupProcessForTest(((file: string) => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                if (file === "pgrep") {
                    child.emit("close", 1, null);
                    return;
                }
                child.emit("error", new Error("spawn failed"));
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            registerBackupScheduledJobs();
            const run = await runScheduledJob(
                "backup.kopia",
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
        backupTesting.setSpawnBackupProcessForTest(((file: string) => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                if (file === "pgrep") {
                    child.emit("close", 1, null);
                    return;
                }
                child.emit("error", new Error("spawn failed first"));
                child.emit("close", 0, null);
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.code, 1);
            assert.match(done.stderr, /spawn failed first/);
            assert.doesNotMatch(done.stderr, /Status refresh failed/u);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }

        backupTesting.setSpawnBackupProcessForTest(((file: string) => {
            const child = createFakeBackupProcess();
            queueMicrotask(() => {
                if (file === "pgrep") {
                    child.emit("close", 1, null);
                    return;
                }
                child.emit("close", 0, null);
                child.emit("error", new Error("late spawn error"));
            });
            return child;
        }) as unknown as typeof spawn);
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/kopia/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);

            const done = await waitForDone(server, "/api/backups/kopia");
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
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }

        backupTesting.setSpawnBackupProcessForTest(((file: string) => {
            if (file === "docker") {
                const child = createFakeBackupProcess();
                queueMicrotask(() => {
                    child.emit("close", 1, null);
                });
                return child;
            }
            throw new Error("spawn crashed");
        }) as unknown as typeof spawn);
        try {
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

        await withEnv({ FAKE_BACKUP_NEVER_CLOSE: "1" }, async () => {
            const running = backupTesting.startBackupJobForTest(
                "kopia",
                "/opt/docker/apps/kopia/backup.sh"
            );
            assert.equal(
                backupTesting.startBackupJobForTest(
                    "kopia",
                    "/opt/docker/apps/kopia/backup.sh"
                ),
                running
            );
            await closeLastFakeBackupProcessAndWaitForStatusRefresh("kopia");
        });

        backupTesting.resetJobsForTest();
        backupTesting.recordBackupNeedsAttentionForTest("kopia");
        assert.throws(
            () =>
                backupTesting.startBackupJobForTest(
                    "kopia",
                    "/opt/docker/apps/kopia/backup.sh"
                ),
            /KOPIA backup needs attention/u
        );

        backupTesting.resetJobsForTest();
        backupTesting.setSpawnBackupProcessForTest(() => {
            throw new Error("direct spawn crashed");
        });
        try {
            assert.throws(
                () =>
                    backupTesting.startBackupJobForTest(
                        "kopia",
                        "/opt/docker/apps/kopia/backup.sh"
                    ),
                /direct spawn crashed/u
            );
            assert.equal(backupTesting.getBackupJobCountForTest(), 0);
        } finally {
            backupTesting.setSpawnBackupProcessForTest(createFakeBackupSpawn());
        }
    });
});
