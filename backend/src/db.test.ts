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

test("removes legacy task child orphans before enabling foreign keys", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-task-orphans-"));
    const configuredPath = path.join(tempDir, "configured.db");
    process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
    const legacyDb = new DatabaseSync(configuredPath);
    let legacyDbClosed = false;
    let result: Awaited<typeof import("./db.js")> | undefined;

    try {
        legacyDb.exec("PRAGMA foreign_keys = OFF");
        legacyDb.exec(`
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo',
                priority TEXT NOT NULL DEFAULT 'medium',
                labels_json TEXT NOT NULL DEFAULT '[]',
                automation_json TEXT NOT NULL DEFAULT '{}',
                assignee TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id)
            );
            CREATE TABLE task_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                author TEXT NOT NULL,
                message_md TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id)
            );
            CREATE TABLE task_dependencies (
                task_id INTEGER NOT NULL,
                depends_on_task_id INTEGER NOT NULL
            );
            INSERT INTO tasks (id, title, created_at, updated_at)
            VALUES (1, 'kept', '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z');
            INSERT INTO task_events (task_id, event_type, created_at)
            VALUES (1, 'kept', '2026-06-09T00:00:00.000Z'),
                   (404, 'orphan', '2026-06-09T00:00:00.000Z');
            INSERT INTO task_updates (task_id, author, message_md, created_at)
            VALUES (1, 'mira', 'kept', '2026-06-09T00:00:00.000Z'),
                   (404, 'mira', 'orphan', '2026-06-09T00:00:00.000Z');
            INSERT INTO task_dependencies (task_id, depends_on_task_id)
            VALUES (1, 1), (1, 2), (404, 1);
        `);
        legacyDb.close();
        legacyDbClosed = true;

        const imported = await import(`./db.js?taskOrphans=${randomUUID()}`);
        result = imported;

        assert.equal(
            (
                imported.db.prepare("PRAGMA foreign_keys").get() as {
                    foreign_keys: number;
                }
            ).foreign_keys,
            1
        );
        assert.equal(
            (
                imported.db
                    .prepare("SELECT COUNT(*) AS count FROM task_events")
                    .get() as {
                    count: number;
                }
            ).count,
            1
        );
        assert.equal(
            (
                imported.db
                    .prepare("SELECT COUNT(*) AS count FROM task_updates")
                    .get() as {
                    count: number;
                }
            ).count,
            1
        );
        assert.equal(
            (
                imported.db
                    .prepare("SELECT COUNT(*) AS count FROM task_dependencies")
                    .get() as {
                    count: number;
                }
            ).count,
            1
        );
    } finally {
        await cleanupTempDb(originalDbPath, tempDir, [
            () => {
                if (!legacyDbClosed) {
                    legacyDb.close();
                }
            },
            () => (result?.db as { close(): void } | undefined)?.close(),
        ]);
    }
});

test("classifies duplicate-column migration errors", async () => {
    const { cleanup, result } = await importWithTempDb("migrationHelpers");
    try {
        assert.equal(
            result.__testing.validateTaskChildTableName("task_events"),
            "task_events"
        );
        assert.throws(
            () =>
                result.__testing.validateTaskChildTableName(
                    "task_events; DROP TABLE tasks"
                ),
            /Unsupported task child table/u
        );
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

test("retries transient task orphan cleanup locks", async () => {
    const { cleanup, result } = await importWithTempDb("taskOrphanRetry");
    let attempts = 0;
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "task_events" }],
        }),
        exec: (sql: string) => {
            if (sql.includes("DELETE FROM task_events")) {
                attempts += 1;
                if (attempts < 2) {
                    const error = new Error("database is locked") as Error & {
                        code: string;
                    };
                    error.code = "SQLITE_BUSY";
                    throw error;
                }
            }
        },
    };

    try {
        result.__testing.cleanupTaskForeignKeyOrphans(targetDb);
        assert.equal(attempts, 2);
    } finally {
        await cleanup();
    }
});

