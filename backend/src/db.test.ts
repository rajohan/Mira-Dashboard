import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("uses process cwd data directory when no explicit db path is configured", async () => {
    const originalCwd = process.cwd();
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-default-"));
    let db: { close(): void } | undefined;

    try {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
        process.chdir(tempDir);
        try {
            const result = await import(`./db.js?defaultPath=${randomUUID()}`);
            db = result.db;
            const expectedPath = path.join(
                fs.realpathSync(tempDir),
                "data",
                "mira-dashboard.db"
            );

            assert.equal(result.miraDbPath, expectedPath);
        } finally {
            db?.close();
        }
    } finally {
        process.chdir(originalCwd);
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("uses configured db path when provided", async () => {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-configured-"));
    const configuredPath = path.join(tempDir, "nested", "configured.db");
    let db: { close(): void } | undefined;

    try {
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
        try {
            const result = await import(`./db.js?configuredPath=${randomUUID()}`);
            db = result.db;

            assert.equal(result.miraDbPath, configuredPath);
            assert.equal(
                (
                    result.db.prepare("PRAGMA foreign_keys").get() as {
                        foreign_keys: number;
                    }
                ).foreign_keys,
                1
            );
        } finally {
            db?.close();
        }
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("classifies duplicate-column migration errors", async () => {
    const result = await import(`./db.js?migrationHelpers=${randomUUID()}`);
    try {
        assert.equal(
            result.__testing.isDuplicateColumnError(
                new Error("duplicate column name: schedule_type")
            ),
            true
        );
        assert.doesNotThrow(() =>
            result.__testing.assertDuplicateColumnError(
                new Error("duplicate column name: automation_json")
            )
        );
        assert.throws(
            () => result.__testing.assertDuplicateColumnError(new Error("syntax error")),
            /syntax error/u
        );
    } finally {
        (result.db as { close(): void }).close();
    }
});
