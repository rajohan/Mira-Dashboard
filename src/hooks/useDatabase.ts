import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

/** Represents the database overview API response. */
export interface DatabaseOverviewResponse {
    overview: {
        totalDatabaseSizeBytes: number;
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
        schemaname: string;
        relname: string;
        n_live_tup: string;
        n_dead_tup: string;
        dead_pct: string;
        last_autovacuum: string;
        last_autoanalyze: string;
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
}

/** Provides database overview. */
export function useDatabaseOverview() {
    return useQuery({
        queryKey: ["database", "overview"],
        queryFn: () => apiFetch<DatabaseOverviewResponse>("/database/overview"),
        refetchInterval: 15_000,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
    });
}
