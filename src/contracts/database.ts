import * as v from "valibot";

import { databaseObservabilityDatabaseMaximum as dynamicDatabaseObservabilityDatabaseMaximum } from "../shared/databaseObservabilityPolicy.ts";
import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import type { JsonObject } from "../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import { jobRunIdSchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";

/** Maximum migration count accepted from the reviewed runtime graph. */
export const databaseObservabilityMigrationMaximum = 64;
/** Reusable SQLite bytes that independently require planned VACUUM review. */
export const sqliteReusableSpaceReviewBytes = 1024 * 1024 * 1024;
/** Minimum reusable bytes before the SQLite percentage threshold can apply. */
export const sqliteReusableSpaceReviewMinimumBytes = 256 * 1024 * 1024;
/** Reusable SQLite share requiring review once its minimum byte threshold is met. */
export const sqliteReusableSpaceReviewPercent = 50;
/** Durable cache identity reserved for the worker-owned database snapshot. */
export const databaseObservabilityCacheKey = "database.observability";
/** Current material-maintenance payload identity written by the worker. */
export const databaseObservabilityCacheSchemaId = "database.observability.v3";
/** Source identity for the fixed PostgreSQL and PgBouncer collector. */
export const databaseObservabilityCacheSource = "postgresql.pgbouncer";
/** Maximum number of dynamically discovered PostgreSQL rows exposed in one snapshot. */
export const databaseObservabilityDatabaseMaximum =
    dynamicDatabaseObservabilityDatabaseMaximum;
/** Maximum number of PostgreSQL table-health rows exposed in one snapshot. */
export const databaseObservabilityTableHealthMaximum = 25;
/** Maximum number of identity-free statement metric rows exposed in one snapshot. */
export const databaseObservabilityStatementMaximum = 20;
/** Maximum UTF-8 size of the validated external cache payload. */
export const databaseObservabilityCachePayloadMaximumBytes = 128 * 1024;
/** Maximum server-side age of an external last-known-good snapshot. */
export const databaseObservabilityExternalLastKnownGoodMs = 24 * 60 * 60 * 1000;
/** Aggregate reclaimable bytes that independently require maintenance review. */
export const databaseObservabilityBloatReviewBytes = 5 * 1024 * 1024 * 1024;
/** Minimum reclaimable bytes before the percentage threshold can require review. */
export const databaseObservabilityBloatReviewMinimumBytes = 1024 * 1024 * 1024;
/** Reclaimable share that requires review once the minimum byte threshold is met. */
export const databaseObservabilityBloatReviewPercent = 25;
/** Minimum dead tuples for one table to count as high-dead. */
export const databaseObservabilityHighDeadTupleMinimum = 1000;
/** Minimum physical table size for one table to count as high-dead. */
export const databaseObservabilityHighDeadTupleMinimumBytes = 64 * 1024 * 1024;
/** Minimum dead-tuple share for one table to count as high-dead. */
export const databaseObservabilityHighDeadTuplePercent = 20;
/** Minimum recurring executions required before one statement can require review. */
export const databaseObservabilitySlowStatementMinimumCalls = 25;
/** Mean execution time at which one recurring statement requires review. */
export const databaseObservabilitySlowStatementMeanMs = 1000;
/** Unassessed table bytes that make the material bloat assessment incomplete. */
export const databaseObservabilityUnassessedReviewBytes = 64 * 1024 * 1024;
/** Maximum immutable SQLite maintenance snapshots retained and projected. */
export const sqliteMaintenanceBackupMaximum = 14;
export const sqliteBackupInventoryMaximum = 32;
/** Maximum durable SQLite maintenance runs projected in the database overview. */
export const sqliteMaintenanceHistoryMaximum = 10;

const databaseObservabilityTimestampSchema = timestampMillisecondsSchema(
    "Database observation timestamp is invalid"
);
const databaseObservabilityCountSchema = nonnegativeSafeIntegerSchema(
    "Database observation count is invalid"
);
const databaseObservabilityByteCountSchema = nonnegativeSafeIntegerSchema(
    "Database observation byte count is invalid"
);
const databaseObservabilityDurationSchema = v.pipe(
    v.number("Database observation duration is invalid"),
    v.finite("Database observation duration is invalid"),
    v.minValue(0, "Database observation duration is invalid"),
    v.maxValue(Number.MAX_SAFE_INTEGER, "Database observation duration is invalid")
);
const databaseObservabilityRatioSchema = v.pipe(
    v.number("Database observation ratio is invalid"),
    v.finite("Database observation ratio is invalid"),
    v.minValue(0, "Database observation ratio is invalid"),
    v.maxValue(100, "Database observation ratio is invalid")
);

/**
 * @param value - PostgreSQL identifier to measure as UTF-8.
 * @returns Whether the identifier fits PostgreSQL's 63-byte storage boundary.
 */
export function databaseObservabilityNameFitsPostgresqlByteLimit(value: string): boolean {
    return utf8ByteLength(value) <= 63;
}

const databaseObservabilityNameSchema = v.pipe(
    boundedControlSafeTextSchema(63, "Database object name is invalid"),
    v.check(
        databaseObservabilityNameFitsPostgresqlByteLimit,
        "Database object name is invalid"
    )
);

