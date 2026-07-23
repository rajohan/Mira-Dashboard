import { type Database } from "bun:sqlite";

import {
    type DatabaseMigration,
    databaseMigrations,
} from "./databaseMigrations/index.ts";
import {
    createVerifiedSqliteBackup,
    pruneSqliteBackups,
    type SqliteBackupResult,
} from "./sqliteBackup.ts";

interface AppliedMigrationRow {
    applied_at: string;
    checksum: string;
    name: string;
    version: number;
}

export interface DatabaseMigrationResult {
    applied: number[];
    backup?: SqliteBackupResult;
}

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT
`;

function migrationChecksum(migration: DatabaseMigration): string {
    return new Bun.CryptoHasher("sha256")
        .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
        .digest("hex");
}

function assertMigrationRegistry(): void {
    for (const [index, migration] of databaseMigrations.entries()) {
        const expectedVersion = index + 1;
        if (migration.version !== expectedVersion) {
            throw new Error(
                `SQLite migration registry must be contiguous: expected ${expectedVersion}, got ${migration.version}`
            );
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.name)) {
            throw new Error(`Invalid SQLite migration name: ${migration.name}`);
        }
    }
}

function hasMigrationTable(database: Database): boolean {
    return Boolean(
        database
            .query(
                `SELECT 1
                 FROM sqlite_schema
                 WHERE type = 'table' AND name = 'schema_migrations'`
            )
            .get()
    );
}

function appliedMigrationRows(database: Database): AppliedMigrationRow[] {
    if (!hasMigrationTable(database)) {
        return [];
    }
    return database
        .query(
            `SELECT version, name, checksum, applied_at
             FROM schema_migrations
             ORDER BY version`
        )
        .all() as AppliedMigrationRow[];
}

export function validateDatabaseMigrationHistory(database: Database): number {
    assertMigrationRegistry();
    const appliedRows = appliedMigrationRows(database);
    for (const [index, row] of appliedRows.entries()) {
        const expected = databaseMigrations[index];
        if (!expected) {
            throw new Error(
                `Database contains unknown SQLite migration version ${row.version}`
            );
        }
        if (row.version !== expected.version) {
            throw new Error(
                `SQLite migration history is not contiguous at version ${expected.version}`
            );
        }
        if (row.name !== expected.name) {
            throw new Error(
                `SQLite migration ${row.version} name mismatch: expected ${expected.name}, got ${row.name}`
            );
        }
        const expectedChecksum = migrationChecksum(expected);
        if (row.checksum !== expectedChecksum) {
            throw new Error(
                `SQLite migration ${row.version} checksum mismatch for ${row.name}`
            );
        }
    }
    return appliedRows.length;
}

function hasAppSchema(database: Database): boolean {
    const row = database
        .query(
            `SELECT COUNT(*) AS count
             FROM sqlite_schema
             WHERE type = 'table'
               AND name NOT IN ('schema_migrations', 'sqlite_sequence')
               AND name NOT LIKE 'sqlite_%'`
        )
        .get() as { count: number };
    return row.count > 0;
}

function runMigrationSql(database: Database, sql: string): void {
    database.run(sql);
}

export function applyDatabaseMigrations(
    database: Database,
    databasePath: string
): DatabaseMigrationResult {
    const appliedCountBeforeLock = validateDatabaseMigrationHistory(database);
    if (appliedCountBeforeLock === databaseMigrations.length) {
        return { applied: [] };
    }

    let backup: SqliteBackupResult | undefined;
    if (hasAppSchema(database)) {
        const hasExistingMigrationTable = hasMigrationTable(database);
        backup = createVerifiedSqliteBackup(database, databasePath, "pre-migration", {
            validateRestore: hasExistingMigrationTable
                ? validateDatabaseMigrationHistory
                : undefined,
        });
    }

    const applied: number[] = [];
    database.run("BEGIN IMMEDIATE");
    try {
        database.run(MIGRATION_TABLE_SQL);
        const appliedCount = validateDatabaseMigrationHistory(database);
        for (const migration of databaseMigrations.slice(appliedCount)) {
            runMigrationSql(database, migration.sql);
            database
                .prepare(
                    `INSERT INTO schema_migrations (version, name, checksum, applied_at)
                     VALUES (?, ?, ?, ?)`
                )
                .run(
                    migration.version,
                    migration.name,
                    migrationChecksum(migration),
                    new Date().toISOString()
                );
            applied.push(migration.version);
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the migration error.
        }
        throw error;
    }

    if (backup) {
        pruneSqliteBackups(databasePath);
    }
    return { applied, backup };
}
