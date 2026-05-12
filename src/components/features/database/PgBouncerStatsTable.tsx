import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

const columnHelper =
    createColumnHelper<DatabaseOverviewResponse["pgbouncerStats"][number]>();

const columns = [
    columnHelper.accessor("database", { header: "Database" }),
    columnHelper.accessor((row) => Number(row.avg_query_time), {
        id: "avgQuery",
        header: "Avg query",
        cell: (info) => info.row.original.avg_query_time,
    }),
    columnHelper.accessor((row) => Number(row.avg_xact_time), {
        id: "avgTransaction",
        header: "Avg transaction",
        cell: (info) => info.row.original.avg_xact_time,
    }),
    columnHelper.accessor((row) => Number(row.total_query_count), {
        id: "queries",
        header: "Queries",
        cell: (info) => info.row.original.total_query_count,
    }),
];

export function PgBouncerStatsTable({
    data,
}: {
    data: DatabaseOverviewResponse["pgbouncerStats"];
}) {
    return <DatabaseTableShell data={data} columns={columns} />;
}
