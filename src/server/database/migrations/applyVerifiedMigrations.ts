import { Database } from "bun:sqlite";

import { getTime } from "date-fns";
import * as v from "valibot";

import { migrationManifest } from "../../../shared/databaseMigrationManifest.ts";
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
const futureMigrationHistoryError =
    "Database migration history is newer than the application clock";
const nonAdvancingMigrationClockError =
    "Migration appliedAt must advance beyond stored migration history";
const schemaHistoryMismatchError =
    "Database schema does not match reviewed migration history";
const maximumReviewedSchemaObjectCount = 4096;
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

function runMigrationStatements(database: Database, statements: readonly string[]): void {
    for (const statement of statements) {
        // Keep raw bytes for checksum verification, but do not pass trailing whitespace to Bun's
        // SQLite boundary: a trigger ABORT can otherwise be masked when SQL ends in `;\n`.
        const executableStatement = statement.trim();
        if (executableStatement.length > 0) database.run(executableStatement);
    }
}

function applicationSchemaObjects(
    database: Database,
    maximumRows: number
): SchemaObjectRow[] {
    const rows: unknown = database
        .query(`
            SELECT name, sql, tbl_name AS tableName, type
            FROM sqlite_schema
            WHERE name NOT GLOB 'sqlite_*'
            ORDER BY type, name
            LIMIT ?
        `)
        .all(maximumRows + 1);
    const validation = v.safeParse(schemaObjectRowsSchema, rows, {
        abortEarly: true,
    });
    if (!validation.success || validation.output.length > maximumRows) {
        throw new Error(schemaHistoryMismatchError);
    }
    return validation.output;
}

function hasPendingInitializedMigrations(
    database: Database,
    migrationCount: number
): boolean {
    const history = database
        .query<{ present: number }, []>(`
            SELECT 1 AS present
            FROM sqlite_schema
            WHERE type = 'table' AND name = 'schema_migrations'
        `)
        .get();
    if (history?.present !== 1) return false;

    const applied = database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get();
    return applied === null || applied.count < migrationCount;
}

function expectedSchemaObjects(
    migrations: readonly VerifiedMigration[]
): SchemaObjectRow[] {
    const expectedDatabase = new Database(":memory:", { strict: true });

    try {
        for (const migration of migrations) {
            runMigrationStatements(expectedDatabase, migration.statements);
        }
        return applicationSchemaObjects(
            expectedDatabase,
            maximumReviewedSchemaObjectCount
        );
    } finally {
        expectedDatabase.close(true);
    }
}

/**
 * Finds the bounded schema-inventory high-water mark across every migration prefix.
 * Later migrations may drop reviewed objects, so the final graph size is not a safe
 * bound for inspecting a database stopped at an earlier valid prefix.
 * @param migrations Ordered checksum-verified migration graph.
 * @returns Maximum schema-object count across all prefixes, bounded at 4096.
 * @internal
 */
export function maximumExpectedSchemaObjectCount(
    migrations: readonly VerifiedMigration[]
): number {
    const expectedDatabase = new Database(":memory:", { strict: true });
    let maximumCount = 0;

    try {
        for (const migration of migrations) {
            runMigrationStatements(expectedDatabase, migration.statements);
            maximumCount = Math.max(
                maximumCount,
                applicationSchemaObjects(
                    expectedDatabase,
                    maximumReviewedSchemaObjectCount
                ).length
            );
        }
        return maximumCount;
    } finally {
        expectedDatabase.close(true);
    }
}

function assertSchemaMatchesReviewedHistory(
    database: Database,
    migrations: readonly VerifiedMigration[],
    appliedCount: number
): void {
    const expected = expectedSchemaObjects(migrations.slice(0, appliedCount));
    const actual = applicationSchemaObjects(database, expected.length);

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Database schema does not match reviewed migration history");
    }
}

