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
            renderMobileCard={(row) => (
                <div>
                    <div className="break-all font-medium text-primary-50">
                        {row.schemaname}.{row.relname}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-primary-300">
                        <div>
                            <div className="text-primary-500">Dead tuples</div>
                            {row.n_dead_tup}
                        </div>
                        <div>
                            <div className="text-primary-500">Dead %</div>
                            {row.dead_pct}%
                        </div>
                    </div>
                    <div className="mt-3 text-xs text-primary-400">
                        Last autovacuum: {row.last_autovacuum || "—"}
                    </div>
                    <div className="mt-1 text-xs text-primary-400">
                        Last autoanalyze: {row.last_autoanalyze || "—"}
                    </div>
                </div>
            )}
        />
    );
}
