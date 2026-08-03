import { describe, expect, test } from "bun:test";

import { readMigrationFiles } from "drizzle-orm/migrator";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "./freshDatabaseFixture.ts";

interface IntegrityRow {
    integrity_check: string;
}

interface SchemaObjectRow {
    name: string;
    sql: string;
}

const expectedTables: string[] = [
    "__drizzle_migrations",
    "incident_observations",
    "incidents",
    "monitor_runs",
    "notifications",
    "realtime_events",
    "reports",
    "schema_migrations",
];

describe("greenfield migration graph", () => {
    test("is immutable, ordered, and applicable to an empty database", () => {
        const migrations = readMigrationFiles({ migrationsFolder: migrationsDirectory });

        expect(migrations).toHaveLength(1);
        expect(migrations[0]?.name).toEndWith("_greenfield-foundation");
        expect(migrations[0]?.hash).toMatch(/^[a-f\d]{64}$/u);

        const database = openFreshMigratedDatabase();

        try {
            const tableDefinitions = database.sqlite
                .query<SchemaObjectRow, []>(`
                    SELECT name, sql
                    FROM sqlite_schema
                    WHERE type = 'table'
                      AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                `)
                .all();
            const tables = tableDefinitions.map((row) => row.name);
            const domainTableDefinitions = tableDefinitions.filter(
                (row) => row.name !== "__drizzle_migrations"
            );

            expect(tables).toEqual(expectedTables);
            expect(
                domainTableDefinitions.every((row) =>
                    row.sql.trimEnd().endsWith("STRICT")
                )
            ).toBeTrue();
            expect(
                database.sqlite.query<IntegrityRow, []>("PRAGMA integrity_check").get()
            ).toEqual({ integrity_check: "ok" });
            expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            database.sqlite.close(true);
        }
    });
});
