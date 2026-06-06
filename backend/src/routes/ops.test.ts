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

import { db } from "../db.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(configPath: string): Promise<TestServer> {
    process.env.MIRA_LOG_ROTATION_CONFIG = configPath;
    const { default: opsRoutes } = await import(`./ops.js?test=${Date.now()}`);
    const app = express();
    app.use(express.json());
    opsRoutes(app);
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
    const originalConfig = process.env.MIRA_LOG_ROTATION_CONFIG;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-ops-route-"));
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
            db.exec("DELETE FROM cache_entries WHERE key = 'log_rotation.state';");
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
            lastRun: { finishedAt: string; ok: boolean };
        }>(server, "/api/ops/log-rotation/status");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            success: true,
            lastRun: { finishedAt: "2026-05-11T01:00:00.000Z", ok: true },
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
    });

    it("runs dry-run log rotation without changing files or state", async () => {
        const before = await readFile(logPath, "utf8");
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
        assert.equal(await readFile(logPath, "utf8"), before);
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
        assert.equal(response.body.result.compressedFiles, 3);
        assert.equal(response.body.result.deletedArchives, 1);
        assert.equal(await readFile(logPath, "utf8"), "");
        await access(`${archiveNewPath}.gz`);
        await assert.rejects(access(`${archiveOldPath}.gz`));

        const status = await requestJson<{
            lastRun: { rotatedFiles: number; errors: unknown[] };
        }>(server, "/api/ops/log-rotation/status");
        assert.equal(status.body.lastRun.rotatedFiles, 1);
        assert.deepEqual(status.body.lastRun.errors, []);
    });
});
