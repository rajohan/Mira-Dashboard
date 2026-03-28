import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

interface DatabaseRow {
    datname: string;
    size_pretty: string;
    size_bytes: string;
    numbackends: string;
    cache_hit_ratio: string;
    user: string;
    cl_active: string;
    cl_waiting: string;
    sv_active: string;
    sv_idle: string;
    sv_used: string;
    maxwait: string;
    pool_mode: string;
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
            user: pool?.user ?? "—",
            cl_active: pool?.cl_active ?? "—",
            cl_waiting: pool?.cl_waiting ?? "—",
            sv_active: pool?.sv_active ?? "—",
            sv_idle: pool?.sv_idle ?? "—",
            sv_used: pool?.sv_used ?? "—",
            maxwait: pool?.maxwait ?? "—",
            pool_mode: pool?.pool_mode ?? "—",
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
    columnHelper.accessor("user", { header: "User" }),
    columnHelper.accessor((row) => Number(row.cl_active), {
        id: "clients",
        header: "Clients",
    }),
    columnHelper.accessor((row) => Number(row.cl_waiting), {
        id: "waiting",
        header: "Waiting",
    }),
    columnHelper.accessor(
        (row) => Number(row.sv_active) + Number(row.sv_idle) + Number(row.sv_used),
        {
            id: "servers",
            header: "Servers",
        }
    ),
    columnHelper.accessor((row) => Number(row.maxwait), {
        id: "maxwait",
        header: "Maxwait",
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