const sqliteConnectionPolicySchema = v.strictObject({
    busyPolicy: v.literal("non-blocking"),
    checksEnforced: v.literal(true),
    foreignKeysEnabled: v.literal(true),
    journalMode: v.literal("wal"),
    synchronousMode: v.literal("full"),
    trustedSchemaEnabled: v.literal(false),
    walAutoCheckpointPages: v.pipe(
        databaseObservabilityCountSchema,
        v.maxValue(1_000_000, "SQLite WAL checkpoint policy is outside its budget")
    ),
});

const sqliteMigrationStateObjectSchema = v.strictObject({
    applied: v.pipe(
        databaseObservabilityCountSchema,
        v.maxValue(
            databaseObservabilityMigrationMaximum,
            "Applied migration count is outside its budget"
        )
    ),
    available: v.pipe(
        databaseObservabilityCountSchema,
        v.maxValue(
            databaseObservabilityMigrationMaximum,
            "Available migration count is outside its budget"
        )
    ),
    current: v.boolean(),
});

/**
 * @param state Bounded migration counts and their projected current status.
 * @returns Whether migration counts and current status describe one coherent state.
 */
export function sqliteMigrationStateIsConsistent(state: {
    readonly applied: number;
    readonly available: number;
    readonly current: boolean;
}): boolean {
    return (
        state.applied <= state.available &&
        state.current === (state.applied === state.available)
    );
}

export const sqliteMigrationStateSchema = v.pipe(
    sqliteMigrationStateObjectSchema,
    v.check(
        sqliteMigrationStateIsConsistent,
        "SQLite migration observation is inconsistent"
    )
);

const sqlitePermissionModeSchema = v.pipe(
    v.string("SQLite permission mode is invalid"),
    v.regex(/^0[0-7]{3}$/u, "SQLite permission mode is invalid")
);

/**
 * @param value Bounded SQLite page size in bytes.
 * @returns Whether a bounded SQLite page size is a power of two.
 */
export function sqlitePageSizeIsPowerOfTwo(value: number): boolean {
    return Number.isInteger(Math.log2(value));
}

const sqliteStorageObjectSchema = v.strictObject({
    databaseBytes: databaseObservabilityByteCountSchema,
    freeBytes: databaseObservabilityByteCountSchema,
    freePages: databaseObservabilityCountSchema,
    freePercent: databaseObservabilityRatioSchema,
    pageCount: databaseObservabilityCountSchema,
    pageSizeBytes: v.pipe(
        databaseObservabilityByteCountSchema,
        v.minValue(512, "SQLite page size is invalid"),
        v.maxValue(65_536, "SQLite page size is invalid"),
        v.check(sqlitePageSizeIsPowerOfTwo, "SQLite page size is invalid")
    ),
    permissions: v.strictObject({
        dataDirectory: sqlitePermissionModeSchema,
        database: sqlitePermissionModeSchema,
        secure: v.boolean(),
        shm: v.optional(sqlitePermissionModeSchema),
        wal: v.optional(sqlitePermissionModeSchema),
    }),
    requiresVacuumReview: v.boolean(),
    shmBytes: databaseObservabilityByteCountSchema,
    storageBytes: databaseObservabilityByteCountSchema,
    walBytes: databaseObservabilityByteCountSchema,
});

type SqliteStorageLike = v.InferOutput<typeof sqliteStorageObjectSchema>;

function sqlitePermissionsAreSecure(
    permissions: SqliteStorageLike["permissions"]
): boolean {
    return (
        permissions.dataDirectory === "0700" &&
        permissions.database === "0600" &&
        (permissions.shm === undefined || permissions.shm === "0600") &&
        (permissions.wal === undefined || permissions.wal === "0600")
    );
}

/**
 * @param freeBytes Reusable SQLite bytes.
 * @param freePercent Reusable share of logical database pages.
 * @returns Whether the observed reusable SQLite space warrants planned VACUUM review.
 */
export function sqliteReusableSpaceRequiresVacuumReview(
    freeBytes: number,
    freePercent: number
): boolean {
    return (
        freeBytes >= sqliteReusableSpaceReviewBytes ||
        (freeBytes >= sqliteReusableSpaceReviewMinimumBytes &&
            freePercent >= sqliteReusableSpaceReviewPercent)
    );
}

/** @returns Whether bounded SQLite file, page, free-space, and mode fields agree. */
export function sqliteStorageObservationIsConsistent(
    storage: SqliteStorageLike
): boolean {
    const expectedFreeBytes = storage.freePages * storage.pageSizeBytes;
    const expectedStorageBytes =
        storage.databaseBytes + storage.walBytes + storage.shmBytes;
    const expectedFreePercent =
        storage.pageCount === 0 ? 0 : (storage.freePages / storage.pageCount) * 100;
    return (
        storage.freePages <= storage.pageCount &&
        Number.isSafeInteger(expectedFreeBytes) &&
        storage.freeBytes === expectedFreeBytes &&
        Number.isSafeInteger(expectedStorageBytes) &&
        storage.storageBytes === expectedStorageBytes &&
        storage.freePercent === expectedFreePercent &&
        storage.permissions.secure === sqlitePermissionsAreSecure(storage.permissions) &&
        storage.requiresVacuumReview ===
            sqliteReusableSpaceRequiresVacuumReview(
                storage.freeBytes,
                storage.freePercent
            )
    );
}

