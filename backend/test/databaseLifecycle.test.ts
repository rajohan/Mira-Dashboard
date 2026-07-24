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
    migrateDisposableDatabaseCopy,
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

            expect(first.applied).toEqual([1, 2, 3, 4, 5]);
            expect(first.backup).toBeUndefined();
            expect(second).toEqual({ applied: [] });
            expect(validateDatabaseMigrationHistory(database)).toBe(5);
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
                               'idx_chat_runtime_snapshots_retention',
                               'idx_notifications_read_retention',
                               'idx_notifications_report_id',
                               'idx_reports_retention',
                               'idx_task_updates_task_created'
                           )
                         ORDER BY name`
                    )
                    .all()
            ).toEqual([
                { name: "idx_agent_task_history_retention" },
                { name: "idx_chat_runtime_snapshots_retention" },
                { name: "idx_deployment_jobs_retention" },
                { name: "idx_docker_update_events_retention" },
                { name: "idx_notifications_read_retention" },
                { name: "idx_notifications_report_id" },
                { name: "idx_reports_retention" },
                { name: "idx_task_updates_task_created" },
            ]);

            const retentionQueryPlans = [
                {
                    index: "idx_deployment_jobs_retention",
                    usage: "USING COVERING INDEX",
                    sql: `SELECT id
                          FROM deployment_jobs
                          WHERE status NOT IN ('building', 'restart-scheduled')
                          ORDER BY started_at DESC, id DESC
                          LIMIT -1 OFFSET 500`,
                },
                {
                    index: "idx_agent_task_history_retention",
                    usage: "USING COVERING INDEX",
                    sql: `SELECT id
                          FROM agent_task_history
                          WHERE status != 'active' AND completed_at IS NOT NULL
                          ORDER BY completed_at DESC, id DESC
                          LIMIT -1 OFFSET 10000`,
                },
                {
                    index: "idx_reports_retention",
                    usage: "USING COVERING INDEX",
                    sql: `SELECT id
                          FROM reports
                          ORDER BY occurred_at DESC, id DESC
                          LIMIT -1 OFFSET 5000`,
                },
                {
                    index: "idx_docker_update_events_retention",
                    usage: "USING COVERING INDEX",
                    sql: `SELECT id
                          FROM docker_update_events
                          ORDER BY created_at DESC, id DESC
                          LIMIT -1 OFFSET 5000`,
                },
                {
                    index: "idx_chat_runtime_snapshots_retention",
                    usage: "USING INDEX",
                    sql: `SELECT gateway_scope, session_key
                          FROM chat_runtime_snapshots
                          ORDER BY updated_at DESC,
                                   rowid DESC
                          LIMIT -1 OFFSET 200`,
                },
                {
                    index: "idx_notifications_read_retention",
                    usage: "USING COVERING INDEX",
                    sql: `SELECT id
                          FROM notifications
                          WHERE is_read = 1
                          ORDER BY COALESCE(
                                       datetime(occurred_at),
                                       datetime(created_at)
                                   ) DESC,
                                   id DESC
                          LIMIT -1 OFFSET 300`,
                },
            ];
            for (const { index, sql, usage } of retentionQueryPlans) {
                const plan = database.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
                    detail: string;
                }>;
                expect(plan.map((row) => row.detail).join("\n")).toContain(
                    `${usage} ${index}`
                );
            }
            const notificationPlan = database
                .query(
                    `EXPLAIN QUERY PLAN
                     SELECT id
                     FROM notifications
                     WHERE json_extract(metadata_json, '$.reportId') = 1`
                )
                .all() as Array<{ detail: string }>;
            expect(notificationPlan.map((row) => row.detail).join("\n")).toContain(
                "USING COVERING INDEX idx_notifications_report_id"
            );
            expect(
                database
                    .query(
                        `SELECT name
                         FROM sqlite_schema
                         WHERE type = 'trigger' AND tbl_name = 'audit_events'
                         ORDER BY name`
                    )
                    .all()
            ).toEqual([
                { name: "audit_events_reject_delete" },
                { name: "audit_events_reject_update" },
            ]);
            expect(existsSync(sqliteBackupDirectory(databasePath))).toBe(false);
        } finally {
            database.close();
        }
    });

    it("upgrades an existing version 3 database with migrations 4 and 5", () => {
        const root = temporaryRoot("mira-db-migrations-v3-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            applyDatabaseMigrations(database, databasePath);
            database.run("DROP INDEX idx_notifications_read_retention");
            database.run("DROP INDEX idx_chat_runtime_snapshots_retention");
            database.run("DROP TABLE audit_events");
            database.run("CREATE INDEX idx_notifications_read ON notifications(is_read)");
            database.prepare("DELETE FROM schema_migrations WHERE version >= 4").run();

            expect(validateDatabaseMigrationHistory(database)).toBe(3);
            expect(migrateDisposableDatabaseCopy(database)).toEqual({
                applied: [4, 5],
            });
            expect(validateDatabaseMigrationHistory(database)).toBe(5);
            expect(
                database
                    .query(
                        `SELECT name
                         FROM sqlite_schema
                         WHERE type = 'index'
                           AND name IN (
                               'idx_chat_runtime_snapshots_retention',
                               'idx_notifications_read_retention'
                           )
                         ORDER BY name`
                    )
                    .all()
            ).toEqual([
                { name: "idx_chat_runtime_snapshots_retention" },
                { name: "idx_notifications_read_retention" },
            ]);
            expect(
                database
                    .query(
                        `SELECT name
                         FROM sqlite_schema
                         WHERE type = 'table' AND name = 'audit_events'`
                    )
                    .get()
            ).toEqual({ name: "audit_events" });
        } finally {
            database.close();
        }
    });

    it("upgrades an existing version 4 database with only migration 5", () => {
        const root = temporaryRoot("mira-db-migrations-v4-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        try {
            applyDatabaseMigrations(database, databasePath);
            database.run("DROP TABLE audit_events");
            database.prepare("DELETE FROM schema_migrations WHERE version = 5").run();

            expect(validateDatabaseMigrationHistory(database)).toBe(4);
            expect(migrateDisposableDatabaseCopy(database)).toEqual({ applied: [5] });
            expect(validateDatabaseMigrationHistory(database)).toBe(5);
            expect(
                database
                    .query(
                        `SELECT name
                         FROM sqlite_schema
                         WHERE type = 'index'
                           AND name IN (
                               'idx_audit_events_occurred',
                               'idx_audit_events_request',
                               'idx_audit_events_target'
                           )
                         ORDER BY name`
                    )
                    .all()
            ).toEqual([
                { name: "idx_audit_events_occurred" },
                { name: "idx_audit_events_request" },
                { name: "idx_audit_events_target" },
            ]);
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
            ).toEqual({ count: 5 });
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
            expect(result.applied).toEqual([1, 2, 3, 4, 5]);
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
                     ) VALUES (6, 'unknown', 'unknown', ?)`
                )
                .run("2026-07-23T00:00:00.000Z");
            expect(() => validateDatabaseMigrationHistory(database)).toThrow(
                "unknown SQLite migration version 6"
            );

            database.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
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

    it("tests pending migrations on a deploy copy without mutating live data", async () => {
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
        const preflightResult = JSON.parse(stdout) as {
            backup: { kind: string; path: string; restoreVerified: boolean };
            migrationTest: { applied: number[]; currentVersion: number };
        };
        expect(preflightResult).toMatchObject({
            backup: { kind: "pre-deploy", restoreVerified: true },
            migrationTest: { applied: [1, 2, 3, 4, 5], currentVersion: 5 },
        });
        expect(getSqliteBackupInventory(databasePath).count).toBe(1);
        const unchangedBackup = new Database(preflightResult.backup.path, {
            readonly: true,
        });
        try {
            expect(
                unchangedBackup
                    .query(
                        `SELECT 1
                         FROM sqlite_schema
                         WHERE type = 'table' AND name = 'schema_migrations'`
                    )
                    .get()
            ).toBeNull();
        } finally {
            unchangedBackup.close();
        }
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
                    `INSERT INTO tasks (
                        title, body, status, priority, labels_json,
                        automation_json, created_at, updated_at
                     ) VALUES
                       ('Done retention task', '', 'done', 'medium', '[]', '{}', ?, ?),
                       ('Active retention task', '', 'in-progress', 'medium', '[]', '{}', ?, ?),
                       ('Capped retention task', '', 'in-progress', 'medium', '[]', '{}', ?, ?)`
                )
                .run(
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    currentTimestamp,
                    currentTimestamp,
                    currentTimestamp
                );
            const taskIds = database
                .query("SELECT id, title FROM tasks ORDER BY id")
                .all() as Array<{ id: number; title: string }>;
            const doneTaskId = taskIds.find(
                (task) => task.title === "Done retention task"
            )?.id;
            const activeTaskId = taskIds.find(
                (task) => task.title === "Active retention task"
            )?.id;
            const cappedTaskId = taskIds.find(
                (task) => task.title === "Capped retention task"
            )?.id;
            if (!doneTaskId || !activeTaskId || !cappedTaskId) {
                throw new Error("Retention task fixtures were not created");
            }
            database
                .prepare(
                    `INSERT INTO task_events (
                        task_id, event_type, payload_json, created_at
                     ) VALUES
                       (?, 'done-old', '{}', ?),
                       (?, 'done-current', '{}', ?),
                       (?, 'active-old', '{}', ?)`
                )
                .run(
                    doneTaskId,
                    oldTimestamp,
                    doneTaskId,
                    currentTimestamp,
                    activeTaskId,
                    oldTimestamp
                );
            database
                .prepare(
                    `INSERT INTO task_updates (
                        task_id, author, message_md, created_at
                     ) VALUES
                       (?, 'mira-2026', 'done-old', ?),
                       (?, 'mira-2026', 'done-current', ?),
                       (?, 'mira-2026', 'active-old', ?)`
                )
                .run(
                    doneTaskId,
                    oldTimestamp,
                    doneTaskId,
                    currentTimestamp,
                    activeTaskId,
                    oldTimestamp
                );
            database
                .prepare(
                    `WITH RECURSIVE sequence(value) AS (
                         SELECT 1
                         UNION ALL
                         SELECT value + 1 FROM sequence WHERE value < 5001
                     )
                     INSERT INTO task_events (
                         task_id, event_type, payload_json, created_at
                     )
                     SELECT ?, 'capped', '{}', ? FROM sequence`
                )
                .run(cappedTaskId, currentTimestamp);
            database
                .prepare(
                    `WITH RECURSIVE sequence(value) AS (
                         SELECT 1
                         UNION ALL
                         SELECT value + 1 FROM sequence WHERE value < 5001
                     )
                     INSERT INTO task_updates (
                         task_id, author, message_md, created_at
                     )
                     SELECT ?, 'mira-2026', 'capped', ? FROM sequence`
                )
                .run(cappedTaskId, currentTimestamp);
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
            const reportIds = database
                .query("SELECT id, title FROM reports ORDER BY id")
                .all() as Array<{ id: number; title: string }>;
            const oldReportId = reportIds.find((report) => report.title === "Old")?.id;
            const currentReportId = reportIds.find(
                (report) => report.title === "Current"
            )?.id;
            if (!oldReportId || !currentReportId) {
                throw new Error("Retention report fixtures were not created");
            }
            database
                .prepare(
                    `INSERT INTO notifications (
                        title, description, type, source, dedupe_key,
                        metadata_json, is_read, created_at, updated_at, occurred_at
                     ) VALUES
                       ('Old report notification', '', 'info', 'reports',
                        'retention-report-old', ?, 0, ?, ?, ?),
                       ('Current report notification', '', 'info', 'reports',
                        'retention-report-current', ?, 0, ?, ?, ?),
                       ('Unrelated notification', '', 'info', 'reports',
                        'retention-report-unrelated', '{"reportId":999999}',
                        0, ?, ?, ?)`
                )
                .run(
                    JSON.stringify({ reportId: oldReportId }),
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    JSON.stringify({ reportId: currentReportId }),
                    currentTimestamp,
                    currentTimestamp,
                    currentTimestamp,
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
                .run(oldTimestamp, oldTimestamp, now.toISOString(), now.toISOString());

            const changes = pruneDatabaseHistory(database, now);
            expect(changes).toMatchObject({
                agentTaskHistory: 1,
                authSessions: 1,
                deploymentJobs: 1,
                dockerUpdateEvents: 1,
                jobExecutions: 1,
                jobWorkers: 1,
                notifications: 1,
                reports: 1,
                scheduledJobRuns: 1,
                tasks: 1,
                taskEvents: 3,
                taskUpdates: 3,
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
            expect(
                database.query("SELECT title FROM notifications ORDER BY title").all()
            ).toEqual([
                { title: "Current report notification" },
                { title: "Unrelated notification" },
            ]);
            expect(
                database.query("SELECT title FROM tasks ORDER BY title").all()
            ).toEqual([
                { title: "Active retention task" },
                { title: "Capped retention task" },
            ]);
            expect(
                database
                    .prepare(
                        `SELECT event_type
                         FROM task_events
                         WHERE task_id IN (?, ?)
                         ORDER BY event_type`
                    )
                    .all(doneTaskId, activeTaskId)
            ).toEqual([{ event_type: "active-old" }]);
            expect(
                database
                    .prepare(
                        `SELECT message_md
                         FROM task_updates
                         WHERE task_id IN (?, ?)
                         ORDER BY message_md`
                    )
                    .all(doneTaskId, activeTaskId)
            ).toEqual([{ message_md: "active-old" }]);
            expect(
                database
                    .prepare(
                        `SELECT
                             (SELECT COUNT(*) FROM task_events WHERE task_id = ?) AS events,
                             (SELECT COUNT(*) FROM task_updates WHERE task_id = ?) AS updates`
                    )
                    .get(cappedTaskId, cappedTaskId)
            ).toEqual({ events: 5000, updates: 5000 });
        } finally {
            database.close();
        }
    });

    it("bounds read notifications while preserving every unread notification", () => {
        const root = temporaryRoot("mira-db-notification-retention-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        const oldTimestamp = "2026-06-01T00:00:00.000Z";
        const baselineTimestamp = "2026-07-23T00:00:00.000Z";
        const offsetNewerTimestamp = "2026-07-23T00:30:00.000-05:00";
        const utcOlderTimestamp = "2026-07-23T01:00:00.000Z";
        const veryNewTimestamp = "2026-07-23T06:00:00.000Z";
        const now = new Date("2026-07-23T12:00:00.000Z");
        try {
            applyDatabaseMigrations(database, databasePath);
            database
                .prepare(
                    `INSERT INTO notifications (
                         title, description, type, source, dedupe_key,
                         metadata_json, is_read, created_at, updated_at, occurred_at
                     ) VALUES
                       ('Expired read', '', 'info', 'retention',
                        'expired-read', '{}', 1, ?, ?, ?),
                       ('Expired unread', '', 'info', 'retention',
                        'expired-unread', '{}', 0, ?, ?, ?),
                       ('Baseline read', '', 'info', 'retention',
                        'baseline-read', '{}', 1, ?, ?, ?),
                       ('Offset newer read', '', 'info', 'retention',
                        'offset-newer-read', '{}', 1, ?, ?, ?),
                       ('UTC older read', '', 'info', 'retention',
                        'utc-older-read', '{}', 1, ?, ?, ?)`
                )
                .run(
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    oldTimestamp,
                    baselineTimestamp,
                    baselineTimestamp,
                    baselineTimestamp,
                    offsetNewerTimestamp,
                    offsetNewerTimestamp,
                    offsetNewerTimestamp,
                    utcOlderTimestamp,
                    utcOlderTimestamp,
                    utcOlderTimestamp
                );
            database
                .prepare(
                    `WITH RECURSIVE sequence(value) AS (
                         SELECT 1
                         UNION ALL
                         SELECT value + 1 FROM sequence WHERE value < 299
                     )
                     INSERT INTO notifications (
                         title, description, type, source, dedupe_key,
                         metadata_json, is_read, created_at, updated_at, occurred_at
                     )
                     SELECT 'Current read ' || value,
                            '',
                            'info',
                            'retention',
                            'current-read-' || value,
                            '{}',
                            1,
                            ?,
                            ?,
                            ?
                     FROM sequence`
                )
                .run(veryNewTimestamp, veryNewTimestamp, veryNewTimestamp);

            const changes = pruneDatabaseHistory(database, now);

            expect(changes.notifications).toBe(3);
            expect(
                database
                    .query(
                        `SELECT is_read, COUNT(*) AS count
                         FROM notifications
                         GROUP BY is_read
                         ORDER BY is_read`
                    )
                    .all()
            ).toEqual([
                { count: 1, is_read: 0 },
                { count: 300, is_read: 1 },
            ]);
            expect(
                database
                    .query(
                        "SELECT title FROM notifications WHERE dedupe_key = 'expired-unread'"
                    )
                    .get()
            ).toEqual({ title: "Expired unread" });
            expect(
                database
                    .query(
                        `SELECT dedupe_key
                         FROM notifications
                         WHERE dedupe_key IN (
                             'baseline-read',
                             'offset-newer-read',
                             'utc-older-read'
                         )
                         ORDER BY dedupe_key`
                    )
                    .all()
            ).toEqual([{ dedupe_key: "offset-newer-read" }]);
        } finally {
            database.close();
        }
    });

    it("removes orphaned, expired, and beyond-cap chat runtime snapshots", () => {
        const root = temporaryRoot("mira-db-chat-snapshot-retention-");
        const databasePath = path.join(root, "dashboard.db");
        const database = openWalDatabase(databasePath);
        const now = new Date("2026-07-23T12:00:00.000Z");
        try {
            applyDatabaseMigrations(database, databasePath);
            database
                .prepare(
                    `INSERT INTO chat_runtime_snapshots (
                         gateway_scope, session_key, snapshot_json, updated_at
                     ) VALUES ('scope', 'expired', '{}', ?)`
                )
                .run("2026-05-01T00:00:00.000Z");
            database
                .prepare(
                    `INSERT INTO chat_runtime_snapshot_events (
                         gateway_scope, session_key, runtime_sequence, envelope_json
                     ) VALUES
                       ('scope', 'expired', 1, '{}'),
                       ('scope', 'orphan', 1, '{}')`
                )
                .run();
            const insertSnapshot = database.prepare(
                `INSERT INTO chat_runtime_snapshots (
                     gateway_scope, session_key, snapshot_json, updated_at
                 ) VALUES (?, ?, '{}', ?)`
            );
            const insertEvent = database.prepare(
                `INSERT INTO chat_runtime_snapshot_events (
                     gateway_scope, session_key, runtime_sequence, envelope_json
                 ) VALUES (?, ?, 1, '{}')`
            );
            const currentTimestamp = "2026-07-01T00:00:00.000Z";
            for (let index = 0; index < 201; index += 1) {
                const sessionKey = `session-${String(index).padStart(3, "0")}`;
                insertSnapshot.run("scope", sessionKey, currentTimestamp);
                insertEvent.run("scope", sessionKey);
            }
            database
                .prepare(
                    `DELETE FROM chat_runtime_snapshots
                     WHERE gateway_scope = 'scope' AND session_key = 'session-000'`
                )
                .run();
            insertSnapshot.run("scope", "session-000", currentTimestamp);

            const changes = pruneDatabaseHistory(database, now);

            expect(changes.chatRuntimeSnapshotEvents).toBe(3);
            expect(changes.chatRuntimeSnapshots).toBe(2);
            expect(
                database
                    .query("SELECT COUNT(*) AS count FROM chat_runtime_snapshots")
                    .get()
            ).toEqual({ count: 200 });
            expect(
                database
                    .query("SELECT COUNT(*) AS count FROM chat_runtime_snapshot_events")
                    .get()
            ).toEqual({ count: 200 });
            expect(
                database
                    .query(
                        `SELECT session_key
                         FROM chat_runtime_snapshots
                         WHERE session_key IN (
                             'expired',
                             'session-000',
                             'session-001',
                             'session-200'
                         )
                         ORDER BY session_key`
                    )
                    .all()
            ).toEqual([{ session_key: "session-000" }, { session_key: "session-200" }]);
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
