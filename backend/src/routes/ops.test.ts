import assert from "node:assert/strict";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

type ElevatedLogRotationRunner = Parameters<
    Awaited<typeof import("./ops.js")>["__testing"]["setElevatedLogRotationRunner"]
>[0];

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
    defaultElevatedLogRotationRunner: ElevatedLogRotationRunner;
    opsTesting: Awaited<typeof import("./ops.js")>["__testing"];
}

let db: (typeof import("../db.js"))["db"];

async function startServer(configPath: string): Promise<TestServer> {
    process.env.MIRA_LOG_ROTATION_CONFIG = configPath;
    const importSuffix = `${Date.now()}-${Math.random()}`;
    const { __testing, default: opsRoutes } = await import(
        `./ops.js?test=${importSuffix}`
    );
    const { runLogRotationService } = await import(
        `../services/logRotation.js?test=${importSuffix}`
    );
    const defaultElevatedLogRotationRunner: ElevatedLogRotationRunner = async (
        options
    ) => ({
        result: (await runLogRotationService({
            dryRun: options.dryRun,
            config: configPath,
        })) as unknown as Record<string, unknown>,
        stderr: "",
    });
    __testing.setElevatedLogRotationRunner(defaultElevatedLogRotationRunner);
    const app = express();
    app.use(express.json());
    opsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            server.off("error", onError);
            server.off("listening", onListening);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
        defaultElevatedLogRotationRunner,
        opsTesting: __testing,
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.method === "POST"
                ? { "Content-Type": "application/json" }
                : undefined,
        body: options.method === "POST" ? "{}" : undefined,
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("ops routes", () => {
    let server: TestServer;
    let tempDir: string;
    let archiveNewPath: string;
    let archiveOldPath: string;
    let logPath: string;
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const originalConfig = process.env.MIRA_LOG_ROTATION_CONFIG;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-ops-route-"));
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "ops.sqlite");
        ({ db } = await import("../db.js"));
        const dataDir = path.join(tempDir, "data");
        await mkdir(dataDir, { recursive: true });
        logPath = path.join(dataDir, "app.log");
        await writeFile(logPath, "x".repeat(2048), "utf8");
        const archiveDir = path.join(dataDir, "kopia", "logs", "repo");
        await mkdir(archiveDir, { recursive: true });
        archiveNewPath = path.join(archiveDir, "snapshot-new.log");
        archiveOldPath = path.join(archiveDir, "snapshot-old.log");
        await writeFile(archiveNewPath, "new archive", "utf8");
        await writeFile(archiveOldPath, "old archive", "utf8");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        await utimes(archiveNewPath, twoHoursAgo, twoHoursAgo);
        await utimes(archiveOldPath, eightDaysAgo, eightDaysAgo);
        const configPath = path.join(tempDir, "log-rotation.json");
        await writeFile(
            configPath,
            JSON.stringify({
                version: 1,
                approvedRoots: [dataDir],
                defaults: { maxSizeMb: 0.001, keep: 2, compress: true },
                groups: [
                    { name: "apps", paths: [logPath] },
                    {
                        name: "archive-only",
                        paths: [],
                        archiveOnly: true,
                        archivePaths: [path.join(archiveDir, "*.log")],
                        archiveRetentionScope: "directory",
                        archiveMinAgeMinutes: 60,
                        keep: 1,
                        keepDays: 7,
                        compress: true,
                    },
                ],
            }),
            "utf8"
        );
        db.exec("DELETE FROM cache_entries WHERE key = 'log_rotation.state';");
        server = await startServer(configPath);
    });

    after(async () => {
        try {
            if (server) await server.close();
        } finally {
            if (originalConfig === undefined) {
                delete process.env.MIRA_LOG_ROTATION_CONFIG;
            } else {
                process.env.MIRA_LOG_ROTATION_CONFIG = originalConfig;
            }
            if (db) {
                db.exec("DELETE FROM cache_entries WHERE key = 'log_rotation.state';");
                db.close();
            }
            if (originalDbPath === undefined) {
                delete process.env.MIRA_DASHBOARD_DB_PATH;
            } else {
                process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
            }
            if (tempDir) await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("returns log rotation status from dashboard SQLite cache", async () => {
        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({
                version: 1,
                files: {},
                lastRun: { finishedAt: "2026-05-11T01:00:00.000Z", ok: true },
            }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );

        const response = await requestJson<{
            success: boolean;
            lastRun: { finishedAt: string; ok: boolean; errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            success: true,
            lastRun: {
                ok: true,
                dryRun: false,
                startedAt: null,
                finishedAt: "2026-05-11T01:00:00.000Z",
                checkedGroups: 0,
                checkedFiles: 0,
                rotatedFiles: 0,
                compressedFiles: 0,
                deletedArchives: 0,
                skippedFiles: 0,
                warnings: [],
                errors: [],
                groups: [],
            },
        });

        db.prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'").run();
        const missing = await requestJson<{ success: boolean; lastRun: null }>(
            server,
            "/api/ops/log-rotation/status"
        );
        assert.deepEqual(missing.body, { success: true, lastRun: null });

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            "{not-json",
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const malformed = await requestJson<{ success: boolean; lastRun: null }>(
            server,
            "/api/ops/log-rotation/status"
        );
        assert.deepEqual(malformed.body, { success: true, lastRun: null });

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({}),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const withoutLastRun = await requestJson<{ success: boolean; lastRun: null }>(
            server,
            "/api/ops/log-rotation/status"
        );
        assert.deepEqual(withoutLastRun.body, { success: true, lastRun: null });

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({ lastRun: { ok: true, finishedAt: 42 } }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const partialLastRun = await requestJson<{
            success: boolean;
            lastRun: { finishedAt: null };
        }>(server, "/api/ops/log-rotation/status");
        assert.equal(partialLastRun.body.lastRun.finishedAt, null);

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({
                lastRun: {
                    ok: false,
                    message: "permission denied",
                    result: { ok: false },
                    stderr: "permission denied",
                },
            }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const failureLastRun = await requestJson<{
            success: boolean;
            lastRun: { errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.deepEqual(failureLastRun.body.lastRun.errors, [
            {
                message: "permission denied",
                result: { ok: false },
                stderr: "permission denied",
            },
        ]);

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({ lastRun: { ok: false } }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const failureWithoutDetails = await requestJson<{
            success: boolean;
            lastRun: { errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.deepEqual(failureWithoutDetails.body.lastRun.errors, []);

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({ lastRun: { ok: false, stderr: "sudo unavailable" } }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const failureWithStderr = await requestJson<{
            success: boolean;
            lastRun: { errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.deepEqual(failureWithStderr.body.lastRun.errors, [
            {
                message: "sudo unavailable",
                result: null,
                stderr: "sudo unavailable",
            },
        ]);

        db.prepare(
            `INSERT OR REPLACE INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, consecutive_failures, metadata_json
            ) VALUES (?, ?, 'backend', ?, ?, ?, 'fresh', 0, '{}')`
        ).run(
            "log_rotation.state",
            JSON.stringify({
                lastRun: { ok: false, result: { ok: false }, stderr: 123 },
            }),
            "2026-05-11T01:00:00.000Z",
            "2026-05-11T01:00:00.000Z",
            "2026-08-11T01:00:00.000Z"
        );
        const failureWithStructuredResult = await requestJson<{
            success: boolean;
            lastRun: { errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.deepEqual(failureWithStructuredResult.body.lastRun.errors, [
            {
                message: "Log rotation failed",
                result: { ok: false },
                stderr: "",
            },
        ]);
    });

    it("runs dry-run log rotation without changing files or state", async () => {
        const before = await readFile(logPath, "utf8");
        const statusBefore = await requestJson<unknown>(
            server,
            "/api/ops/log-rotation/status"
        );
        let elevatedCalls = 0;
        server.opsTesting.setElevatedLogRotationRunner(async () => {
            elevatedCalls += 1;
            return { result: { ok: false }, stderr: "should not run" };
        });
        try {
            const response = await requestJson<{
                success: boolean;
                result: { ok: boolean; dryRun: boolean; rotatedFiles: number };
                stderr: string;
            }>(server, "/api/ops/log-rotation/dry-run", { method: "POST" });

            assert.equal(response.status, 200);
            assert.equal(response.body.success, true);
            assert.equal(response.body.result.dryRun, true);
            assert.equal(response.body.result.rotatedFiles, 1);
            assert.equal(response.body.stderr, "");
            assert.equal(elevatedCalls, 0);
            assert.equal(await readFile(logPath, "utf8"), before);
            const statusAfter = await requestJson<unknown>(
                server,
                "/api/ops/log-rotation/status"
            );
            assert.equal(statusBefore.status, 200);
            assert.equal(statusAfter.status, 200);
            assert.deepEqual(statusAfter.body, statusBefore.body);
        } finally {
            server.opsTesting.setElevatedLogRotationRunner(
                server.defaultElevatedLogRotationRunner
            );
        }
    });

    it("requires explicit true log rotation results for route success", async () => {
        server.opsTesting.setElevatedLogRotationRunner(async () => ({
            result: { ok: "false" },
            stderr: "",
        }));
        try {
            const run = await requestJson<{
                success: boolean;
                result: { ok: number };
            }>(server, "/api/ops/log-rotation/run", { method: "POST" });

            assert.equal(run.status, 200);
            assert.equal(run.body.success, false);
        } finally {
            server.opsTesting.setElevatedLogRotationRunner(
                server.defaultElevatedLogRotationRunner
            );
        }
    });

    it("runs real log rotation through the elevated helper", async () => {
        const { __testing, runLogRotation } = await import(
            `./ops.js?elevated=${Date.now()}`
        );
        const command: { current?: { args: readonly string[]; file: string } } = {};
        __testing.resetLogRotationRunner();
        __testing.setLogRotationExecFileRunner(
            async (file: string, args: readonly string[] | undefined) => {
                command.current = { args: args ?? [], file };
                return {
                    stderr: "helper warning",
                    stdout: JSON.stringify({ dryRun: false, ok: true }),
                };
            }
        );
        try {
            const result = await runLogRotation({ dryRun: false });

            assert.deepEqual(result, {
                result: { dryRun: false, ok: true },
                stderr: "helper warning",
            });
            assert.equal(command.current?.file, "sudo");
            assert.equal(command.current?.args[0], "-n");
            assert.equal(command.current?.args[1], "-E");
            assert.equal(command.current?.args[2], process.execPath);
            assert.deepEqual(command.current?.args.slice(3, 5), ["--import", "tsx"]);
            const evalIndex = command.current?.args.indexOf("--eval") ?? -1;
            assert.equal(command.current?.args[evalIndex - 1], "--input-type=module");
            assert.match(
                command.current?.args[evalIndex + 1] ?? "",
                /services\/logRotation\.ts/u
            );
            assert.equal(command.current?.args[evalIndex + 3], "--json");

            __testing.setLogRotationExecFileRunner(async () => ({
                stderr: "",
                stdout: "",
            }));
            assert.deepEqual(await runLogRotation({ dryRun: false }), {
                result: {
                    ok: false,
                    error: "Elevated log rotation returned empty JSON output",
                },
                stderr: "Elevated log rotation returned empty JSON output",
            });
        } finally {
            __testing.resetLogRotationRunner();
        }
    });

    it("runs real log rotation and records lastRun in SQLite", async () => {
        const response = await requestJson<{
            success: boolean;
            result: {
                compressedFiles: number;
                deletedArchives: number;
                dryRun: boolean;
                ok: boolean;
                rotatedFiles: number;
            };
        }>(server, "/api/ops/log-rotation/run", { method: "POST" });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.result.dryRun, false);
        assert.equal(response.body.result.rotatedFiles, 1);
        assert.equal(response.body.result.compressedFiles, 2);
        assert.equal(response.body.result.deletedArchives, 1);
        assert.equal(await readFile(logPath, "utf8"), "");
        await access(`${archiveNewPath}.gz`);
        await assert.rejects(access(archiveOldPath));

        const status = await requestJson<{
            lastRun: { rotatedFiles: number; errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.equal(status.body.lastRun.rotatedFiles, 1);
        assert.deepEqual(status.body.lastRun.errors, []);
    });
});
