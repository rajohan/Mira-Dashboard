import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../test/support/freshDatabase.ts";
import {
    applyVerifiedMigrations,
    maximumExpectedSchemaObjectCount,
} from "./applyVerifiedMigrations.ts";
import {
    loadVerifiedMigrations,
    type VerifiedMigration,
} from "./loadVerifiedMigrations.ts";

interface IntegrityRow {
    integrity_check: string;
}

interface TableListRow {
    name: string;
    strict: number;
    wr: number;
}

interface TextPrimaryKeyRow {
    notNull: number;
    tableName: string;
}

const expectedTables: string[] = [
    "agent_task_runs",
    "audit_events",
    "auth_challenges",
    "auth_pending_logins",
    "auth_rate_limit_buckets",
    "auth_sessions",
    "automation_credentials",
    "automation_principal_capabilities",
    "automation_principals",
    "cache_entries",
    "chat_run_events",
    "chat_runs",
    "chat_runtime_snapshots",
    "chat_transcript_generations",
    "host_restart_claim_fence",
    "incident_observations",
    "incidents",
    "job_disable_intents",
    "job_run_events",
    "job_runs",
    "job_worker_control",
    "monitor_runs",
    "notifications",
    "realtime_events",
    "reports",
    "resource_leases",
    "scheduled_jobs",
    "schema_migrations",
    "task_automation_profiles",
    "task_events",
    "task_labels",
    "task_notification_outbox",
    "task_updates",
    "tasks",
    "user_recovery_codes",
    "user_totp_factors",
    "user_webauthn_credentials",
    "users",
    "worker_instances",
];
describe("database migration graph", () => {
    test("bounds schema inventory by the largest valid prefix before later object drops", () => {
        const migrations = [
            {
                id: "20260806000000_schema-inventory-peak",
                migrationSha256: "0".repeat(64),
                snapshotSha256: "1".repeat(64),
                statements: [
                    "CREATE TABLE retained (id INTEGER PRIMARY KEY) STRICT",
                    "CREATE TABLE removed (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT",
                    "CREATE INDEX removed_value_index ON removed(value)",
                ],
            },
            {
                id: "20260806000001_drop-schema-objects",
                migrationSha256: "2".repeat(64),
                snapshotSha256: "3".repeat(64),
                statements: ["DROP TABLE removed"],
            },
        ] satisfies readonly VerifiedMigration[];

        expect(maximumExpectedSchemaObjectCount(migrations)).toBe(3);
    });

    test("contains one reviewed baseline applicable to an empty database", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const foundationMigration = migrations[0];
        if (!foundationMigration) {
            throw new Error("Expected one fresh-database foundation migration");
        }

        expect(migrations).toHaveLength(1);
        expect(foundationMigration.id).toEndWith("_dashboard-foundation");
        expect(foundationMigration.migrationSha256).toMatch(/^[a-f\d]{64}$/u);
        expect(foundationMigration.snapshotSha256).toMatch(/^[a-f\d]{64}$/u);
        const foundationSql = foundationMigration.statements.join("\n");
        expect(foundationSql).toContain(") STRICT, WITHOUT ROWID;");
        for (const trigger of [
            "audit_events_validate_metadata",
            "audit_events_reject_replace",
            "audit_events_reject_update",
            "audit_events_reject_delete",
            "automation_credentials_validate_replacement_insert",
            "automation_credentials_validate_replacement_update",
            "automation_credentials_validate_predecessor_update",
            "chat_run_events_reject_delete",
            "chat_run_events_reject_replace",
            "chat_run_events_reject_update",
            "chat_runs_reject_identity_update",
            "chat_runs_reject_replace",
            "chat_runs_reject_settled_identity_update",
            "chat_runs_validate_monotonic_update",
            "chat_runtime_snapshots_reject_delete",
            "chat_runtime_snapshots_reject_identity_update",
            "chat_runtime_snapshots_reject_replace",
            "chat_runtime_snapshots_validate_progress_update",
            "chat_transcript_generations_reject_delete",
            "chat_transcript_generations_reject_identity_update",
            "chat_transcript_generations_reject_replace",
            "chat_transcript_generations_validate_monotonic_update",
            "host_restart_claim_fence_reject_update",
            "host_restart_claim_fence_validate_insert",
            "reports_validate_metadata_insert",
            "reports_validate_metadata_update",
            "incidents_validate_details_insert",
            "incidents_validate_details_update",
            "incident_observations_validate_details_insert",
            "incident_observations_validate_details_update",
            "job_disable_intents_reject_closed_update",
            "job_disable_intents_reject_content_update",
            "job_disable_intents_reject_delete",
            "job_disable_intents_reject_replace",
            "job_run_events_reject_delete",
            "job_run_events_reject_replace",
            "job_run_events_reject_update",
            "job_run_events_update_parent_counters",
            "job_run_events_validate_insert",
            "job_runs_reject_delete",
            "job_runs_reject_replace",
            "job_runs_reject_snapshot_update",
            "job_runs_validate_lifecycle_update",
            "job_runs_validate_resource_keys_insert",
            "job_worker_control_reject_delete",
            "job_worker_control_reject_replace",
            "job_worker_control_validate_update",
            "resource_leases_reject_identity_update",
            "resource_leases_validate_insert",
            "resource_leases_validate_renewal_update",
            "schema_migrations_reject_replace",
            "schema_migrations_reject_update",
            "schema_migrations_reject_delete",
            "scheduled_jobs_reject_delete",
            "scheduled_jobs_reject_identity_update",
            "scheduled_jobs_reject_replace",
            "scheduled_jobs_validate_resource_keys_insert",
            "scheduled_jobs_validate_resource_keys_update",
            "scheduled_jobs_validate_version_update",
            "task_events_validate_payload",
            "task_events_reject_replace",
            "task_events_reject_update",
            "task_events_reject_delete",
            "worker_instances_reject_active_delete",
            "worker_instances_reject_identity_update",
            "worker_instances_reject_replace",
            "worker_instances_validate_action_keys_insert",
            "worker_instances_validate_lifecycle_update",
        ]) {
            expect(foundationSql).toContain(`CREATE TRIGGER ${trigger}`);
        }
        expect(foundationSql).toContain(
            'CONSTRAINT "incidents_fingerprint_check" CHECK(length("fingerprint") = 64 AND instr("fingerprint", char(0)) = 0'
        );
        expect(foundationSql).toContain(
            'CONSTRAINT "monitor_runs_submission_sha256_check" CHECK(length("submission_sha256") = 64 AND instr("submission_sha256", char(0)) = 0'
        );
        expect(foundationSql).toContain(
            'CONSTRAINT "worker_instances_action_keys_json_check" CHECK(length(CAST("action_keys_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("action_keys_json") THEN json_type("action_keys_json") = \'array\' ELSE 0 END AND CASE WHEN json_valid("action_keys_json") THEN json_array_length("action_keys_json") <= 32 ELSE 0 END)'
        );
        expect(foundationSql).not.toContain("legacy");
        expect(foundationSql).not.toContain("SET fingerprint = fingerprint");
        expect(foundationSql).not.toContain("SET submission_sha256 = submission_sha256");

        const database = await openFreshMigratedDatabase();

        try {
            const tableDefinitions = database.sqlite
                .query<TableListRow, []>(`
                    SELECT name, strict, wr
                    FROM pragma_table_list
                    WHERE schema = 'main'
                      AND type = 'table'
                      AND name NOT GLOB 'sqlite_*'
                    ORDER BY name
                `)
                .all();
            const tables = tableDefinitions.map((row) => row.name);

            expect(tables).toEqual(expectedTables);
            expect(tableDefinitions.every((row) => row.strict === 1)).toBeTrue();
            expect(tableDefinitions.find((row) => row.name === "audit_events")?.wr).toBe(
                1
            );
            expect(tableDefinitions.find((row) => row.name === "task_events")?.wr).toBe(
                1
            );
            expect(
                tableDefinitions.find((row) => row.name === "task_notification_outbox")
                    ?.wr
            ).toBe(1);
            for (const tableName of [
                "cache_entries",
                "host_restart_claim_fence",
                "job_disable_intents",
                "job_run_events",
                "job_runs",
                "resource_leases",
                "scheduled_jobs",
                "worker_instances",
            ]) {
                expect(tableDefinitions.find((row) => row.name === tableName)?.wr).toBe(
                    1
                );
            }
            const textPrimaryKeys = database.sqlite
                .query<TextPrimaryKeyRow, []>(`
                    SELECT
                        p."notnull" AS "notNull",
                        tables.name AS "tableName"
                    FROM sqlite_schema AS tables
                    JOIN pragma_table_info(tables.name) AS p
                    WHERE tables.type = 'table'
                      AND p.pk > 0
                      AND upper(p.type) = 'TEXT'
                `)
                .all();
            expect(textPrimaryKeys.length).toBeGreaterThan(0);
            expect(textPrimaryKeys.every((row) => row.notNull === 1)).toBeTrue();
            expect(
                database.sqlite
                    .query<{ checksum: string; id: string; release_id: string }, []>(`
                        SELECT checksum, id, release_id
                        FROM schema_migrations
                        ORDER BY id
                    `)
                    .all()
            ).toEqual([
                {
                    checksum: foundationMigration.migrationSha256,
                    id: foundationMigration.id,
                    release_id: "0".repeat(40),
                },
            ]);
            expect(
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toBe(0);
            expect(
                database.sqlite.query<IntegrityRow, []>("PRAGMA integrity_check").get()
            ).toEqual({ integrity_check: "ok" });
            expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects checksum drift in applied migration history", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run("DROP TRIGGER schema_migrations_reject_update");
            database.sqlite.run("UPDATE schema_migrations SET checksum = ?", [
                "f".repeat(64),
            ]);

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database migration history does not match the reviewed manifest");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects malformed raw migration history rows", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            database.run("PRAGMA foreign_keys = ON");
            database.run(
                "CREATE TABLE schema_migrations (applied_at, checksum, id, release_id)"
            );
            database.run(
                "INSERT INTO schema_migrations (applied_at, checksum, id, release_id) VALUES (0, 1, 2, 3)"
            );

            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database migration history does not match the reviewed manifest");
        } finally {
            database.close(true);
        }
    });

    test("rejects a malformed release id before changing the database", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "A".repeat(40),
                })
            ).toThrow("Migration release id must be a full lowercase commit SHA");
            expect(
                database
                    .query<{ name: string }, []>(`
                        SELECT name
                        FROM sqlite_schema
                        WHERE name NOT GLOB 'sqlite_*'
                    `)
                    .all()
            ).toEqual([]);
        } finally {
            database.close(true);
        }
    });

    test("rejects an initialized database with deleted migration history", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run("DROP TRIGGER schema_migrations_reject_delete");
            database.sqlite.run("DELETE FROM schema_migrations");

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Initialized database has empty migration history");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects schema drift after reviewed migration history exists", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run("CREATE TABLE unreviewed_table (id INTEGER) STRICT");

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database schema does not match reviewed migration history");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("requires foreign key enforcement before applying migrations", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database foreign key enforcement must be enabled");
            expect(
                database
                    .query<{ name: string }, []>(`
                        SELECT name
                        FROM sqlite_schema
                        WHERE name NOT GLOB 'sqlite_*'
                    `)
                    .all()
            ).toEqual([]);
        } finally {
            database.close(true);
        }
    });

    test("requires check constraint enforcement before applying migrations", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            database.run("PRAGMA foreign_keys = ON");
            database.run("PRAGMA ignore_check_constraints = ON");

            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database check constraint enforcement must be enabled");
            expect(
                database
                    .query<{ name: string }, []>(`
                        SELECT name
                        FROM sqlite_schema
                        WHERE name NOT GLOB 'sqlite_*'
                    `)
                    .all()
            ).toEqual([]);
        } finally {
            database.close(true);
        }
    });

    test("rejects stored foreign key violations", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run("PRAGMA foreign_keys = OFF");
            database.sqlite.run(`
                INSERT INTO incident_observations (
                    generation,
                    incident_id,
                    kind,
                    monitor_run_id,
                    observed_at,
                    severity,
                    title
                ) VALUES (1, 'missing-incident', 'system', 'missing-run', 1, 'warning', 'Missing')
            `);
            database.sqlite.run("PRAGMA foreign_keys = ON");

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database foreign key integrity check failed");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects stored check constraint violations", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run("PRAGMA ignore_check_constraints = ON");
            database.sqlite.run(`
                INSERT INTO incidents (
                    fingerprint,
                    first_seen_at,
                    id,
                    kind,
                    last_seen_at,
                    monitor_key,
                    occurrence_count,
                    severity,
                    state,
                    title
                ) VALUES (
                    'fingerprint',
                    1,
                    'invalid-incident',
                    'test',
                    1,
                    'monitor',
                    0,
                    'error',
                    'active',
                    'Invalid incident'
                )
            `);
            database.sqlite.run("PRAGMA ignore_check_constraints = OFF");

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database integrity check failed");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects statement drift before changing an empty database", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const migration = migrations[0];
        if (!migration) {
            throw new Error(
                "Expected the database migration graph to contain a foundation node"
            );
        }

        const database = new Database(":memory:", { strict: true });
        try {
            expect(() =>
                applyVerifiedMigrations(
                    database,
                    migrations.map((candidate) =>
                        candidate === migration
                            ? {
                                  ...candidate,
                                  statements: [
                                      ...candidate.statements,
                                      "CREATE TABLE unreviewed_table (id INTEGER)",
                                  ],
                              }
                            : candidate
                    ),
                    { releaseId: "1".repeat(40) }
                )
            ).toThrow("Verified migration graph does not match the reviewed manifest");
            expect(
                database
                    .query<{ name: string }, []>(`
                        SELECT name
                        FROM sqlite_schema
                        WHERE type = 'table'
                          AND name NOT GLOB 'sqlite_*'
                    `)
                    .all()
            ).toEqual([]);
        } finally {
            database.close(true);
        }
    });

    test("rolls back canonical DDL when SQLite rejects a later statement", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            database.run("PRAGMA foreign_keys = ON");
            database.run("PRAGMA max_page_count = 3");

            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("database or disk is full");
            expect(
                database
                    .query<{ name: string }, []>(`
                        SELECT name
                        FROM sqlite_schema
                        WHERE name NOT GLOB 'sqlite_*'
                    `)
                    .all()
            ).toEqual([]);
        } finally {
            database.close(true);
        }
    });

    test("does not treat an untracked schema object as an empty database", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const database = new Database(":memory:", { strict: true });

        try {
            database.run("PRAGMA foreign_keys = ON");
            database.run("CREATE VIEW sqliteXuntracked AS SELECT 1 AS value");

            expect(() =>
                applyVerifiedMigrations(database, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Initialized database is missing migration history");
        } finally {
            database.close(true);
        }
    });
});