export const sqliteStorageObservationSchema = v.pipe(
    sqliteStorageObjectSchema,
    v.check(
        sqliteStorageObservationIsConsistent,
        "SQLite storage observation is inconsistent"
    )
);

const sqliteMaintenanceBackupSchema = v.strictObject({
    bytes: databaseObservabilityByteCountSchema,
    createdAtMs: databaseObservabilityTimestampSchema,
    kind: v.picklist(["cutover", "scheduled"]),
    restoreVerifiedAtMs: v.optional(databaseObservabilityTimestampSchema),
    verificationLevel: v.picklist(["manifest-verified", "restore-copy-verified"]),
});

const sqliteBackupInventoryValueEntries = {
    backups: v.pipe(
        v.array(sqliteMaintenanceBackupSchema),
        v.maxLength(
            sqliteBackupInventoryMaximum,
            "SQLite backup inventory is outside its budget"
        )
    ),
    observedAtMs: databaseObservabilityTimestampSchema,
    totalBytes: databaseObservabilityByteCountSchema,
} as const;

function sqliteBackupInventoryIsConsistent(inventory: {
    readonly backups: readonly {
        readonly bytes: number;
        readonly createdAtMs: number;
        readonly kind: "cutover" | "scheduled";
        readonly restoreVerifiedAtMs?: number;
        readonly verificationLevel: "manifest-verified" | "restore-copy-verified";
    }[];
    readonly totalBytes: number;
}): boolean {
    return (
        inventory.backups.every(
            (backup, index) =>
                ((backup.verificationLevel === "restore-copy-verified" &&
                    backup.restoreVerifiedAtMs !== undefined &&
                    backup.restoreVerifiedAtMs >= backup.createdAtMs) ||
                    (backup.verificationLevel === "manifest-verified" &&
                        backup.restoreVerifiedAtMs === undefined)) &&
                (index === 0 ||
                    inventory.backups[index - 1]!.createdAtMs >= backup.createdAtMs)
        ) &&
        inventory.backups.reduce((total, backup) => total + backup.bytes, 0) ===
            inventory.totalBytes
    );
}

const sqliteBackupInventoryAvailableSchema = v.variant("state", [
    v.strictObject({
        ...sqliteBackupInventoryValueEntries,
        state: v.literal("available"),
    }),
    v.strictObject({
        ...sqliteBackupInventoryValueEntries,
        staleSinceMs: databaseObservabilityTimestampSchema,
        state: v.literal("last-known-good"),
    }),
]);

const sqliteBackupInventorySchema = v.union([
    sqliteBackupInventoryAvailableSchema,
    v.strictObject({
        reason: v.literal("inventory-unavailable"),
        state: v.literal("unavailable"),
    }),
]);

const sqliteRestoreVerificationValueEntries = {
    backupBytes: databaseObservabilityByteCountSchema,
    backupCreatedAtMs: databaseObservabilityTimestampSchema,
    observedAtMs: databaseObservabilityTimestampSchema,
    verifiedAtMs: databaseObservabilityTimestampSchema,
} as const;

const sqliteRestoreVerificationSchema = v.variant("state", [
    v.strictObject({
        ...sqliteRestoreVerificationValueEntries,
        state: v.literal("verified"),
    }),
    v.strictObject({
        ...sqliteRestoreVerificationValueEntries,
        staleSinceMs: databaseObservabilityTimestampSchema,
        state: v.literal("last-known-good"),
    }),
    v.strictObject({
        reason: v.picklist(["no-verified-backup", "verification-unavailable"]),
        state: v.literal("unavailable"),
    }),
]);

const sqliteMaintenanceRunSchema = v.strictObject({
    finishedAtMs: v.optional(databaseObservabilityTimestampSchema),
    queuedAtMs: databaseObservabilityTimestampSchema,
    runId: jobRunIdSchema,
    startedAtMs: v.optional(databaseObservabilityTimestampSchema),
    state: v.picklist([
        "cancelled",
        "failed",
        "queued",
        "running",
        "succeeded",
        "timed-out",
    ]),
});

const sqliteMaintenanceValueEntries = {
    enabled: v.boolean(),
    latestSuccessfulAtMs: v.optional(databaseObservabilityTimestampSchema),
    nextRunAtMs: v.optional(databaseObservabilityTimestampSchema),
    observedAtMs: databaseObservabilityTimestampSchema,
    runs: v.pipe(
        v.array(sqliteMaintenanceRunSchema),
        v.maxLength(
            sqliteMaintenanceHistoryMaximum,
            "SQLite maintenance history is outside its budget"
        )
    ),
    schedule: v.strictObject({
        timeOfDay: v.literal("02:40"),
        timeZone: v.literal("Europe/Oslo"),
    }),
} as const;

const sqliteMaintenanceSchema = v.variant("state", [
    v.strictObject({
        ...sqliteMaintenanceValueEntries,
        state: v.literal("available"),
    }),
    v.strictObject({
        ...sqliteMaintenanceValueEntries,
        staleSinceMs: databaseObservabilityTimestampSchema,
        state: v.literal("last-known-good"),
    }),
    v.strictObject({
        reason: v.literal("maintenance-unavailable"),
        state: v.literal("unavailable"),
    }),
]);

