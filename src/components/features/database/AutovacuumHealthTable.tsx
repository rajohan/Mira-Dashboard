import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

interface MaintenanceRow {
    schemaname: string;
    relname: string;
    n_dead_tup: string;
    dead_pct: string;
    last_autovacuum: string | null;
    last_autoanalyze: string | null;
    avg_query_time: number;
    avg_xact_time: number;
    total_query_count: number;
}

function mergeMaintenanceData(
    deadTuples: DatabaseOverviewResponse["deadTuples"],
    pgbouncerStats: DatabaseOverviewResponse["pgbouncerStats"],
): MaintenanceRow[] {
    const statsMap = new Map<string, DatabaseOverviewResponse["pgbouncerStats"][number]>();
    for (const stat of pgbouncerStats) {
        statsMap.set(stat.database, stat);
    }

    return deadTuples.map((row) => {
        const stat = statsMap.get(row.schemaname);
        return {
            ...row,
            avg_query_time: Number(stat?.avg_query_time ?? 0),
            avg_xact_time: Number(stat?.avg_xact_time ?? 0),
            total_query_count: Number(stat?.total_query_count ?? 0),
        };
    });
}

const columnHelper = createColumnHelper<MaintenanceRow>();

const columns = [
    columnHelper.accessor((row) => `${row.schemaname}.${row.relname}`, {
        id: "table",
        header: "Table",
    }),
    columnHelper.accessor((row) => Number(row.n_dead_tup), {
        id: "deadTuples",
        header: "Dead tuples",
    }),
    columnHelper.accessor((row) => Number(row.dead_pct), {
        id: "deadPct",
        header: "Dead %",
        cell: (info) => `${info.row.original.dead_pct}%`,
    }),
    columnHelper.accessor("last_autovacuum", {
        header: "Last vacuum",
        cell: (info) => info.getValue() || "—",
    }),
    columnHelper.accessor((row) => row.avg_query_time, {
        id: "avgQuery",
        header: "Avg query ms",
        cell: (info) => info.getValue() > 0 ? info.getValue().toFixed(2) : "—",
    }),
    columnHelper.accessor((row) => row.total_query_count, {
        id: "totalQueries",
        header: "Queries",
        cell: (info) => info.getValue() > 0 ? info.getValue().toLocaleString() : "—",
    }),
];

interface Props {
    deadTuples: DatabaseOverviewResponse["deadTuples"];
    pgbouncerStats: DatabaseOverviewResponse["pgbouncerStats"];
}

export function MaintenanceTable({ deadTuples, pgbouncerStats }: Props) {
    const data = mergeMaintenanceData(deadTuples, pgbouncerStats);
    return (
        <DatabaseTableShell
            data={data}
            columns={columns}
            emptyMessage="No maintenance issues found."
        />
    );
}
