import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

interface DatabaseRow {
    datname: string;
    size_pretty: string;
    size_bytes: string;
    numbackends: string;
    cache_hit_ratio: string;
    cl_active: string;
    cl_waiting: string;
    sv_active: string;
    sv_idle: string;
    sv_used: string;
    avg_query_time: number;
    avg_xact_time: number;
    total_query_count: number;
}

function mergeWithPoolData(
    databases: DatabaseOverviewResponse["databases"],
    pools: DatabaseOverviewResponse["pgbouncerPools"],
    stats: DatabaseOverviewResponse["pgbouncerStats"],
): DatabaseRow[] {
    const poolMap = new Map<string, DatabaseOverviewResponse["pgbouncerPools"][number]>();
    for (const pool of pools) poolMap.set(pool.database, pool);

    const statsMap = new Map<string, DatabaseOverviewResponse["pgbouncerStats"][number]>();
    for (const stat of stats) statsMap.set(stat.database, stat);

    return databases.map((db) => {
        const pool = poolMap.get(db.datname);
        const stat = statsMap.get(db.datname);
        return {
            ...db,
            cl_active: pool?.cl_active ?? "—",
            cl_waiting: pool?.cl_waiting ?? "—",
            sv_active: pool?.sv_active ?? "—",
            sv_idle: pool?.sv_idle ?? "—",
            sv_used: pool?.sv_used ?? "—",
            avg_query_time: Number(stat?.avg_query_time ?? 0),
            avg_xact_time: Number(stat?.avg_xact_time ?? 0),
            total_query_count: Number(stat?.total_query_count ?? 0),
        };
    });
}

const columnHelper = createColumnHelper<DatabaseRow>();

const columns = [
    columnHelper.accessor("datname", { header: "Database" }),
    columnHelper.accessor((row) => Number(row.size_bytes), {
        id: "size",
        header: "Size",
        cell: (info) => info.row.original.size_pretty,
    }),
    columnHelper.accessor((row) => Number(row.numbackends), {
        id: "connections",
        header: "Connections",
    }),
    columnHelper.accessor((row) => Number(row.cache_hit_ratio), {
        id: "cacheHit",
        header: "Cache hit",
        cell: (info) => `${info.row.original.cache_hit_ratio}%`,
    }),
    columnHelper.accessor(
        (row) => `${row.cl_active} / ${row.sv_active + row.sv_idle + row.sv_used}`,
        {
            id: "pool",
            header: "Clients / Servers",
        }
    ),
    columnHelper.accessor((row) => row.avg_query_time, {
        id: "avgQuery",
        header: "Avg query ms",
        cell: (info) => info.getValue() > 0 ? info.getValue().toFixed(2) : "—",
    }),
    columnHelper.accessor((row) => row.avg_xact_time, {
        id: "avgXact",
        header: "Avg xact ms",
        cell: (info) => info.getValue() > 0 ? info.getValue().toFixed(2) : "—",
    }),
    columnHelper.accessor((row) => row.total_query_count, {
        id: "queries",
        header: "Queries",
        cell: (info) => info.getValue() > 0 ? info.getValue().toLocaleString() : "—",
    }),
];

interface Props {
    databases: DatabaseOverviewResponse["databases"];
    pools: DatabaseOverviewResponse["pgbouncerPools"];
    stats: DatabaseOverviewResponse["pgbouncerStats"];
}

export function DatabasesTable({ databases, pools, stats }: Props) {
    const data = mergeWithPoolData(databases, pools, stats);
    return <DatabaseTableShell data={data} columns={columns} />;
}
