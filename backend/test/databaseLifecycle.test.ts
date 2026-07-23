import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";

import {
    applyDatabaseMigrations,
    validateDatabaseMigrationHistory,
} from "../src/databaseMigrationRunner.ts";
import { initialSchemaMigration } from "../src/databaseMigrations/0001InitialSchema.ts";
import {
    prepareDatabaseStorage,
    secureSqliteFilePermissions,
    sqliteBackupDirectory,
} from "../src/databaseStorage.ts";
import { pruneDatabaseHistory } from "../src/services/sqliteMaintenance.ts";
import {
    createVerifiedSqliteBackup,
    getSqliteBackupInventory,
    pruneSqliteBackups,
} from "../src/sqliteBackup.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
}

function openWalDatabase(databasePath: string): Database {
    const database = new Database(databasePath);
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA busy_timeout = 5000");
    database.run("PRAGMA journal_mode = WAL");
    return database;
}

function runSql(database: Database, sql: string): void {
    for (const statement of sql.split(";")) {
        const trimmedStatement = statement.trim();
        if (trimmedStatement) {
            database.run(trimmedStatement);
        }
    }
}

function mode(filePath: string): number {
    return statSync(filePath).mode & 0o777;
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

afterEach(() => {
    const rootsToRemove = [...temporaryRoots];
    temporaryRoots.length = 0;
    for (const root of rootsToRemove) {
        rmSync(root, { force: true, recursive: true });
    }
});

describe("Dashboard SQLite lifecycle", () => {
    it("applies immutable migrations once to a fresh database", () => {
        const root = temporaryRoot("mira-db-migrations-fresh-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            const first = applyDatabaseMigrations(database, databasePath);
            const second = applyDatabaseMigrations(database, databasePath);

            expect(first.applied).toEqual([1, 2, 3]);
            expect(first.backup).toBeUndefined();
            expect(second).toEqual({ applied: [] });
            expect(validateDatabaseMigrationHistory(database)).toBe(3);
            expect(
                database
                    .query("SELECT name FROM pragma_table_info('auth_sessions')")
                    .all()
            ).toContainEqual({ name: "validator_hash" });
            expect(
                database
                    .query(
                        `SELECT name
                         FROM sqlite_schema
                         WHERE type = 'index'
                           AND name IN (
                               'idx_agent_task_history_retention',
                               'idx_deployment_jobs_retention',
                               'idx_docker_update_events_retention',
                               'idx_reports_retention',
                               'idx_task_updates_task_created'
                           )
                         ORDER BY name`
                    )
                    .all()
            ).toEqual([
                { name: "idx_agent_task_history_retention" },
                { name: "idx_deployment_jobs_retention" },
                { name: "idx_docker_update_events_retention" },
                { name: "idx_reports_retention" },
                { name: "idx_task_updates_task_created" },
            ]);

            const retentionQueryPlans = [
                {
                    index: "idx_deployment_jobs_retention",
                    sql: `SELECT id
                          FROM deployment_jobs
                          WHERE status NOT IN ('building', 'restart-scheduled')
                          ORDER BY started_at DESC, id DESC
                          LIMIT -1 OFFSET 500`,
                },
                {
                    index: "idx_agent_task_history_retention",
                    sql: `SELECT id
                          FROM agent_task_history
                          WHERE status != 'active' AND completed_at IS NOT NULL
                          ORDER BY completed_at DESC, id DESC
                          LIMIT -1 OFFSET 10000`,
                },
                {
                    index: "idx_reports_retention",
                    sql: `SELECT id
                          FROM reports
                          ORDER BY occurred_at DESC, id DESC
                          LIMIT -1 OFFSET 5000`,
                },
                {
                    index: "idx_docker_update_events_retention",
                    sql: `SELECT id
                          FROM docker_update_events
                          ORDER BY created_at DESC, id DESC
                          LIMIT -1 OFFSET 5000`,
                },
            ];
            for (const { index, sql } of retentionQueryPlans) {
                const plan = database.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
                    detail: string;
                }>;
                expect(plan.map((row) => row.detail).join("\n")).toContain(
                    `USING COVERING INDEX ${index}`
                );
            }
            expect(existsSync(sqliteBackupDirectory(databasePath))).toBe(false);
        } finally {
            database.close();
        }
    });

    it("serializes concurrent web and worker migration startup", async () => {
        const root = temporaryRoot("mira-db-migrations-concurrent-");
        const databasePath = path.join(root, "dashboard.db");
        const databaseModuleUrl = pathToFileURL(
            path.resolve(import.meta.dirname, "../src/database.ts")
        ).href;
        const childScript = `
            const { database } = await import(${JSON.stringify(databaseModuleUrl)});
            database.query("SELECT COUNT(*) AS count FROM schema_migrations").get();
            database.close();
        `;
        const children = Array.from({ length: 2 }, () =>
            Bun.spawn({
                cmd: [process.execPath, "--eval", childScript],
                env: {
                    ...process.env,
                    MIRA_DASHBOARD_DB_PATH: databasePath,
                    NODE_ENV: "test",
                },
                stderr: "pipe",
                stdout: "pipe",
            })
        );
        const results = await Promise.all(
            children.map(async (child) => {
                const [exitCode, stderr] = await Promise.all([
                    child.exited,
                    readText(child.stderr),
                    readText(child.stdout),
                ]);
                return { exitCode, stderr };
            })
        );

        expect(results).toEqual([
            { exitCode: 0, stderr: "" },
            { exitCode: 0, stderr: "" },
        ]);
        const database = new Database(databasePath, { readonly: true });
        try {
            expect(
                database.query("SELECT COUNT(*) AS count FROM schema_migrations").get()
            ).toEqual({ count: 3 });
        } finally {
            database.close();
        }
    });

    it("adopts a legacy schema only after a verified WAL-safe backup", () => {
        const root = temporaryRoot("mira-db-migrations-legacy-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            runSql(database, initialSchemaMigration.sql);
            database
                .prepare(
                    `INSERT INTO tasks (
                        title, body, status, priority, labels_json,
                        automation_json, created_at, updated_at
                     ) VALUES (?, '', 'todo', 'medium', '[]', '{}', ?, ?)`
                )
                .run(
                    "Committed legacy task",
                    "2026-07-23T00:00:00.000Z",
                    "2026-07-23T00:00:00.000Z"
                );

            const result = applyDatabaseMigrations(database, databasePath);
            expect(result.applied).toEqual([1, 2, 3]);
            expect(result.backup).toMatchObject({
                kind: "pre-migration",
                restoreVerified: true,
            });
            expect(result.backup?.path).toBeDefined();
            expect(mode(result.backup!.path)).toBe(0o600);

            const restored = new Database(result.backup!.path, { readonly: true });
            try {
                expect(restored.query("SELECT title FROM tasks").get()).toEqual({
                    title: "Committed legacy task",
                });
                expect(
                    restored
                        .query(
                            `SELECT 1
                             FROM sqlite_schema
                             WHERE type = 'table' AND name = 'schema_migrations'`
                        )
                        .get()
                ).toBeNull();
            } finally {
                restored.close();
            }
        } finally {
            database.close();
        }
    });

    it("fails closed on checksum drift and unknown migration versions", () => {
        const root = temporaryRoot("mira-db-migrations-drift-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            applyDatabaseMigrations(database, databasePath);
            const originalChecksum = (
                database
                    .query("SELECT checksum FROM schema_migrations WHERE version = 2")
                    .get() as { checksum: string }
            ).checksum;
            database
                .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2")
                .run("tampered");
            expect(() => validateDatabaseMigrationHistory(database)).toThrow(
                "SQLite migration 2 checksum mismatch"
            );
            database
                .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2")
                .run(originalChecksum);
            database
                .prepare(
                    `INSERT INTO schema_migrations (
                        version, name, checksum, applied_at
                     ) VALUES (4, 'unknown', 'unknown', ?)`
                )
                .run("2026-07-23T00:00:00.000Z");
            expect(() => validateDatabaseMigrationHistory(database)).toThrow(
                "unknown SQLite migration version 4"
            );

            database.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
            database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
            expect(() => validateDatabaseMigrationHistory(database)).toThrow(
                "not contiguous"
            );
        } finally {
            database.close();
        }
    });

    it("backs up committed WAL contents and verifies a standalone restore copy", () => {
        const root = temporaryRoot("mira-db-backup-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            database.run("CREATE TABLE values_to_restore (value TEXT NOT NULL)");
            database
                .prepare("INSERT INTO values_to_restore (value) VALUES (?)")
                .run("committed-in-wal");

            const backup = createVerifiedSqliteBackup(
                database,
                databasePath,
                "scheduled"
            );
            expect(backup.restoreVerified).toBe(true);
            expect(mode(backup.path)).toBe(0o600);
            const restored = new Database(backup.path, { readonly: true });
            try {
                expect(
                    restored.query("SELECT value FROM values_to_restore").get()
                ).toEqual({ value: "committed-in-wal" });
                expect(restored.query("PRAGMA quick_check").get()).toEqual({
                    quick_check: "ok",
                });
            } finally {
                restored.close();
            }
        } finally {
            database.close();
        }
    });

    it("runs a deploy preflight backup without applying pending migrations", async () => {
        const root = temporaryRoot("mira-db-preflight-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        runSql(database, initialSchemaMigration.sql);
        database.close();
        const preflightModuleUrl = pathToFileURL(
            path.resolve(import.meta.dirname, "../src/databasePreflight.ts")
        ).href;
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                "--eval",
                `const { runDatabasePreflight } = await import(${JSON.stringify(
                    preflightModuleUrl
                )}); console.log(JSON.stringify(await runDatabasePreflight()));`,
            ],
            env: {
                ...process.env,
                MIRA_DASHBOARD_DB_PATH: databasePath,
                NODE_ENV: "test",
            },
            stderr: "pipe",
            stdout: "pipe",
        });
        const [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            readText(child.stderr),
            readText(child.stdout),
        ]);

        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
            backup: { kind: "pre-deploy", restoreVerified: true },
        });
        expect(getSqliteBackupInventory(databasePath).count).toBe(1);
        const unchangedLegacyDatabase = new Database(databasePath, { readonly: true });
        try {
            expect(
                unchangedLegacyDatabase
                    .query(
                        `SELECT 1
                         FROM sqlite_schema
                         WHERE type = 'table' AND name = 'schema_migrations'`
                    )
                    .get()
            ).toBeNull();
        } finally {
            unchangedLegacyDatabase.close();
        }
    });

    it("retains only recognized backup files within count and age limits", () => {
        const root = temporaryRoot("mira-db-backup-retention-");
        const databasePath = path.join(root, "dashboard.db");
        const backupDirectory = sqliteBackupDirectory(databasePath);
        mkdirSync(backupDirectory, { mode: 0o700, recursive: true });
        const now = new Date("2026-07-23T12:00:00.000Z");
        for (let index = 0; index < 16; index += 1) {
            const backupPath = path.join(
                backupDirectory,
                `mira-dashboard-scheduled-202607${String(index + 1).padStart(
                    2,
                    "0"
                )}T000000000Z-123-${index.toString(16).padStart(8, "0")}.db`
            );
            writeFileSync(backupPath, `backup-${index}`);
            const modifiedAt = new Date(now.getTime() - index * 60 * 60 * 1000);
            utimesSync(backupPath, modifiedAt, modifiedAt);
        }
        const manualBackup = path.join(backupDirectory, "manual-do-not-delete.db");
        writeFileSync(manualBackup, "manual");

        const retention = pruneSqliteBackups(databasePath, now);

        expect(retention.removed).toHaveLength(2);
        expect(retention.retained).toBe(14);
        expect(existsSync(manualBackup)).toBe(true);
        expect(readFileSync(manualBackup, "utf8")).toBe("manual");
        expect(getSqliteBackupInventory(databasePath).count).toBe(14);
    });

    it("prunes only expired bounded history and preserves current rows", () => {
        const root = temporaryRoot("mira-db-history-retention-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        const oldTimestamp = "2025-01-01T00:00:00.000Z";
        const currentTimestamp = "2026-07-22T00:00:00.000Z";
        const now = new Date("2026-07-23T12:00:00.000Z");
        try {
            applyDatabaseMigrations(database, databasePath);
            database
                .prepare(
                    `INSERT INTO users (
                        username, password_hash, created_at, updated_at
                     ) VALUES ('retention-user', 'hash', ?, ?)`
                )
                .run(currentTimestamp, currentTimestamp);
            const userId = Number(
                (
                    database
                        .query("SELECT id FROM users WHERE username = 'retention-user'")
                        .get() as { id: number }
                ).id
            );
            database
                .prepare(
                    `INSERT INTO auth_sessions (
                        id, user_id, created_at, expires_at, validator_hash
                     ) VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL)`
                )
                .run(
                    "old-session",
                    userId,
                    oldTimestamp,
                    oldTimestamp,
                    "current-session",
                    userId,
                    currentTimestamp,
                    "2026-08-01T00:00:00.000Z"
                );
            database
                .prepare(
                    `INSERT INTO scheduled_jobs (
                        id, name, enabled, schedule_type, interval_seconds,
                        action_key, action_payload_json, created_at, updated_at
                     ) VALUES ('retention-job', 'Retention', 1, 'daily', 86400,
                               'retention.job', '{}', ?, ?)`
                )
                .run(currentTimestamp, currentTimestamp);
            database
                .prepare(
                    `INSERT INTO scheduled_job_runs (
                        job_id, status, trigger_type, started_at, finished_at
                     ) VALUES
                       ('retention-job', 'success', 'schedule', ?, ?),
                       ('retention-job', 'success', 'schedule', ?, ?)`
                )
                .run(oldTimestamp, oldTimestamp, currentTimestamp, currentTimestamp);
            database
                .prepare(
                    `INSERT INTO job_executions (
                        id, action_key, display_name, resource_class, priority,
                        status, trigger_type, queued_at, available_at, finished_at,
                        timeout_ms
                     ) VALUES
                       ('old-execution', 'retention.job', 'Old', 'light', 1,
                        'success', 'schedule', ?, ?, ?, 1000),
                       ('current-execution', 'retention.job', 'Current', 'light', 1,
                        'success', 'schedule', ?, ?, ?, 1000)`
                )
                .run(
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    currentTimestamp,
                    currentTimestamp,
                    currentTimestamp
                );
            database
                .prepare(
                    `INSERT INTO deployment_jobs (
                        id, status, started_at, updated_at
                     ) VALUES
                       ('old-deployment', 'isOk', ?, ?),
                       ('current-deployment', 'isOk', ?, ?)`
                )
                .run(oldTimestamp, oldTimestamp, currentTimestamp, currentTimestamp);
            database
                .prepare(
                    `INSERT INTO agent_task_history (
                        agent_id, task, status, started_at, completed_at,
                        last_activity_at
                     ) VALUES
                       ('mira', 'Old', 'completed', ?, ?, ?),
                       ('mira', 'Current', 'active', ?, NULL, ?)`
                )
                .run(
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    currentTimestamp,
                    currentTimestamp
                );
            database
                .prepare(
                    `INSERT INTO reports (
                        type, title, body_md, created_at, updated_at, occurred_at
                     ) VALUES
                       ('test', 'Old', '', ?, ?, ?),
                       ('test', 'Current', '', ?, ?, ?)`
                )
                .run(
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    currentTimestamp,
                    currentTimestamp,
                    currentTimestamp
                );
            database
                .prepare(
                    `INSERT INTO docker_update_events (
                        event_type, created_at
                     ) VALUES ('old', ?), ('current', ?)`
                )
                .run(oldTimestamp, currentTimestamp);
            database
                .prepare(
                    `INSERT INTO job_workers (
                        id, capacity, started_at, heartbeat_at
                     ) VALUES
                       ('old-worker', 1, ?, ?),
                       ('current-worker', 1, ?, ?)`
                )
                .run(oldTimestamp, oldTimestamp, currentTimestamp, currentTimestamp);

            const changes = pruneDatabaseHistory(database, now);
            expect(changes).toMatchObject({
                agentTaskHistory: 1,
                authSessions: 1,
                deploymentJobs: 1,
                dockerUpdateEvents: 1,
                jobExecutions: 1,
                jobWorkers: 1,
                reports: 1,
                scheduledJobRuns: 1,
            });
            expect(
                database.query("SELECT id FROM auth_sessions ORDER BY id").all()
            ).toEqual([{ id: "current-session" }]);
            expect(
                database.query("SELECT id FROM job_executions ORDER BY id").all()
            ).toEqual([{ id: "current-execution" }]);
            expect(database.query("SELECT task FROM agent_task_history").all()).toEqual([
                { task: "Current" },
            ]);
        } finally {
            database.close();
        }
    });

    it("hardens the data directory and SQLite sidecar modes", () => {
        const root = temporaryRoot("mira-db-permissions-");
        const dataDirectory = path.join(root, "data");
        const databasePath = path.join(dataDirectory, "dashboard.db");
        mkdirSync(dataDirectory, { mode: 0o755 });
        writeFileSync(databasePath, "");
        chmodSync(databasePath, 0o644);

        prepareDatabaseStorage(databasePath);
        writeFileSync(`${databasePath}-wal`, "");
        writeFileSync(`${databasePath}-shm`, "");
        chmodSync(`${databasePath}-wal`, 0o644);
        chmodSync(`${databasePath}-shm`, 0o644);
        secureSqliteFilePermissions(databasePath);

        expect(mode(dataDirectory)).toBe(0o700);
        expect(mode(databasePath)).toBe(0o600);
        expect(mode(`${databasePath}-wal`)).toBe(0o600);
        expect(mode(`${databasePath}-shm`)).toBe(0o600);
    });
});