export const sqliteLifecycleObservationSchema = v.strictObject({
    backupInventory: sqliteBackupInventorySchema,
    maintenance: sqliteMaintenanceSchema,
    restoreVerification: sqliteRestoreVerificationSchema,
});

/** Path-free successful result persisted by the scheduled SQLite maintenance job. */
export const sqliteMaintenanceJobResultSchema = v.strictObject({
    backupBytes: databaseObservabilityByteCountSchema,
    backupCreatedAtMs: databaseObservabilityTimestampSchema,
    checkpoint: v.strictObject({
        busyFrames: databaseObservabilityCountSchema,
        checkpointedFrames: databaseObservabilityCountSchema,
        logFrames: databaseObservabilityCountSchema,
    }),
    completedAtMs: databaseObservabilityTimestampSchema,
    retainedBackupCount: v.pipe(
        databaseObservabilityCountSchema,
        v.maxValue(
            sqliteMaintenanceBackupMaximum,
            "SQLite retained backup count is outside its budget"
        )
    ),
    retainedBackupBytes: databaseObservabilityByteCountSchema,
    status: v.literal("completed"),
});

const sqliteObservationValueEntries = {
    connection: sqliteConnectionPolicySchema,
    fileName: v.literal("mira-dashboard.db"),
    lifecycle: sqliteLifecycleObservationSchema,
    migrations: sqliteMigrationStateSchema,
    storage: sqliteStorageObservationSchema,
} as const;

const sqliteObservationVariantSchema = v.variant("state", [
    v.strictObject({ state: v.literal("unavailable") }),
    v.strictObject({
        ...sqliteObservationValueEntries,
        observedAtMs: databaseObservabilityTimestampSchema,
        state: v.literal("fresh"),
    }),
    v.strictObject({
        ...sqliteObservationValueEntries,
        observedAtMs: databaseObservabilityTimestampSchema,
        staleSinceMs: databaseObservabilityTimestampSchema,
        state: v.literal("last-known-good"),
    }),
]);

/** One bounded PostgreSQL database-level metrics row. */
export const databaseObservabilityDatabaseSchema = v.strictObject({
    blocksHit: databaseObservabilityCountSchema,
    blocksRead: databaseObservabilityCountSchema,
    cacheHitRatio: databaseObservabilityRatioSchema,
    committedTransactions: databaseObservabilityCountSchema,
    connections: databaseObservabilityCountSchema,
    detailsState: v.picklist(["available", "unavailable"]),
    name: databaseObservabilityNameSchema,
    pool: v.optional(
        v.strictObject({
            activeClients: databaseObservabilityCountSchema,
            activeServers: databaseObservabilityCountSchema,
            averageQueryMs: databaseObservabilityDurationSchema,
            averageTransactionMs: databaseObservabilityDurationSchema,
            idleServers: databaseObservabilityCountSchema,
            totalQueries: databaseObservabilityCountSchema,
            usedServers: databaseObservabilityCountSchema,
            waitingClients: databaseObservabilityCountSchema,
        })
    ),
    rolledBackTransactions: databaseObservabilityCountSchema,
    sizeBytes: databaseObservabilityByteCountSchema,
});

/** One bounded PostgreSQL table maintenance-health row. */
export const databaseObservabilityTableHealthSchema = v.strictObject({
    assessment: v.picklist(["assessed", "unavailable"]),
    database: databaseObservabilityNameSchema,
    deadTuplePercent: databaseObservabilityRatioSchema,
    deadTuples: databaseObservabilityCountSchema,
    estimatedReclaimableBytes: v.optional(databaseObservabilityByteCountSchema),
    lastAutoanalyzeAtMs: v.optional(databaseObservabilityTimestampSchema),
    lastAutovacuumAtMs: v.optional(databaseObservabilityTimestampSchema),
    liveTuples: databaseObservabilityCountSchema,
    physicalBytes: databaseObservabilityByteCountSchema,
    schema: databaseObservabilityNameSchema,
    table: databaseObservabilityNameSchema,
});

/** One ranked aggregate statement row; SQL/query text is deliberately absent. */
export const databaseObservabilityStatementSchema = v.strictObject({
    calls: databaseObservabilityCountSchema,
    meanExecutionMs: databaseObservabilityDurationSchema,
    rank: v.pipe(
        databaseObservabilityCountSchema,
        v.minValue(1, "Database statement rank is invalid"),
        v.maxValue(
            databaseObservabilityStatementMaximum,
            "Database statement rank is invalid"
        )
    ),
    rows: databaseObservabilityCountSchema,
    sharedBlocksHit: databaseObservabilityCountSchema,
    sharedBlocksRead: databaseObservabilityCountSchema,
    totalExecutionMs: databaseObservabilityDurationSchema,
});

const databaseObservabilitySummarySchema = v.strictObject({
    activeConnections: databaseObservabilityCountSchema,
    averageCacheHitRatio: databaseObservabilityRatioSchema,
    idleConnections: databaseObservabilityCountSchema,
    maintenance: v.strictObject({
        assessedPhysicalBytes: databaseObservabilityByteCountSchema,
        assessmentComplete: v.boolean(),
        estimatedReclaimableBytes: databaseObservabilityByteCountSchema,
        estimatedReclaimablePercent: databaseObservabilityRatioSchema,
        highDeadTupleTableCount: databaseObservabilityCountSchema,
        requiresBloatReview: v.boolean(),
        slowStatementCount: databaseObservabilityCountSchema,
        status: v.picklist(["healthy", "not-assessed", "review"]),
        unassessedPhysicalBytes: databaseObservabilityByteCountSchema,
        unassessedTableCount: databaseObservabilityCountSchema,
    }),
    pgStatStatementsEnabled: v.boolean(),
    totalConnections: databaseObservabilityCountSchema,
    totalDatabaseSizeBytes: databaseObservabilityByteCountSchema,
    unavailableDatabaseCount: databaseObservabilityCountSchema,
});

