import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function restoreDbPath(originalDbPath: string | undefined): void {
    if (originalDbPath === undefined) {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
    } else {
        process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
    }
}

async function cleanupTempDb(
    originalDbPath: string | undefined,
    tempDir: string,
    closeFns: Array<() => void>
): Promise<void> {
    let closeError: unknown;
    try {
        for (const close of closeFns) {
            try {
                close();
            } catch (error) {
                closeError ??= error;
            }
        }
    } finally {
        restoreDbPath(originalDbPath);
        await rm(tempDir, { recursive: true, force: true });
    }
    if (closeError) {
        throw closeError;
    }
}

async function importWithTempDb(token: string): Promise<{
    result: Awaited<typeof import("./db.js")>;
    cleanup: () => Promise<void>;
}> {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `mira-db-${token}-`));
    process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "test.db");
    let result: Awaited<typeof import("./db.js")>;
    try {
        result = await import(`./db.js?${token}=${randomUUID()}`);
    } catch (error) {
        restoreDbPath(originalDbPath);
        await rm(tempDir, { recursive: true, force: true });
        throw error;
    }
    return {
        result,
        cleanup: () =>
            cleanupTempDb(originalDbPath, tempDir, [
                () => (result.db as { close(): void }).close(),
            ]),
    };
}

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
        restoreDbPath(originalDbPath);
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
        restoreDbPath(originalDbPath);
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("classifies duplicate-column migration errors", async () => {
    const { cleanup, result } = await importWithTempDb("migrationHelpers");
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
        await cleanup();
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
        await cleanupTempDb(originalDbPath, tempDir, [
            () => testDb.close(),
            () => (result?.db as { close(): void } | undefined)?.close(),
        ]);
    }
});

test("migrates docker updater events to preserve service deletion history", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { cleanup, result } = await importWithTempDb("dockerEventsSetNull");
    const testDb = new DatabaseSync(":memory:");
    try {
        testDb.exec("PRAGMA foreign_keys = ON");
        testDb.exec(`
            CREATE TABLE docker_managed_services (
                id INTEGER PRIMARY KEY AUTOINCREMENT
            );
            CREATE TABLE docker_update_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                managed_service_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                from_tag TEXT,
                to_tag TEXT,
                from_digest TEXT,
                to_digest TEXT,
                message TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(managed_service_id) REFERENCES docker_managed_services(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_docker_update_events_created_at
                ON docker_update_events(created_at DESC);
            INSERT INTO docker_managed_services (id) VALUES (1);
            INSERT INTO docker_update_events (
                id, managed_service_id, event_type, created_at
            ) VALUES (7, 1, 'updated', '2026-06-07T00:00:00.000Z');
        `);

        result.__testing.ensureDockerUpdateEventsSetNull(testDb);
        testDb.prepare("DELETE FROM docker_managed_services WHERE id = 1").run();

        const event = testDb
            .prepare("SELECT managed_service_id FROM docker_update_events WHERE id = 7")
            .get() as { managed_service_id: number | null } | undefined;
        assert.equal(event?.managed_service_id, null);
    } finally {
        testDb.close();
        await cleanup();
    }
});

test("rolls back failed docker updater event migrations", async () => {
    const { cleanup, result } = await importWithTempDb("dockerEventsRollback");
    const calls: string[] = [];
    const targetDb = {
        prepare: (sql: string) => ({
            all: () =>
                sql.includes("foreign_key_list")
                    ? [
                          {
                              from: "managed_service_id",
                              on_delete: "CASCADE",
                              table: "docker_managed_services",
                          },
                      ]
                    : [{ name: "managed_service_id", notnull: 1 }],
        }),
        exec: (sql: string) => {
            calls.push(sql);
            if (sql.includes("ALTER TABLE docker_update_events RENAME")) {
                throw new Error("migration failed");
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureDockerUpdateEventsSetNull(targetDb),
            /migration failed/u
        );
        assert.equal(calls[0], "BEGIN IMMEDIATE");
        assert.match(calls[1], /ALTER TABLE docker_update_events RENAME/u);
        assert.equal(calls[2], "ROLLBACK");
    } finally {
        await cleanup();
    }
});

test("migrates nullable docker updater event tables with missing foreign keys", async () => {
    const { cleanup, result } = await importWithTempDb("dockerEventsMissingFk");
    const calls: string[] = [];
    const targetDb = {
        prepare: (sql: string) => ({
            all: () =>
                sql.includes("foreign_key_list")
                    ? []
                    : [{ name: "managed_service_id", notnull: 0 }],
        }),
        exec: (sql: string) => {
            calls.push(sql);
        },
    };

    try {
        result.__testing.ensureDockerUpdateEventsSetNull(targetDb);
        assert.equal(calls[0], "BEGIN IMMEDIATE");
        assert.match(calls[1], /ALTER TABLE docker_update_events RENAME/u);
        assert.equal(calls[2], "COMMIT");
    } finally {
        await cleanup();
    }
});

test("preserves docker event migration failures when rollback also fails", async () => {
    const { cleanup, result } = await importWithTempDb("dockerEventsRollbackFailure");
    const targetDb = {
        prepare: (sql: string) => ({
            all: () =>
                sql.includes("foreign_key_list")
                    ? [
                          {
                              from: "managed_service_id",
                              on_delete: "CASCADE",
                              table: "docker_managed_services",
                          },
                      ]
                    : [{ name: "managed_service_id", notnull: 1 }],
        }),
        exec: (sql: string) => {
            if (sql === "ROLLBACK") {
                throw new Error("rollback failed");
            }
            if (sql.includes("ALTER TABLE docker_update_events RENAME")) {
                throw new Error("migration failed");
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureDockerUpdateEventsSetNull(targetDb),
            /migration failed/u
        );
    } finally {
        await cleanup();
    }
});

test("rolls back failed cache updated_at nullable migrations", async () => {
    const { cleanup, result } = await importWithTempDb("cacheNullableRollback");
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
        await cleanup();
    }
});

test("preserves cache migration failures when rollback also fails", async () => {
    const { cleanup, result } = await importWithTempDb("cacheNullableRollbackFailure");
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
        await cleanup();
    }
});
