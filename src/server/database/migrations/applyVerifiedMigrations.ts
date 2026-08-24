import { Database } from "bun:sqlite";

import {
    drizzleStatementBreakpoint,
    type VerifiedMigration,
} from "./loadVerifiedMigrations.ts";
import { migrationManifest } from "./manifest.ts";
import {
    assertConstraintEnforcement,
    assertDatabaseIntegrity,
} from "./verifyDatabaseIntegrity.ts";

interface AppliedMigrationRow {
    checksum: string;
    id: string;
}

interface SchemaObjectRow {
    name: string;
    sql: string | null;
    tableName: string;
    type: string;
}

export interface ApplyVerifiedMigrationsOptions {
    appliedAt?: Date;
    releaseId: string;
}

const releaseIdPattern = /^[a-f\d]{40}$/u;

function applicationSchemaObjects(database: Database): SchemaObjectRow[] {
    return database
        .query<SchemaObjectRow, []>(`
            SELECT name, sql, tbl_name AS tableName, type
            FROM sqlite_schema
            WHERE name NOT GLOB 'sqlite_*'
            ORDER BY type, name
        `)
        .all();
}

function expectedSchemaObjects(
    migrations: readonly VerifiedMigration[]
): SchemaObjectRow[] {
    const expectedDatabase = new Database(":memory:", { strict: true });

    try {
        for (const migration of migrations) {
            for (const statement of migration.statements) {
                if (statement.trim().length > 0) {
                    expectedDatabase.run(statement);
                }
            }
        }
        return applicationSchemaObjects(expectedDatabase);
    } finally {
        expectedDatabase.close(true);
    }
}

function assertSchemaMatchesReviewedHistory(
    database: Database,
    migrations: readonly VerifiedMigration[],
    appliedCount: number
): void {
    const actual = applicationSchemaObjects(database);
    const expected = expectedSchemaObjects(migrations.slice(0, appliedCount));

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Database schema does not match reviewed migration history");
    }
}

function readAppliedMigrations(database: Database): AppliedMigrationRow[] {
    return database
        .query<AppliedMigrationRow, []>(`
            SELECT checksum, id
            FROM schema_migrations
            ORDER BY id
        `)
        .all();
}

function assertAppliedPrefix(
    applied: readonly AppliedMigrationRow[],
    migrations: readonly VerifiedMigration[]
): void {
    if (applied.length > migrations.length) {
        throw new Error("Database migration history is not a reviewed manifest prefix");
    }

    for (const [index, appliedMigration] of applied.entries()) {
        const expectedMigration = migrations[index];
        if (
            !expectedMigration ||
            appliedMigration.id !== expectedMigration.id ||
            appliedMigration.checksum !== expectedMigration.migrationSha256
        ) {
            throw new Error(
                "Database migration history does not match the reviewed manifest"
            );
        }
    }
}

function assertCanonicalVerifiedGraph(migrations: readonly VerifiedMigration[]): void {
    if (
        migrations.length !== migrationManifest.length ||
        migrations.some((migration, index) => {
            const manifestEntry = migrationManifest[index];
            const migrationSql = migration.statements.join(drizzleStatementBreakpoint);
            const statementChecksum = new Bun.CryptoHasher("sha256")
                .update(migrationSql)
                .digest("hex");

            return (
                !manifestEntry ||
                migration.id !== manifestEntry.id ||
                migration.migrationSha256 !== manifestEntry.migrationSha256 ||
                migration.snapshotSha256 !== manifestEntry.snapshotSha256 ||
                statementChecksum !== manifestEntry.migrationSha256
            );
        })
    ) {
        throw new Error("Verified migration graph does not match the reviewed manifest");
    }
}

/**
 * Applies checksum-verified migrations and records the exact reviewed SQL identity.
 * @returns Number of migrations applied during this call.
 */
export function applyVerifiedMigrations(
    database: Database,
    migrations: readonly VerifiedMigration[],
    options: ApplyVerifiedMigrationsOptions
): number {
    assertCanonicalVerifiedGraph(migrations);
    if (!releaseIdPattern.test(options.releaseId)) {
        throw new Error("Migration release id must be a full lowercase commit SHA");
    }
    assertConstraintEnforcement(database);

    const apply = database.transaction(() => {
        const schemaObjects = applicationSchemaObjects(database);
        const hasMigrationHistory = schemaObjects.some(
            (object) => object.type === "table" && object.name === "schema_migrations"
        );
        if (!hasMigrationHistory && schemaObjects.length > 0) {
            throw new Error("Initialized database is missing migration history");
        }

        const applied = hasMigrationHistory ? readAppliedMigrations(database) : [];
        if (hasMigrationHistory && applied.length === 0) {
            throw new Error("Initialized database has empty migration history");
        }
        assertAppliedPrefix(applied, migrations);
        assertSchemaMatchesReviewedHistory(database, migrations, applied.length);

        const pending = migrations.slice(applied.length);
        const baseAppliedAt = options.appliedAt?.getTime() ?? Date.now();

        for (const [pendingIndex, migration] of pending.entries()) {
            for (const statement of migration.statements) {
                if (statement.trim().length > 0) {
                    database.run(statement);
                }
            }

            database.run(
                `INSERT INTO schema_migrations (
                    applied_at,
                    checksum,
                    id,
                    release_id
                ) VALUES (?, ?, ?, ?)`,
                [
                    baseAppliedAt + pendingIndex,
                    migration.migrationSha256,
                    migration.id,
                    options.releaseId,
                ]
            );
        }

        const finalApplied = readAppliedMigrations(database);
        assertAppliedPrefix(finalApplied, migrations);
        if (finalApplied.length !== migrations.length) {
            throw new Error("Database migration history is incomplete after application");
        }
        assertSchemaMatchesReviewedHistory(database, migrations, finalApplied.length);
        assertConstraintEnforcement(database);
        assertDatabaseIntegrity(database);
        return pending.length;
    });

    return apply.immediate();
}
