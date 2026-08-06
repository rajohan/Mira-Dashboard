import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../test/support/freshDatabase.ts";
import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

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
    "audit_events",
    "auth_challenges",
    "auth_pending_logins",
    "auth_rate_limit_buckets",
    "auth_sessions",
    "automation_credentials",
    "automation_principal_capabilities",
    "automation_principals",
    "incident_observations",
    "incidents",
    "monitor_runs",
    "notifications",
    "realtime_events",
    "reports",
    "schema_migrations",
    "user_recovery_codes",
    "user_totp_factors",
    "user_webauthn_credentials",
    "users",
];
describe("database migration graph", () => {
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
            "reports_validate_metadata_insert",
            "reports_validate_metadata_update",
            "incidents_validate_details_insert",
            "incidents_validate_details_update",
            "incident_observations_validate_details_insert",
            "incident_observations_validate_details_update",
        ]) {
            expect(foundationSql).toContain(`CREATE TRIGGER ${trigger}`);
        }
        expect(foundationSql).toContain(
            'CONSTRAINT "incidents_fingerprint_check" CHECK(length("fingerprint") = 64 AND instr("fingerprint", char(0)) = 0'
        );
        expect(foundationSql).toContain(
            'CONSTRAINT "monitor_runs_submission_sha256_check" CHECK(length("submission_sha256") = 64 AND instr("submission_sha256", char(0)) = 0'
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
