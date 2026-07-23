import { useCacheEntry } from "./useCache";

/** Represents the database overview API response. */
export interface DatabaseOverviewResponse {
    checkedAt?: string;
    overview: {
        totalDatabaseSizeBytes: number;
        managedDatabaseCount?: number;
        totalManagedDatabaseSizeBytes?: number;
        totalBackends: number;
        averageCacheHitRatio: number;
        connections: Record<string, number>;
        pgStatStatementsEnabled: boolean;
        torrentCounts: {
            comet: number;
            bitmagnet: number;
        };
        pgbouncer: {
            clientConnections: number;
            serverConnections: number;
            waitingClients: number;
            maxWait: number;
            avgQueryTime: number;
            avgTransactionTime: number;
        };
        maintenance?: {
            status: "healthy" | "not_assessed" | "review";
            hintCount: number;
            requiresBloatReview: boolean;
            isBloatAssessmentIncomplete: boolean;
            unassessedTableCount: number;
            unassessedPhysicalBytes: number;
            slowQueryCount: number;
            highDeadTupleTableCount: number;
            physicalTableBytes: number;
            estimatedReclaimableBytes: number;
            estimatedReclaimablePercent: number;
            reviewThresholdBytes: number;
            reviewMinimumBytes: number;
            reviewThresholdPercent: number;
        };
    };
    databases: Array<{
        datname: string;
        size_pretty: string;
        size_bytes: string;
        numbackends: string;
        xact_commit: string;
        xact_rollback: string;
        blks_hit: string;
        blks_read: string;
        cache_hit_ratio: string;
    }>;
    deadTuples: Array<{
        database?: string;
        schemaname: string;
        relname: string;
        n_live_tup: string;
        n_dead_tup: string;
        dead_pct: string;
        last_autovacuum: string;
        last_autoanalyze: string;
    }>;
    bloatEstimates?: Array<{
        database: string;
        schemaname: string;
        relname: string;
        physical_bytes: string;
        estimated_reclaimable_bytes: string;
        assessed: string;
    }>;
    topQueries: Array<{
        query: string;
        calls: string;
        total_exec_time: string;
        mean_exec_time: string;
        rows: string;
        shared_blks_hit: string;
        shared_blks_read: string;
    }>;
    pgbouncerPools: Array<{
        database: string;
        user: string;
        cl_active: string;
        cl_waiting: string;
        sv_active: string;
        sv_idle: string;
        sv_used: string;
        maxwait: string;
        pool_mode: string;
    }>;
    pgbouncerStats: Array<{
        database: string;
        total_xact_count: string;
        total_query_count: string;
        total_xact_time: string;
        total_query_time: string;
        avg_xact_time: string;
        avg_query_time: string;
        total_received: string;
        total_sent: string;
    }>;
    sqlite?: {
        attention: string[];
        backup: {
            count: number;
            current: boolean;
            latest?: {
                bytes: number;
                createdAt: string;
                kind: "pre-deploy" | "pre-migration" | "scheduled";
                name: string;
            };
            latestAgeHours?: number;
            reviewAgeHours: number;
        };
        databaseBytes: number;
        fileName: string;
        freeBytes: number;
        freePages: number;
        freePercent: number;
        foreignKeysEnabled: boolean;
        journalMode: string;
        lastMaintenance?: {
            finishedAt?: string;
            message?: string;
            startedAt: string;
            status: string;
        };
        migrations: {
            applied: number;
            current: boolean;
            latest: number;
        };
        pageCount: number;
        pageSize: number;
        permissions: {
            dataDirectory?: string;
            database?: string;
            secure: boolean;
            shm?: string;
            wal?: string;
        };
        shmBytes: number;
        status: "healthy" | "review";
        storageBytes: number;
        walAutoCheckpointPages: number;
        walBytes: number;
    };
}

function isDatabaseOverviewResponse(value: unknown): value is DatabaseOverviewResponse {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DatabaseOverviewResponse>;
    return (
        !!candidate.overview &&
        typeof candidate.overview === "object" &&
        Array.isArray(candidate.databases) &&
        Array.isArray(candidate.deadTuples) &&
        Array.isArray(candidate.topQueries) &&
        Array.isArray(candidate.pgbouncerPools) &&
        Array.isArray(candidate.pgbouncerStats)
    );
}

/** Provides database overview. */
export function useDatabaseOverview() {
    const query = useCacheEntry<DatabaseOverviewResponse>("database.summary", 60_000, {
        refreshOnMissing: true,
    });
    const cacheEnvelope = query.data;
    const data =
        cacheEnvelope &&
        (cacheEnvelope.status === "fresh" || cacheEnvelope.status === "error") &&
        isDatabaseOverviewResponse(cacheEnvelope.data)
            ? cacheEnvelope.data
            : undefined;
    const error =
        query.error ??
        (cacheEnvelope?.status === "error"
            ? new Error(cacheEnvelope.errorMessage || "Database metrics refresh failed.")
            : undefined);
    return { ...query, data, error };
}
