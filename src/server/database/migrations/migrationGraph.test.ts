import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "./freshDatabaseFixture.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

interface IntegrityRow {
    integrity_check: string;
}

interface SchemaObjectRow {
    name: string;
    sql: string;
}

const expectedTables: string[] = [
    "incident_observations",
    "incidents",
    "monitor_runs",
    "notifications",
    "realtime_events",
    "reports",
    "schema_migrations",
];

describe("database migration graph", () => {
    test("is immutable, ordered, and applicable to an empty database", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const foundationMigration = migrations[0];
        if (!foundationMigration) {
            throw new Error("Expected the database migration graph to contain one node");
        }

        expect(migrations).toHaveLength(1);
        expect(foundationMigration.id).toEndWith("_dashboard-foundation");
        expect(foundationMigration.migrationSha256).toMatch(/^[a-f\d]{64}$/u);

        const database = await openFreshMigratedDatabase();

        try {
            const tableDefinitions = database.sqlite
                .query<SchemaObjectRow, []>(`
                    SELECT name, sql
                    FROM sqlite_schema
                    WHERE type = 'table'
                      AND name NOT GLOB 'sqlite_*'
                    ORDER BY name
                `)
                .all();
            const tables = tableDefinitions.map((row) => row.name);

            expect(tables).toEqual(expectedTables);
            expect(
                tableDefinitions.every((row) => row.sql.trimEnd().endsWith("STRICT"))
            ).toBeTrue();
            expect(
                database.sqlite
                    .query<{ checksum: string; id: string; release_id: string }, []>(`
                        SELECT checksum, id, release_id
                        FROM schema_migrations
                    `)
                    .get()
            ).toEqual({
                checksum: foundationMigration.migrationSha256,
                id: foundationMigration.id,
                release_id: "0".repeat(40),
            });
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
                    monitor_run_id,
                    observed_at
                ) VALUES (1, 'missing-incident', 'missing-run', 1)
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
            throw new Error("Expected the database migration graph to contain one node");
        }

        const database = new Database(":memory:", { strict: true });
        try {
            expect(() =>
                applyVerifiedMigrations(
                    database,
                    [
                        {
                            ...migration,
                            statements: [
                                ...migration.statements,
                                "CREATE TABLE unreviewed_table (id INTEGER)",
                            ],
                        },
                    ],
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