const databaseObservabilityPgBouncerSchema = v.strictObject({
    averageQueryMs: databaseObservabilityDurationSchema,
    averageTransactionMs: databaseObservabilityDurationSchema,
    clientConnections: databaseObservabilityCountSchema,
    maxWaitSeconds: databaseObservabilityDurationSchema,
    serverConnections: databaseObservabilityCountSchema,
    waitingClients: databaseObservabilityCountSchema,
});

/** One independently available count-only torrent projection. */
export const databaseObservabilityTorrentCountSchema = v.variant("state", [
    v.strictObject({
        count: databaseObservabilityCountSchema,
        state: v.literal("available"),
    }),
    v.strictObject({ state: v.literal("unavailable") }),
]);

/** Reviewed count-only projections that avoid broad application-table access. */
export const databaseObservabilityTorrentCountsSchema = v.strictObject({
    bitmagnet: databaseObservabilityTorrentCountSchema,
    comet: databaseObservabilityTorrentCountSchema,
});

interface DatabaseObservabilityCachePayloadLike extends JsonObject {
    databases: {
        readonly blocksHit: number;
        readonly blocksRead: number;
        readonly cacheHitRatio: number;
        readonly committedTransactions: number;
        readonly connections: number;
        readonly detailsState: "available" | "unavailable";
        readonly name: string;
        pool?: {
            readonly activeClients: number;
            readonly activeServers: number;
            readonly averageQueryMs: number;
            readonly averageTransactionMs: number;
            readonly idleServers: number;
            readonly totalQueries: number;
            readonly usedServers: number;
            readonly waitingClients: number;
        };
        readonly rolledBackTransactions: number;
        readonly sizeBytes: number;
    }[];
    pgbouncer: {
        readonly averageQueryMs: number;
        readonly averageTransactionMs: number;
        readonly clientConnections: number;
        readonly maxWaitSeconds: number;
        readonly serverConnections: number;
        readonly waitingClients: number;
    };
    statements: {
        readonly calls: number;
        readonly meanExecutionMs: number;
        readonly rank: number;
        readonly rows: number;
        readonly sharedBlocksHit: number;
        readonly sharedBlocksRead: number;
        readonly totalExecutionMs: number;
    }[];
    summary: {
        maintenance: {
            readonly assessedPhysicalBytes: number;
            readonly estimatedReclaimableBytes: number;
            readonly estimatedReclaimablePercent: number;
            readonly highDeadTupleTableCount: number;
            readonly assessmentComplete: boolean;
            readonly requiresBloatReview: boolean;
            readonly slowStatementCount: number;
            readonly status: "healthy" | "not-assessed" | "review";
            readonly unassessedPhysicalBytes: number;
            readonly unassessedTableCount: number;
        };
        readonly activeConnections: number;
        readonly averageCacheHitRatio: number;
        readonly idleConnections: number;
        readonly pgStatStatementsEnabled: boolean;
        readonly totalConnections: number;
        readonly totalDatabaseSizeBytes: number;
        readonly unavailableDatabaseCount: number;
    };
    tableHealth: {
        readonly database: string;
        readonly assessment: "assessed" | "unavailable";
        readonly deadTuplePercent: number;
        readonly deadTuples: number;
        readonly estimatedReclaimableBytes?: number;
        readonly lastAutoanalyzeAtMs?: number;
        readonly lastAutovacuumAtMs?: number;
        readonly liveTuples: number;
        readonly physicalBytes: number;
        readonly schema: string;
        readonly table: string;
    }[];
    torrentCounts: {
        bitmagnet:
            | { readonly count: number; readonly state: "available" }
            | { readonly state: "unavailable" };
        comet:
            | { readonly count: number; readonly state: "available" }
            | { readonly state: "unavailable" };
    };
}

function compareTableHealthRows(
    left: DatabaseObservabilityCachePayloadLike["tableHealth"][number],
    right: DatabaseObservabilityCachePayloadLike["tableHealth"][number]
): number {
    const leftHighRisk = tableHealthRowIsHighDead(left);
    const rightHighRisk = tableHealthRowIsHighDead(right);
    return (
        Number(rightHighRisk) - Number(leftHighRisk) ||
        (right.estimatedReclaimableBytes ?? 0) - (left.estimatedReclaimableBytes ?? 0) ||
        right.deadTuples - left.deadTuples ||
        compareStrings(left.database, right.database) ||
        compareStrings(left.schema, right.schema) ||
        compareStrings(left.table, right.table)
    );
}

function compareStatementRows(
    left: DatabaseObservabilityCachePayloadLike["statements"][number],
    right: DatabaseObservabilityCachePayloadLike["statements"][number]
): number {
    return (
        right.totalExecutionMs - left.totalExecutionMs ||
        right.calls - left.calls ||
        right.rows - left.rows
    );
}

