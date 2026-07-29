import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

const numberRecordSchema = v.record(v.string(), finiteNumberSchema);
const requiredString = v.string();

export const postgresDatabaseSummarySchema = v.strictObject({
    blks_hit: requiredString,
    blks_read: requiredString,
    cache_hit_ratio: requiredString,
    datname: requiredString,
    numbackends: requiredString,
    size_bytes: requiredString,
    size_pretty: requiredString,
    xact_commit: requiredString,
    xact_rollback: requiredString,
});

export const postgresDeadTupleSummarySchema = v.strictObject({
    database: v.optional(requiredString),
    dead_pct: requiredString,
    last_autoanalyze: v.optional(requiredString),
    last_autovacuum: v.optional(requiredString),
    n_dead_tup: requiredString,
    n_live_tup: requiredString,
    relname: requiredString,
    schemaname: requiredString,
});

export const postgresBloatEstimateSchema = v.strictObject({
    assessed: requiredString,
    database: requiredString,
    estimated_reclaimable_bytes: requiredString,
    physical_bytes: requiredString,
    relname: requiredString,
    schemaname: requiredString,
});

export const postgresTopQuerySchema = v.strictObject({
    calls: requiredString,
    mean_exec_time: requiredString,
    query: requiredString,
    rows: requiredString,
    shared_blks_hit: requiredString,
    shared_blks_read: requiredString,
    total_exec_time: requiredString,
});

export const pgBouncerPoolSummarySchema = v.strictObject({
    cl_active: requiredString,
    cl_waiting: requiredString,
    database: requiredString,
    maxwait: requiredString,
    pool_mode: requiredString,
    sv_active: requiredString,
    sv_idle: requiredString,
    sv_used: requiredString,
    user: requiredString,
});

export const pgBouncerStatsSummarySchema = v.strictObject({
    avg_query_time: requiredString,
    avg_xact_time: requiredString,
    database: requiredString,
    total_query_count: requiredString,
    total_query_time: requiredString,
    total_received: requiredString,
    total_sent: requiredString,
    total_xact_count: requiredString,
    total_xact_time: requiredString,
});

export const databaseMaintenanceSummarySchema = v.strictObject({
    estimatedReclaimableBytes: finiteNumberSchema,
    estimatedReclaimablePercent: finiteNumberSchema,
    highDeadTupleTableCount: finiteNumberSchema,
    hintCount: finiteNumberSchema,
    isBloatAssessmentIncomplete: v.boolean(),
    physicalTableBytes: finiteNumberSchema,
    requiresBloatReview: v.boolean(),
    reviewMinimumBytes: finiteNumberSchema,
    reviewThresholdBytes: finiteNumberSchema,
    reviewThresholdPercent: finiteNumberSchema,
    slowQueryCount: finiteNumberSchema,
    status: v.picklist(["healthy", "not_assessed", "review"]),
    unassessedPhysicalBytes: finiteNumberSchema,
    unassessedTableCount: finiteNumberSchema,
});

export const databaseOverviewSummarySchema = v.strictObject({
    averageCacheHitRatio: finiteNumberSchema,
    connections: numberRecordSchema,
    maintenance: v.optional(databaseMaintenanceSummarySchema),
    managedDatabaseCount: v.optional(finiteNumberSchema),
    pgStatStatementsEnabled: v.boolean(),
    pgbouncer: v.strictObject({
        avgQueryTime: finiteNumberSchema,
        avgTransactionTime: finiteNumberSchema,
        clientConnections: finiteNumberSchema,
        maxWait: finiteNumberSchema,
        serverConnections: finiteNumberSchema,
        waitingClients: finiteNumberSchema,
    }),
    torrentCounts: v.strictObject({
        bitmagnet: finiteNumberSchema,
        comet: finiteNumberSchema,
    }),
    totalBackends: finiteNumberSchema,
    totalDatabaseSizeBytes: finiteNumberSchema,
    totalManagedDatabaseSizeBytes: v.optional(finiteNumberSchema),
});