test("rethrows non-transient task orphan cleanup errors", async () => {
    const { cleanup, result } = await importWithTempDb("taskOrphanNonTransient");
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "task_events" }],
        }),
        exec: () => {
            throw new Error("delete failed");
        },
    };

    try {
        assert.throws(
            () => result.__testing.cleanupTaskForeignKeyOrphans(targetDb),
            /delete failed/u
        );
    } finally {
        await cleanup();
    }
});

test("rethrows exhausted transient task orphan cleanup locks", async () => {
    const { cleanup, result } = await importWithTempDb("taskOrphanRetryExhausted");
    let attempts = 0;
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "task_events" }],
        }),
        exec: () => {
            attempts += 1;
            const error = new Error(`database is locked ${attempts}`) as Error & {
                code: string;
            };
            error.code = "SQLITE_LOCKED";
            throw error;
        },
    };

    try {
        assert.throws(
            () => result.__testing.cleanupTaskForeignKeyOrphans(targetDb),
            /database is locked 4/u
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
        testDb.exec("PRAGMA foreign_keys = ON");
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
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_slug TEXT NOT NULL,
                service_name TEXT NOT NULL
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
            INSERT INTO docker_managed_services (id, app_slug, service_name)
            VALUES (1, 'media', 'web');
            INSERT INTO docker_update_events (
                id, managed_service_id, event_type, created_at
            ) VALUES (7, 1, 'updated', '2026-06-07T00:00:00.000Z');
        `);

        result.__testing.ensureDockerUpdateEventsSetNull(testDb);
        testDb.prepare("DELETE FROM docker_managed_services WHERE id = 1").run();

        const event = testDb
            .prepare(
                `SELECT managed_service_id, app_slug, service_name
                 FROM docker_update_events WHERE id = 7`
            )
            .get() as
            | {
                  managed_service_id: number | null;
                  app_slug: string;
                  service_name: string;
              }
            | undefined;
        assert.equal(event?.managed_service_id, null);
        assert.equal(event?.app_slug, "media");
        assert.equal(event?.service_name, "web");
    } finally {
        testDb.close();
        await cleanup();
    }
});

test("nulls orphaned docker updater event service ids during migration", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { cleanup, result } = await importWithTempDb("dockerEventsOrphan");
    const testDb = new DatabaseSync(":memory:");
    try {
        testDb.exec("PRAGMA foreign_keys = ON");
        testDb.exec(`
            CREATE TABLE docker_managed_services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_slug TEXT NOT NULL,
                service_name TEXT NOT NULL
            );
            CREATE TABLE docker_update_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                managed_service_id INTEGER,
                app_slug TEXT NOT NULL DEFAULT '',
                service_name TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                from_tag TEXT,
                to_tag TEXT,
                from_digest TEXT,
                to_digest TEXT,
                message TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            INSERT INTO docker_update_events (
                id, managed_service_id, app_slug, service_name, event_type, created_at
            ) VALUES (
                8, 404, 'deleted', 'worker', 'updated', '2026-06-07T00:00:00.000Z'
            );
        `);

        result.__testing.ensureDockerUpdateEventsSetNull(testDb);

        const event = testDb
            .prepare(
                `SELECT managed_service_id, app_slug, service_name
                 FROM docker_update_events WHERE id = 8`
            )
            .get() as
            | {
                  managed_service_id: number | null;
                  app_slug: string;
                  service_name: string;
              }
            | undefined;
        assert.equal(event?.managed_service_id, null);
        assert.equal(event?.app_slug, "deleted");
        assert.equal(event?.service_name, "worker");
    } finally {
        testDb.close();
        await cleanup();
    }
});

test("adds nullable service ids to legacy docker updater events", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { cleanup, result } = await importWithTempDb("dockerEventsLegacy");
    const testDb = new DatabaseSync(":memory:");
    try {
        testDb.exec("PRAGMA foreign_keys = ON");
        testDb.exec(`
            CREATE TABLE docker_managed_services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_slug TEXT NOT NULL,
                service_name TEXT NOT NULL
            );
            CREATE TABLE docker_update_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_slug TEXT NOT NULL DEFAULT '',
                service_name TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                from_tag TEXT,
                to_tag TEXT,
                from_digest TEXT,
                to_digest TEXT,
                message TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            INSERT INTO docker_update_events (
                id, app_slug, service_name, event_type, created_at
            ) VALUES (
                9, 'legacy', 'web', 'updated', '2026-06-07T00:00:00.000Z'
            );
        `);

        result.__testing.ensureDockerUpdateEventsSetNull(testDb);

        const event = testDb
            .prepare(
                `SELECT managed_service_id, app_slug, service_name
                 FROM docker_update_events WHERE id = 9`
            )
            .get() as
            | {
                  managed_service_id: number | null;
                  app_slug: string;
                  service_name: string;
              }
            | undefined;
        assert.equal(event?.managed_service_id, null);
        assert.equal(event?.app_slug, "legacy");
        assert.equal(event?.service_name, "web");
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

test("retries transient cache updated_at nullable migration locks", async () => {
    const { cleanup, result } = await importWithTempDb("cacheRetry");
    const calls: string[] = [];
    let beginAttempts = 0;
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "updated_at", notnull: 1 }],
        }),
        exec: (sql: string) => {
            calls.push(sql);
            if (sql === "BEGIN IMMEDIATE") {
                beginAttempts += 1;
                if (beginAttempts < 2) {
                    const error = new Error("database is locked") as Error & {
                        code: string;
                    };
                    error.code = "SQLITE_BUSY";
                    throw error;
                }
            }
        },
    };

    try {
        result.__testing.ensureCacheEntriesUpdatedAtNullable(targetDb);
        assert.equal(beginAttempts, 2);
        assert.deepEqual(
            calls.filter((call) => call === "ROLLBACK" || call === "COMMIT"),
            ["ROLLBACK", "COMMIT"]
        );
    } finally {
        await cleanup();
    }
});

test("rethrows the final transient cache migration lock after retries", async () => {
    const { cleanup, result } = await importWithTempDb("cacheRetryExhausted");
    let beginAttempts = 0;
    const targetDb = {
        prepare: () => ({
            all: () => [{ name: "updated_at", notnull: 1 }],
        }),
        exec: (sql: string) => {
            if (sql === "BEGIN IMMEDIATE") {
                beginAttempts += 1;
                const error = new Error(
                    `database is locked ${beginAttempts}`
                ) as Error & {
                    code: string;
                };
                error.code = "SQLITE_LOCKED";
                throw error;
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureCacheEntriesUpdatedAtNullable(targetDb),
            /database is locked 4/u
        );
    } finally {
        await cleanup();
    }
});

test("retries transient docker event migration locks", async () => {
    const { cleanup, result } = await importWithTempDb("dockerEventsRetry");
    let migrationAttempts = 0;
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
            if (sql.includes("ALTER TABLE docker_update_events RENAME")) {
                migrationAttempts += 1;
                if (migrationAttempts < 2) {
                    const error = new Error(
                        "SQLITE_BUSY: database is locked"
                    ) as Error & {
                        code: string;
                    };
                    error.code = "SQLITE_BUSY";
                    throw error;
                }
            }
        },
    };

    try {
        result.__testing.ensureDockerUpdateEventsSetNull(targetDb);
        assert.equal(migrationAttempts, 2);
    } finally {
        await cleanup();
    }
});

test("rethrows the final transient docker event migration lock after retries", async () => {
    const { cleanup, result } = await importWithTempDb("dockerEventsRetryExhausted");
    let migrationAttempts = 0;
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
            if (sql.includes("ALTER TABLE docker_update_events RENAME")) {
                migrationAttempts += 1;
                const error = new Error(
                    `SQLITE_LOCKED: database is locked ${migrationAttempts}`
                ) as Error & { code: string };
                error.code = "SQLITE_LOCKED";
                throw error;
            }
        },
    };

    try {
        assert.throws(
            () => result.__testing.ensureDockerUpdateEventsSetNull(targetDb),
            /database is locked 4/u
        );
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