function tableHealthRowIsHighDead(
    row: DatabaseObservabilityCachePayloadLike["tableHealth"][number]
): boolean {
    return (
        row.physicalBytes >= databaseObservabilityHighDeadTupleMinimumBytes &&
        row.deadTuples >= databaseObservabilityHighDeadTupleMinimum &&
        row.deadTuplePercent >= databaseObservabilityHighDeadTuplePercent
    );
}

function expectedMaintenanceStatus(
    maintenance: DatabaseObservabilityCachePayloadLike["summary"]["maintenance"],
    statementAssessmentAvailable: boolean
): "healthy" | "not-assessed" | "review" {
    if (
        maintenance.requiresBloatReview ||
        maintenance.highDeadTupleTableCount > 0 ||
        maintenance.slowStatementCount > 0
    ) {
        return "review";
    }
    return maintenance.assessmentComplete && statementAssessmentAvailable
        ? "healthy"
        : "not-assessed";
}

function expectedBloatReview(
    maintenance: DatabaseObservabilityCachePayloadLike["summary"]["maintenance"]
): boolean {
    return (
        maintenance.estimatedReclaimableBytes >= databaseObservabilityBloatReviewBytes ||
        (maintenance.estimatedReclaimableBytes >=
            databaseObservabilityBloatReviewMinimumBytes &&
            maintenance.estimatedReclaimablePercent >=
                databaseObservabilityBloatReviewPercent)
    );
}

function statementRequiresReview(
    statement: DatabaseObservabilityCachePayloadLike["statements"][number]
): boolean {
    return (
        statement.calls >= databaseObservabilitySlowStatementMinimumCalls &&
        statement.meanExecutionMs >= databaseObservabilitySlowStatementMeanMs
    );
}

function materialTableAssessmentIsComplete(
    maintenance: DatabaseObservabilityCachePayloadLike["summary"]["maintenance"]
): boolean {
    return (
        maintenance.unassessedPhysicalBytes < databaseObservabilityUnassessedReviewBytes
    );
}

function safeCountTotal(values: readonly number[]): number | undefined {
    let total = 0;
    for (const value of values) {
        total += value;
        if (!Number.isSafeInteger(total)) return undefined;
    }
    return total;
}

function expectedCacheHitRatio(
    blocksHit: number,
    blocksRead: number
): number | undefined {
    const total = safeCountTotal([blocksHit, blocksRead]);
    if (total === undefined) return undefined;
    return total === 0 ? 100 : (blocksHit / total) * 100;
}

/** @returns Whether one payload is deterministic, unique, internally consistent, and bounded. */
export function databaseObservabilityCachePayloadIsConsistent(
    payload: DatabaseObservabilityCachePayloadLike
): boolean {
    const databaseNames = new Set(payload.databases.map((row) => row.name));
    const tableNames = new Set(
        payload.tableHealth.map((row) =>
            JSON.stringify([row.database, row.schema, row.table])
        )
    );
    const maintenance = payload.summary.maintenance;
    const visibleSlowStatementCount = payload.statements.filter(
        statementRequiresReview
    ).length;
    const expectedReclaimablePercent =
        maintenance.assessedPhysicalBytes === 0
            ? 0
            : (maintenance.estimatedReclaimableBytes /
                  maintenance.assessedPhysicalBytes) *
              100;
    const totalBlocksHit = safeCountTotal(
        payload.databases.map(({ blocksHit }) => blocksHit)
    );
    const totalBlocksRead = safeCountTotal(
        payload.databases.map(({ blocksRead }) => blocksRead)
    );
    const expectedAverageCacheHitRatio =
        totalBlocksHit === undefined || totalBlocksRead === undefined
            ? undefined
            : expectedCacheHitRatio(totalBlocksHit, totalBlocksRead);
    return (
        utf8ByteLength(JSON.stringify(payload)) <=
            databaseObservabilityCachePayloadMaximumBytes &&
        payload.databases.length > 0 &&
        databaseNames.size === payload.databases.length &&
        payload.databases.every(
            (row, index, rows) =>
                index === 0 || compareStrings(rows[index - 1]!.name, row.name) < 0
        ) &&
        payload.databases.every(
            (row) =>
                row.cacheHitRatio === expectedCacheHitRatio(row.blocksHit, row.blocksRead)
        ) &&
        tableNames.size === payload.tableHealth.length &&
        payload.tableHealth.every(
            (row, index, rows) =>
                databaseNames.has(row.database) &&
                payload.databases.find(({ name }) => name === row.database)
                    ?.detailsState === "available" &&
                (index === 0 || compareTableHealthRows(rows[index - 1]!, row) < 0)
        ) &&
        payload.statements.every((row, index) => row.rank === index + 1) &&
        payload.statements.every(
            (row, index, rows) =>
                index === 0 || compareStatementRows(rows[index - 1]!, row) <= 0
        ) &&
        (payload.summary.pgStatStatementsEnabled || payload.statements.length === 0) &&
        payload.summary.totalDatabaseSizeBytes ===
            payload.databases.reduce((total, row) => total + row.sizeBytes, 0) &&
        payload.summary.averageCacheHitRatio === expectedAverageCacheHitRatio &&
        payload.summary.activeConnections + payload.summary.idleConnections <=
            payload.summary.totalConnections &&
        payload.summary.unavailableDatabaseCount ===
            payload.databases.filter(({ detailsState }) => detailsState === "unavailable")
                .length &&
        maintenance.assessmentComplete ===
            (materialTableAssessmentIsComplete(maintenance) &&
                payload.summary.unavailableDatabaseCount === 0) &&
        maintenance.estimatedReclaimableBytes <= maintenance.assessedPhysicalBytes &&
        maintenance.estimatedReclaimablePercent === expectedReclaimablePercent &&
        maintenance.slowStatementCount === visibleSlowStatementCount &&
        maintenance.requiresBloatReview === expectedBloatReview(maintenance) &&
        payload.tableHealth.every(
            (row) =>
                (row.assessment === "assessed") ===
                    (row.estimatedReclaimableBytes !== undefined) &&
                (row.estimatedReclaimableBytes === undefined ||
                    row.estimatedReclaimableBytes <= row.physicalBytes)
        ) &&
        maintenance.status ===
            expectedMaintenanceStatus(
                maintenance,
                payload.summary.pgStatStatementsEnabled
            )
    );
}

