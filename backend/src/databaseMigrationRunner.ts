import { Database } from "bun:sqlite";

import {
    type DatabaseMigrationIdentity,
    databaseMigrationIdentity,
    databaseMigrations,
} from "./databaseMigrations/index.ts";
import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "./databaseSchemaCompatibility.ts";
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

export function readAppliedDatabaseMigrationHistory(
    database: Database,
    maximumCompatibleVersion: number
): DatabaseMigrationIdentity[] {
    if (!Number.isSafeInteger(maximumCompatibleVersion) || maximumCompatibleVersion < 0) {
        throw new TypeError("Invalid maximum compatible SQLite schema version");
    }
    const appliedRows = appliedMigrationRows(database);
    for (const [index, row] of appliedRows.entries()) {
        const expectedVersion = index + 1;
        if (row.version !== expectedVersion) {
            throw new Error(
                `SQLite migration history is not contiguous at version ${expectedVersion}`
            );
        }
        const knownMigration = databaseMigrations[index];
        if (
            row.version > maximumCompatibleVersion ||
            (!knownMigration &&
                (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) ||
                    !/^[\da-f]{64}$/u.test(row.checksum)))
        ) {
            throw new Error(
                `Database contains incompatible SQLite migration version ${row.version}`
            );
        }
    }
    return appliedRows.map(({ checksum, name, version }) => ({
        checksum,
        name,
        version,
    }));
}

export function validateDatabaseMigrationHistory(
    database: Database,
    maximumCompatibleVersion: number = DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum
): number {
    assertMigrationRegistry();
    if (
        !Number.isSafeInteger(maximumCompatibleVersion) ||
        maximumCompatibleVersion < databaseMigrations.length
    ) {
        throw new TypeError("Invalid maximum compatible SQLite schema version");
    }
    const appliedRows = readAppliedDatabaseMigrationHistory(
        database,
        maximumCompatibleVersion
    );
    for (const [index, row] of appliedRows.entries()) {
        const expectedVersion = index + 1;
        if (row.version !== expectedVersion) {
            throw new Error(
                `SQLite migration history is not contiguous at version ${expectedVersion}`
            );
        }
        const expected = databaseMigrations[index];
        if (!expected) {
            if (
                row.version > maximumCompatibleVersion ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) ||
                !/^[\da-f]{64}$/u.test(row.checksum)
            ) {
                throw new Error(
                    `Database contains incompatible SQLite migration version ${row.version}`
                );
            }
            continue;
        }
        if (row.name !== expected.name) {
            throw new Error(
                `SQLite migration ${row.version} name mismatch: expected ${expected.name}, got ${row.name}`
            );
        }
        const expectedChecksum = databaseMigrationIdentity(expected).checksum;
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

function createPreMigrationBackupWhileLocked(
    database: Database,
    databasePath: string
): SqliteBackupResult | undefined {
    if (!database.inTransaction) {
        throw new Error("SQLite pre-migration backup requires the migration lock");
    }
    if (!hasAppSchema(database)) {
        return undefined;
    }

    const hasExistingMigrationTable = hasMigrationTable(database);
    const backupSource = new Database(databasePath, { readonly: true });
    try {
        backupSource.run("PRAGMA busy_timeout = 5000");
        return createVerifiedSqliteBackup(backupSource, databasePath, "pre-migration", {
            validateRestore: hasExistingMigrationTable
                ? validateDatabaseMigrationHistory
                : undefined,
        });
    } finally {
        backupSource.close();
    }
}

function applyPendingDatabaseMigrations(
    database: Database,
    createBackup?: () => SqliteBackupResult | undefined
): DatabaseMigrationResult {
    const appliedCountBeforeLock = validateDatabaseMigrationHistory(database);
    if (appliedCountBeforeLock >= databaseMigrations.length) {
        return { applied: [] };
    }

    const applied: number[] = [];
    let backup: SqliteBackupResult | undefined;
    database.run("BEGIN IMMEDIATE");
    try {
        const appliedCount = validateDatabaseMigrationHistory(database);
        if (appliedCount >= databaseMigrations.length) {
            database.run("COMMIT");
            return { applied };
        }

        backup = createBackup?.();
        database.run(MIGRATION_TABLE_SQL);
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
                    databaseMigrationIdentity(migration).checksum,
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

    return { applied, backup };
}

export function applyDatabaseMigrations(
    database: Database,
    databasePath: string
): DatabaseMigrationResult {
    const result = applyPendingDatabaseMigrations(database, () =>
        createPreMigrationBackupWhileLocked(database, databasePath)
    );
    if (result.backup) {
        pruneSqliteBackups(databasePath);
    }
    return result;
}

/**
 * Applies pending migrations only to an isolated restore copy that will be
 * discarded by the caller.
 */
export function migrateDisposableDatabaseCopy(
    database: Database
): DatabaseMigrationResult {
    return applyPendingDatabaseMigrations(database);
}
