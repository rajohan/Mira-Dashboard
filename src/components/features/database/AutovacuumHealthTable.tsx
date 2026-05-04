import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

const columnHelper = createColumnHelper<DatabaseOverviewResponse["deadTuples"][number]>();

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
        header: "Last autovacuum",
        cell: (info) => info.getValue() || "—",
    }),
];

export function AutovacuumHealthTable({
    data,
}: {
    data: DatabaseOverviewResponse["deadTuples"];
}) {
    return (
        <DatabaseTableShell
            data={data}
            columns={columns}
            emptyMessage="No autovacuum/dead tuple issues found right now."
        />
    );
}
