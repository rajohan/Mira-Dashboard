import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

interface DatabaseRow {
    datname: string;
    size_pretty: string;
    size_bytes: string;
    numbackends: string;
    cache_hit_ratio: string;
    xact_commit: string;
    xact_rollback: string;
    cl_active: number;
    cl_waiting: number;
    sv_active: number;
    sv_idle: number;
    sv_used: number;
    maxwait: number;
}

function mergeWithPoolData(
    databases: DatabaseOverviewResponse["databases"],
    pools: DatabaseOverviewResponse["pgbouncerPools"],
): DatabaseRow[] {
    const poolMap = new Map<string, DatabaseOverviewResponse["pgbouncerPools"][number]>();
    for (const pool of pools) {
        poolMap.set(pool.database, pool);
    }

    return databases.map((db) => {
        const pool = poolMap.get(db.datname);
        return {
            ...db,
            cl_active: Number(pool?.cl_active ?? 0),
            cl_waiting: Number(pool?.cl_waiting ?? 0),
            sv_active: Number(pool?.sv_active ?? 0),
            sv_idle: Number(pool?.sv_idle ?? 0),
            sv_used: Number(pool?.sv_used ?? 0),
            maxwait: Number(pool?.maxwait ?? 0),
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
        id: "backends",
        header: "Backends",
    }),
    columnHelper.accessor((row) => Number(row.cache_hit_ratio), {
        id: "cacheHit",
        header: "Cache hit",
        cell: (info) => `${info.row.original.cache_hit_ratio}%`,
    }),
    columnHelper.accessor((row) => row.cl_active + row.cl_waiting, {
        id: "clients",
        header: "Clients",
        cell: (info) => {
            const row = info.row.original;
            return row.cl_active + row.cl_waiting > 0
                ? `${row.cl_active} / ${row.cl_waiting}w`
                : "—";
        },
    }),
    columnHelper.accessor((row) => row.sv_active + row.sv_idle + row.sv_used, {
        id: "servers",
        header: "Servers",
    }),
    columnHelper.accessor((row) => Number(row.xact_commit), {
        id: "commits",
        header: "Commits",
    }),
    columnHelper.accessor((row) => Number(row.xact_rollback), {
        id: "rollbacks",
        header: "Rollbacks",
    }),
];

interface Props {
    databases: DatabaseOverviewResponse["databases"];
    pools: DatabaseOverviewResponse["pgbouncerPools"];
}

export function DatabasesTable({ databases, pools }: Props) {
    const data = mergeWithPoolData(databases, pools);
    return <DatabaseTableShell data={data} columns={columns} />;
}