/** Strict payload structure before cross-field consistency checks. */
export const databaseObservabilityCachePayloadObjectSchema = v.strictObject({
    databases: v.pipe(
        v.array(databaseObservabilityDatabaseSchema),
        v.minLength(1, "Database observation inventory is absent"),
        v.maxLength(
            databaseObservabilityDatabaseMaximum,
            "Database observation row count is outside its budget"
        )
    ),
    pgbouncer: databaseObservabilityPgBouncerSchema,
    statements: v.pipe(
        v.array(databaseObservabilityStatementSchema),
        v.maxLength(
            databaseObservabilityStatementMaximum,
            "Database statement row count is outside its budget"
        )
    ),
    summary: databaseObservabilitySummarySchema,
    tableHealth: v.pipe(
        v.array(databaseObservabilityTableHealthSchema),
        v.maxLength(
            databaseObservabilityTableHealthMaximum,
            "Database table-health row count is outside its budget"
        )
    ),
    torrentCounts: databaseObservabilityTorrentCountsSchema,
});

/** Strict worker/cache payload shared by the dynamic collector and database domain. */
export const databaseObservabilityCachePayloadSchema = v.pipe(
    databaseObservabilityCachePayloadObjectSchema,
    v.check(
        databaseObservabilityCachePayloadIsConsistent,
        "Database observation payload is inconsistent or outside its budget"
    )
);

export type DatabaseObservabilityCachePayload = v.InferOutput<
    typeof databaseObservabilityCachePayloadSchema
>;

export type DatabaseObservabilityDatabase = v.InferOutput<
    typeof databaseObservabilityDatabaseSchema
>;
export type DatabaseObservabilityTableHealth = v.InferOutput<
    typeof databaseObservabilityTableHealthSchema
>;
export type DatabaseObservabilityStatement = v.InferOutput<
    typeof databaseObservabilityStatementSchema
>;
export type DatabaseObservabilityTorrentCount = v.InferOutput<
    typeof databaseObservabilityTorrentCountSchema
>;

const postgresqlObservationValueEntries =
    databaseObservabilityCachePayloadObjectSchema.entries;
const postgresqlObservationVariantSchema = v.variant("state", [
    v.strictObject({ state: v.literal("unavailable") }),
    v.strictObject({
        ...postgresqlObservationValueEntries,
        observedAtMs: databaseObservabilityTimestampSchema,
        state: v.literal("fresh"),
    }),
    v.strictObject({
        ...postgresqlObservationValueEntries,
        observedAtMs: databaseObservabilityTimestampSchema,
        staleSinceMs: databaseObservabilityTimestampSchema,
        state: v.literal("last-known-good"),
    }),
]);

type SqliteObservation = v.InferOutput<typeof sqliteObservationVariantSchema>;
type PostgresqlObservation = v.InferOutput<typeof postgresqlObservationVariantSchema>;

