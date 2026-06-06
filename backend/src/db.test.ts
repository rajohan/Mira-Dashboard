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

test("migrates cache updated_at to nullable while preserving rows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-cache-nullable-"));
    process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "configured.db");
    let result: Awaited<typeof import("./db.js")> | undefined;
    const testDb = new DatabaseSync(":memory:");
    try {
        result = await import(`./db.js?cacheNullable=${randomUUID()}`);
        testDb.exec(`
            CREATE TABLE cache_entries (
                key TEXT PRIMARY KEY,
                data_json TEXT,
                source TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_attempt_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                status TEXT NOT NULL,
                error_code TEXT,
                error_message TEXT,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );
            INSERT INTO cache_entries (
                key, data_json, source, updated_at, last_attempt_at, expires_at,
                status, error_code, error_message, consecutive_failures, metadata_json
            ) VALUES (
                'cache.key', '{"ok":true}', 'test', '2026-06-06T00:00:00.000Z',
                '2026-06-06T00:00:00.000Z', '2026-06-06T01:00:00.000Z',
                'fresh', NULL, NULL, 0, '{}'
            );
        `);

        assert.ok(result);
        result.__testing.ensureCacheEntriesUpdatedAtNullable(testDb);

        const updatedAtColumn = testDb
            .prepare("PRAGMA table_info(cache_entries)")
            .all()
            .find((column) => column.name === "updated_at");
        assert.equal(updatedAtColumn?.notnull, 0);
        assert.equal(
            (
                testDb
                    .prepare("SELECT source FROM cache_entries WHERE key = 'cache.key'")
                    .get() as { source: string }
            ).source,
            "test"
        );
        assert.equal(
            testDb
                .prepare("SELECT name FROM sqlite_master WHERE name = ?")
                .get("idx_cache_entries_status") !== undefined,
            true
        );
    } finally {
        testDb.close();
        (result?.db as { close(): void } | undefined)?.close();
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("rolls back failed cache updated_at nullable migrations", async () => {
    const result = await import(`./db.js?cacheNullableRollback=${randomUUID()}`);
    const calls: string[] = [];
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "updated_at", notnull: 1 }],
        }),
        exec: (sql: string) => {
            calls.push(sql);
            if (sql.includes("ALTER TABLE cache_entries RENAME")) {
                throw new Error("migration failed");
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureCacheEntriesUpdatedAtNullable(targetDb),
            /migration failed/u
        );
        assert.equal(calls[0], "BEGIN IMMEDIATE");
        assert.match(calls[1], /ALTER TABLE cache_entries RENAME/u);
        assert.equal(calls[2], "ROLLBACK");
    } finally {
        (result.db as { close(): void }).close();
    }
});

test("preserves cache migration failures when rollback also fails", async () => {
    const result = await import(`./db.js?cacheNullableRollbackFailure=${randomUUID()}`);
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "updated_at", notnull: 1 }],
        }),
        exec: (sql: string) => {
            if (sql === "ROLLBACK") {
                throw new Error("rollback failed");
            }
            if (sql.includes("ALTER TABLE cache_entries RENAME")) {
                throw new Error("migration failed");
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureCacheEntriesUpdatedAtNullable(targetDb),
            /migration failed/u
        );
    } finally {
        (result.db as { close(): void }).close();
    }
});