const sqliteBackupSchema = v.strictObject({
    count: finiteNumberSchema,
    current: v.boolean(),
    latest: v.optional(
        v.strictObject({
            bytes: finiteNumberSchema,
            createdAt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
            kind: v.picklist(["cutover", "pre-deploy", "pre-migration", "scheduled"]),
            name: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        })
    ),
    latestAgeHours: v.optional(finiteNumberSchema),
    reviewAgeHours: finiteNumberSchema,
});

export const sqliteOverviewSchema = v.strictObject({
    attention: v.array(v.string()),
    backup: sqliteBackupSchema,
    databaseBytes: finiteNumberSchema,
    fileName: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    freeBytes: finiteNumberSchema,
    freePages: finiteNumberSchema,
    freePercent: finiteNumberSchema,
    foreignKeysEnabled: v.boolean(),
    journalMode: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    lastMaintenance: v.optional(
        v.strictObject({
            finishedAt: v.optional(v.string()),
            message: v.optional(v.string()),
            startedAt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
            status: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        })
    ),
    migrations: v.strictObject({
        applied: finiteNumberSchema,
        current: v.boolean(),
        latest: finiteNumberSchema,
    }),
    pageCount: finiteNumberSchema,
    pageSize: finiteNumberSchema,
    permissions: v.strictObject({
        dataDirectory: v.optional(v.string()),
        database: v.optional(v.string()),
        secure: v.boolean(),
        shm: v.optional(v.string()),
        wal: v.optional(v.string()),
    }),
    shmBytes: finiteNumberSchema,
    status: v.picklist(["healthy", "review"]),
    storageBytes: finiteNumberSchema,
    walAutoCheckpointPages: finiteNumberSchema,
    walBytes: finiteNumberSchema,
});

export const databaseOverviewResponseSchema = v.strictObject({
    bloatEstimates: v.array(postgresBloatEstimateSchema),
    checkedAt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    databases: v.array(postgresDatabaseSummarySchema),
    deadTuples: v.array(postgresDeadTupleSummarySchema),
    mode: v.optional(v.picklist(["full", "isolated"])),
    overview: databaseOverviewSummarySchema,
    pgbouncerPools: v.array(pgBouncerPoolSummarySchema),
    pgbouncerStats: v.array(pgBouncerStatsSummarySchema),
    postgresSnapshotCheckedAt: v.optional(v.string()),
    sqlite: sqliteOverviewSchema,
    topQueries: v.array(postgresTopQuerySchema),
});

export type PostgresDatabaseSummary = v.InferOutput<typeof postgresDatabaseSummarySchema>;
export type PostgresDeadTupleSummary = v.InferOutput<
    typeof postgresDeadTupleSummarySchema
>;
export type PostgresBloatEstimate = v.InferOutput<typeof postgresBloatEstimateSchema>;
export type PostgresTopQuery = v.InferOutput<typeof postgresTopQuerySchema>;
export type PgBouncerPoolSummary = v.InferOutput<typeof pgBouncerPoolSummarySchema>;
export type PgBouncerStatsSummary = v.InferOutput<typeof pgBouncerStatsSummarySchema>;
export type DatabaseMaintenanceSummary = v.InferOutput<
    typeof databaseMaintenanceSummarySchema
>;
export type DatabaseOverviewSummary = v.InferOutput<typeof databaseOverviewSummarySchema>;
export type SqliteOverview = v.InferOutput<typeof sqliteOverviewSchema>;
export type DatabaseOverviewResponse = v.InferOutput<
    typeof databaseOverviewResponseSchema
>;

/**
 * Parses the complete database summary consumed by the Database page.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the complete database summary consumed by the Database page.
 */
export function parseDatabaseOverviewResponse(
    value: unknown,
    path = "databaseOverview"
): DatabaseOverviewResponse {
    return parseContract(databaseOverviewResponseSchema, value, path);
}