function sqliteLifecycleTimestampsAreConsistent(
    checkedAtMs: number,
    observation: SqliteObservation
): boolean {
    if (observation.state === "unavailable") return true;
    const { backupInventory, maintenance, restoreVerification } = observation.lifecycle;
    const restoreMatchesInventory =
        backupInventory.state === "unavailable" ||
        restoreVerification.state === "unavailable" ||
        backupInventory.backups.some(
            (backup) =>
                backup.verificationLevel === "restore-copy-verified" &&
                backup.bytes === restoreVerification.backupBytes &&
                backup.createdAtMs === restoreVerification.backupCreatedAtMs &&
                backup.restoreVerifiedAtMs === restoreVerification.verifiedAtMs
        );
    const retainedBoundaryIsCausal = (boundary: {
        readonly observedAtMs: number;
        readonly staleSinceMs?: number;
    }): boolean =>
        boundary.observedAtMs <= observation.observedAtMs &&
        boundary.observedAtMs <= checkedAtMs &&
        (boundary.staleSinceMs === undefined ||
            (boundary.staleSinceMs >= boundary.observedAtMs &&
                boundary.staleSinceMs <= checkedAtMs));
    return (
        restoreMatchesInventory &&
        (backupInventory.state === "unavailable" ||
            (sqliteBackupInventoryIsConsistent(backupInventory) &&
                retainedBoundaryIsCausal(backupInventory) &&
                backupInventory.backups.every(
                    (backup) =>
                        backup.createdAtMs <= backupInventory.observedAtMs &&
                        (backup.restoreVerifiedAtMs === undefined ||
                            (backup.createdAtMs <= backup.restoreVerifiedAtMs &&
                                backup.restoreVerifiedAtMs <=
                                    backupInventory.observedAtMs))
                ))) &&
        (restoreVerification.state === "unavailable" ||
            (retainedBoundaryIsCausal(restoreVerification) &&
                restoreVerification.backupCreatedAtMs <=
                    restoreVerification.verifiedAtMs &&
                restoreVerification.verifiedAtMs <= restoreVerification.observedAtMs)) &&
        (maintenance.state === "unavailable" ||
            (retainedBoundaryIsCausal(maintenance) &&
                (maintenance.latestSuccessfulAtMs === undefined ||
                    maintenance.latestSuccessfulAtMs <= maintenance.observedAtMs) &&
                maintenance.runs.every(
                    (run) =>
                        run.queuedAtMs <= maintenance.observedAtMs &&
                        (run.startedAtMs === undefined ||
                            (run.startedAtMs >= run.queuedAtMs &&
                                run.startedAtMs <= maintenance.observedAtMs)) &&
                        (run.finishedAtMs === undefined ||
                            (run.finishedAtMs >= (run.startedAtMs ?? run.queuedAtMs) &&
                                run.finishedAtMs <= maintenance.observedAtMs))
                )))
    );
}

function sourceObservationIsConsistent(
    checkedAtMs: number,
    observation: SqliteObservation | PostgresqlObservation
): boolean {
    const tableTimestampsAreCausal =
        observation.state === "unavailable" ||
        !("tableHealth" in observation) ||
        observation.tableHealth.every(
            (row) =>
                (row.lastAutovacuumAtMs === undefined ||
                    row.lastAutovacuumAtMs <= observation.observedAtMs) &&
                (row.lastAutoanalyzeAtMs === undefined ||
                    row.lastAutoanalyzeAtMs <= observation.observedAtMs)
        );
    return (
        tableTimestampsAreCausal &&
        (observation.state === "unavailable" ||
            (observation.observedAtMs <= checkedAtMs &&
                (observation.state !== "last-known-good" ||
                    (observation.staleSinceMs >= observation.observedAtMs &&
                        observation.staleSinceMs <= checkedAtMs))))
    );
}

/**
 * @param overview Independent source states and their shared response clock.
 * @returns Whether both independently available source timestamps are causal.
 */
export function databaseOverviewIsConsistent(overview: {
    readonly checkedAtMs: number;
    readonly postgresql: PostgresqlObservation;
    readonly sqlite: SqliteObservation;
}): boolean {
    return (
        sourceObservationIsConsistent(overview.checkedAtMs, overview.sqlite) &&
        sqliteLifecycleTimestampsAreConsistent(overview.checkedAtMs, overview.sqlite) &&
        sourceObservationIsConsistent(overview.checkedAtMs, overview.postgresql) &&
        (overview.postgresql.state === "unavailable" ||
            databaseObservabilityCachePayloadIsConsistent(overview.postgresql))
    );
}

/** Identity-free, read-only Dashboard and external database observability projection. */
export const databaseOverviewSchema = v.pipe(
    v.strictObject({
        checkedAtMs: databaseObservabilityTimestampSchema,
        postgresql: postgresqlObservationVariantSchema,
        sqlite: sqliteObservationVariantSchema,
    }),
    v.check(databaseOverviewIsConsistent, "Database overview timestamps are inconsistent")
);

export type DatabaseOverview = v.InferOutput<typeof databaseOverviewSchema>;
export type SqliteLifecycleObservation = v.InferOutput<
    typeof sqliteLifecycleObservationSchema
>;
export type SqliteMaintenanceJobResult = v.InferOutput<
    typeof sqliteMaintenanceJobResultSchema
>;
/** Worker-only fixed maintenance authority; web composition never receives this port. */
export interface SqliteMaintenanceExecutionPort {
    run(signal?: AbortSignal): Promise<SqliteMaintenanceJobResult>;
}
export type SqliteConnectionPolicy = v.InferOutput<typeof sqliteConnectionPolicySchema>;
export type SqliteMigrationState = v.InferOutput<typeof sqliteMigrationStateSchema>;
export type SqliteStorageObservation = v.InferOutput<
    typeof sqliteStorageObservationSchema
>;

/** Optional empty input accepted by the read-only database overview query. */
export const databaseOverviewInputSchema = v.optional(v.strictObject({}), {});

/** Session-only, identity-free database observability query metadata. */
export const databaseOverviewContract = {
    access: {
        capabilities: ["database:read"],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "database",
    errors: ["FORBIDDEN", "UNAUTHORIZED"],
    input: databaseOverviewInputSchema,
    inputSchemaId: "database.overview.input",
    kind: "query",
    name: "database.overview",
    output: databaseOverviewSchema,
    outputSchemaId: "database.overview.output",
    summary:
        "Returns bounded independent SQLite and PostgreSQL/PgBouncer observations without users, connection identities, SQL text, paths, credentials, or raw failures.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Database observability procedures available for explicit router composition. */
export const databaseProcedureContracts = [databaseOverviewContract] as const;
