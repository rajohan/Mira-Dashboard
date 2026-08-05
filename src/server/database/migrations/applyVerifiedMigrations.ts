import { Database } from "bun:sqlite";

import { addMilliseconds, getTime } from "date-fns";
import * as v from "valibot";

import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    fullCommitShaSchema,
    lowercaseSha256Schema,
    parseSchemaWithRangeError,
} from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    drizzleStatementBreakpoint,
    type VerifiedMigration,
} from "./loadVerifiedMigrations.ts";
import { migrationManifest } from "./manifest.ts";
import { migrationIdSchema } from "./validation.ts";
import {
    assertConstraintEnforcement,
    assertDatabaseIntegrity,
} from "./verifyDatabaseIntegrity.ts";

export interface ApplyVerifiedMigrationsOptions {
    appliedAt?: Date;
    releaseId: string;
}

const migrationHistoryMismatchError =
    "Database migration history does not match the reviewed manifest";
const schemaHistoryMismatchError =
    "Database schema does not match reviewed migration history";
const migrationAppliedAtSchema = timestampMillisecondsSchema(
    "Migration appliedAt must be valid Date milliseconds"
);
const appliedMigrationRowSchema = v.strictObject(
    {
        appliedAt: timestampMillisecondsSchema(migrationHistoryMismatchError),
        checksum: lowercaseSha256Schema(migrationHistoryMismatchError),
        id: migrationIdSchema(migrationHistoryMismatchError),
        releaseId: fullCommitShaSchema(migrationHistoryMismatchError),
    },
    migrationHistoryMismatchError
);
const appliedMigrationRowsSchema = v.array(
    appliedMigrationRowSchema,
    migrationHistoryMismatchError
);
const schemaObjectRowSchema = v.strictObject(
    {
        name: v.string(schemaHistoryMismatchError),
        sql: v.nullable(v.string(schemaHistoryMismatchError)),
        tableName: v.string(schemaHistoryMismatchError),
        type: v.string(schemaHistoryMismatchError),
    },
    schemaHistoryMismatchError
);
const schemaObjectRowsSchema = v.array(schemaObjectRowSchema, schemaHistoryMismatchError);

type AppliedMigrationRow = v.InferOutput<typeof appliedMigrationRowSchema>;
type SchemaObjectRow = v.InferOutput<typeof schemaObjectRowSchema>;

function applicationSchemaObjects(database: Database): SchemaObjectRow[] {
    const rows: unknown = database
        .query(`
            SELECT name, sql, tbl_name AS tableName, type
            FROM sqlite_schema
            WHERE name NOT GLOB 'sqlite_*'
            ORDER BY type, name
        `)
        .all();
    const validation = v.safeParse(schemaObjectRowsSchema, rows, {
        abortEarly: true,
    });
    if (!validation.success) {
        throw new Error(schemaHistoryMismatchError);
    }
    return validation.output;
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
    const rows: unknown = database
        .query(`
            SELECT
                applied_at AS appliedAt,
                checksum,
                id,
                release_id AS releaseId
            FROM schema_migrations
            ORDER BY id
        `)
        .all();
    const validation = v.safeParse(appliedMigrationRowsSchema, rows, {
        abortEarly: true,
    });
    if (!validation.success) {
        throw new Error(migrationHistoryMismatchError);
    }
    return validation.output;
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
            throw new Error(migrationHistoryMismatchError);
        }
    }
}

function assertCanonicalVerifiedGraph(migrations: readonly VerifiedMigration[]): void {
    if (
        migrations.length !== migrationManifest.length ||
        migrations.some((migration, index) => {
            const manifestEntry = migrationManifest[index];
            const migrationSql = migration.statements.join(drizzleStatementBreakpoint);
            const statementChecksum = sha256Hex(migrationSql);

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
    if (
        !v.safeParse(
            fullCommitShaSchema(
                "Migration release id must be a full lowercase commit SHA"
            ),
            options.releaseId
        ).success
    ) {
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
        const baseAppliedAt = parseSchemaWithRangeError(
            migrationAppliedAtSchema,
            getTime(options.appliedAt ?? new Date())
        );

        for (const [pendingIndex, migration] of pending.entries()) {
            for (const statement of migration.statements) {
                if (statement.trim().length > 0) {
                    database.run(statement);
                }
            }

            const appliedAt = parseSchemaWithRangeError(
                migrationAppliedAtSchema,
                getTime(addMilliseconds(baseAppliedAt, pendingIndex))
            );
            database.run(
                `INSERT INTO schema_migrations (
                    applied_at,
                    checksum,
                    id,
                    release_id
                ) VALUES (?, ?, ?, ?)`,
                [appliedAt, migration.migrationSha256, migration.id, options.releaseId]
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