function readAppliedMigrations(
    database: Database,
    maximumRows: number
): AppliedMigrationRow[] {
    const rows: unknown = database
        .query(`
            SELECT
                applied_at AS appliedAt,
                checksum,
                id,
                release_id AS releaseId
            FROM schema_migrations
            ORDER BY id
            LIMIT ?
        `)
        .all(maximumRows + 1);
    const validation = v.safeParse(appliedMigrationRowsSchema, rows, {
        abortEarly: true,
    });
    if (!validation.success || validation.output.length > maximumRows) {
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

function latestAppliedAt(applied: readonly AppliedMigrationRow[]): number | undefined {
    let previousAppliedAt: number | undefined;

    for (const migration of applied) {
        if (previousAppliedAt !== undefined && migration.appliedAt <= previousAppliedAt) {
            throw new Error(migrationHistoryMismatchError);
        }
        previousAppliedAt = migration.appliedAt;
    }

    return previousAppliedAt;
}

/**
 * Plans strictly increasing ledger timestamps before any migration statement runs.
 * @param checkedAt Application clock in epoch milliseconds.
 * @param pendingCount Number of canonical migrations to apply.
 * @param storedAppliedAt Latest validated ledger timestamp, when one exists.
 * @returns One valid epoch-millisecond value per pending migration.
 * @internal
 */
export function planMigrationAppliedAtValues(
    checkedAt: number,
    pendingCount: number,
    storedAppliedAt?: number
): readonly number[] {
    const baseAppliedAt = parseSchemaWithRangeError(migrationAppliedAtSchema, checkedAt);

    if (storedAppliedAt !== undefined && storedAppliedAt > baseAppliedAt) {
        throw new Error(futureMigrationHistoryError);
    }
    if (pendingCount === 0) return Object.freeze([]);

    // Right-align the sequence at the observed clock so same-millisecond migrations
    // remain ordered without creating ledger rows dated in the future.
    const firstAppliedAt = parseSchemaWithRangeError(
        migrationAppliedAtSchema,
        baseAppliedAt - pendingCount + 1
    );
    if (storedAppliedAt !== undefined && firstAppliedAt <= storedAppliedAt) {
        throw new Error(nonAdvancingMigrationClockError);
    }

    return Object.freeze(
        Array.from({ length: pendingCount }, (_, pendingIndex) =>
            parseSchemaWithRangeError(
                migrationAppliedAtSchema,
                firstAppliedAt + pendingIndex
            )
        )
    );
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
    const maximumSchemaObjects = maximumExpectedSchemaObjectCount(migrations);

    // SQLite only changes foreign-key enforcement outside a transaction. Existing schemas
    // with pending table rebuilds therefore suspend FK actions before taking the atomic
    // writer transaction. Fresh schemas contain no references yet, while current schemas
    // need no DDL and retain enforcement for validate-only/nested-transaction callers.
    const suspendForeignKeys = hasPendingInitializedMigrations(
        database,
        migrations.length
    );
    if (suspendForeignKeys) {
        database.run("PRAGMA foreign_keys = OFF");
        const foreignKeysDisabled = database
            .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
            .get();
        if (foreignKeysDisabled?.foreign_keys !== 0) {
            throw new Error("Database foreign key enforcement could not be suspended");
        }
    }

    const apply = database.transaction(() => {
        const schemaObjects = applicationSchemaObjects(database, maximumSchemaObjects);
        const hasMigrationHistory = schemaObjects.some(
            (object) => object.type === "table" && object.name === "schema_migrations"
        );
        if (!hasMigrationHistory && schemaObjects.length > 0) {
            throw new Error("Initialized database is missing migration history");
        }

        const applied = hasMigrationHistory
            ? readAppliedMigrations(database, migrations.length)
            : [];
        if (hasMigrationHistory && applied.length === 0) {
            throw new Error("Initialized database has empty migration history");
        }
        assertAppliedPrefix(applied, migrations);
        assertSchemaMatchesReviewedHistory(database, migrations, applied.length);

        const pending = migrations.slice(applied.length);
        const appliedAtValues = planMigrationAppliedAtValues(
            getTime(options.appliedAt ?? new Date()),
            pending.length,
            latestAppliedAt(applied)
        );

        for (const [pendingIndex, migration] of pending.entries()) {
            const appliedAt = appliedAtValues[pendingIndex];
            if (appliedAt === undefined) {
                throw new Error("Migration timestamp plan is incomplete");
            }
            runMigrationStatements(database, migration.statements);
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

        const finalApplied = readAppliedMigrations(database, migrations.length);
        assertAppliedPrefix(finalApplied, migrations);
        if (finalApplied.length !== migrations.length) {
            throw new Error("Database migration history is incomplete after application");
        }
        assertSchemaMatchesReviewedHistory(database, migrations, finalApplied.length);
        assertDatabaseIntegrity(database);
        return pending.length;
    });

    try {
        return apply.immediate();
    } finally {
        if (suspendForeignKeys) database.run("PRAGMA foreign_keys = ON");
        assertConstraintEnforcement(database);
    }
}

/**
 * Validates one already-current database without taking SQLite's writer slot.
 * The deferred read snapshot keeps history, schema, and integrity evidence coherent
 * while WAL writers in the serving generation continue independently.
 * @param database Retained native SQLite connection.
 * @param migrations Complete checksum-verified canonical migration graph.
 * @param checkedAt Application clock used to reject future ledger history.
 */
export function validateVerifiedMigrations(
    database: Database,
    migrations: readonly VerifiedMigration[],
    checkedAt: Date = new Date()
): void {
    assertCanonicalVerifiedGraph(migrations);
    assertConstraintEnforcement(database);

    const validate = database.transaction(() => {
        const applied = readAppliedMigrations(database, migrations.length);
        assertAppliedPrefix(applied, migrations);
        if (applied.length !== migrations.length) {
            throw new Error("Database migration history is incomplete");
        }
        planMigrationAppliedAtValues(getTime(checkedAt), 0, latestAppliedAt(applied));
        assertSchemaMatchesReviewedHistory(database, migrations, applied.length);
        assertConstraintEnforcement(database);
        assertDatabaseIntegrity(database);
    });

    validate.deferred();
}
