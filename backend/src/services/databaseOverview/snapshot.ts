import type {
    DatabaseOverviewResponse,
    PgBouncerPoolSummary,
    PgBouncerStatsSummary,
    PostgresDeadTupleSummary,
} from "../../../../contracts/database.ts";
import { getDashboardSqliteOverview } from "../sqliteOverview.ts";
import {
    BLOAT_REVIEW_BYTES,
    BLOAT_REVIEW_MINIMUM_BYTES,
    BLOAT_REVIEW_PERCENT,
} from "./policy.ts";

/**
 * Projects a PostgreSQL table-health row onto the public response contract.
 * @param row PostgreSQL table-health row.
 * @returns Contract-safe PostgreSQL table-health row.
 */
export function projectDeadTupleRow(
    row: PostgresDeadTupleSummary
): PostgresDeadTupleSummary {
    return {
        ...(row.database === undefined ? {} : { database: row.database }),
        dead_pct: row.dead_pct,
        ...(row.last_autoanalyze === undefined
            ? {}
            : { last_autoanalyze: row.last_autoanalyze }),
        ...(row.last_autovacuum === undefined
            ? {}
            : { last_autovacuum: row.last_autovacuum }),
        n_dead_tup: row.n_dead_tup,
        n_live_tup: row.n_live_tup,
        relname: row.relname,
        schemaname: row.schemaname,
    };
}

/**
 * Projects a dynamic PgBouncer pool row onto the fields consumed by the UI.
 * @param row PgBouncer pool row.
 * @returns Contract-safe PgBouncer pool row.
 */
export function projectPgBouncerPoolRow(row: PgBouncerPoolSummary): PgBouncerPoolSummary {
    return {
        cl_active: row.cl_active,
        cl_waiting: row.cl_waiting,
        database: row.database,
        maxwait: row.maxwait,
        pool_mode: row.pool_mode,
        sv_active: row.sv_active,
        sv_idle: row.sv_idle,
        sv_used: row.sv_used,
        user: row.user,
    };
}

/**
 * Projects a dynamic PgBouncer statistics row onto the public response contract.
 * @param row PgBouncer statistics row.
 * @returns Contract-safe PgBouncer statistics row.
 */
export function projectPgBouncerStatsRow(
    row: PgBouncerStatsSummary
): PgBouncerStatsSummary {
    return {
        avg_query_time: row.avg_query_time,
        avg_xact_time: row.avg_xact_time,
        database: row.database,
        total_query_count: row.total_query_count,
        total_query_time: row.total_query_time,
        total_received: row.total_received,
        total_sent: row.total_sent,
        total_xact_count: row.total_xact_count,
        total_xact_time: row.total_xact_time,
    };
}

/**
 * Parses tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array.
 * @param output Output value.
 * @returns Parsed tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array.
 */
type DatabaseOverviewSnapshot = Omit<DatabaseOverviewResponse, "checkedAt" | "mode"> & {
    checkedAt?: string;
    mode?: "full" | "isolated";
};

function isDatabaseOverviewSnapshot(value: unknown): value is DatabaseOverviewSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<DatabaseOverviewSnapshot>;
    return (
        Boolean(candidate.overview) &&
        typeof candidate.overview === "object" &&
        Array.isArray(candidate.databases) &&
        Array.isArray(candidate.deadTuples) &&
        Array.isArray(candidate.bloatEstimates) &&
        Array.isArray(candidate.topQueries) &&
        Array.isArray(candidate.pgbouncerPools) &&
        Array.isArray(candidate.pgbouncerStats)
    );
}

/**
 * Refreshes only the isolated Dashboard SQLite metrics while retaining copied host data.
 * @param snapshot Snapshot value.
 * @returns Isolated database overview value.
 */
export function getIsolatedDatabaseOverview(snapshot: unknown) {
    const sqlite = getDashboardSqliteOverview();
    const previous: DatabaseOverviewSnapshot = isDatabaseOverviewSnapshot(snapshot)
        ? snapshot
        : {
              overview: {
                  totalDatabaseSizeBytes: 0,
                  managedDatabaseCount: 1,
                  totalManagedDatabaseSizeBytes: sqlite.storageBytes,
                  totalBackends: 0,
                  averageCacheHitRatio: 0,
                  connections: {},
                  pgStatStatementsEnabled: false,
                  torrentCounts: { bitmagnet: 0, comet: 0 },
                  pgbouncer: {
                      clientConnections: 0,
                      serverConnections: 0,
                      waitingClients: 0,
                      maxWait: 0,
                      avgQueryTime: 0,
                      avgTransactionTime: 0,
                  },
                  maintenance: {
                      status: "not_assessed",
                      hintCount: 0,
                      requiresBloatReview: false,
                      isBloatAssessmentIncomplete: true,
                      unassessedTableCount: 0,
                      unassessedPhysicalBytes: 0,
                      slowQueryCount: 0,
                      highDeadTupleTableCount: 0,
                      physicalTableBytes: 0,
                      estimatedReclaimableBytes: 0,
                      estimatedReclaimablePercent: 0,
                      reviewThresholdBytes: BLOAT_REVIEW_BYTES,
                      reviewMinimumBytes: BLOAT_REVIEW_MINIMUM_BYTES,
                      reviewThresholdPercent: BLOAT_REVIEW_PERCENT,
                  },
              },
              databases: [],
              deadTuples: [],
              bloatEstimates: [],
              topQueries: [],
              pgbouncerPools: [],
              pgbouncerStats: [],
              sqlite,
          };
    const {
        checkedAt,
        mode: previousMode,
        postgresSnapshotCheckedAt: previousPostgresSnapshotCheckedAt,
        ...previousOverview
    } = previous;
    const postgresSnapshotCheckedAt =
        previousMode === "isolated" ? previousPostgresSnapshotCheckedAt : checkedAt;
    const totalDatabaseSizeBytes =
        Number(previousOverview.overview.totalDatabaseSizeBytes) || 0;

    return {
        ...previousOverview,
        deadTuples: previous.deadTuples.map((row) => projectDeadTupleRow(row)),
        mode: "isolated" as const,
        ...(postgresSnapshotCheckedAt && {
            postgresSnapshotCheckedAt,
        }),
        overview: {
            ...previousOverview.overview,
            managedDatabaseCount: previousOverview.databases.length + 1,
            totalDatabaseSizeBytes,
            totalManagedDatabaseSizeBytes: totalDatabaseSizeBytes + sqlite.storageBytes,
        },
        pgbouncerPools: previous.pgbouncerPools.map((row) =>
            projectPgBouncerPoolRow(row)
        ),
        pgbouncerStats: previous.pgbouncerStats.map((row) =>
            projectPgBouncerStatsRow(row)
        ),
        sqlite,
    };
}
