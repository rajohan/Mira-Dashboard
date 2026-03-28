import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { EmptyState } from "../../ui/EmptyState";
import { Card } from "../../ui/Card";
import { DatabaseTableShell } from "./DatabaseTableShell";
import { truncateQuery } from "./databaseUtils";

const columnHelper = createColumnHelper<DatabaseOverviewResponse["topQueries"][number]>();

const columns = [
    columnHelper.accessor("query", {
        header: "Query",
        cell: (info) => <span title={info.getValue()}>{truncateQuery(info.getValue())}</span>,
    }),
    columnHelper.accessor((row) => Number(row.calls), {
        id: "calls",
        header: "Calls",
        cell: (info) => info.row.original.calls,
    }),
    columnHelper.accessor((row) => Number(row.total_exec_time), {
        id: "totalMs",
        header: "Total ms",
        cell: (info) => info.row.original.total_exec_time,
    }),
    columnHelper.accessor((row) => Number(row.mean_exec_time), {
        id: "meanMs",
        header: "Mean ms",
        cell: (info) => info.row.original.mean_exec_time,
    }),
    columnHelper.accessor((row) => Number(row.rows), {
        id: "rows",
        header: "Rows",
        cell: (info) => info.row.original.rows,
    }),
];

export function TopQueriesTable({
    enabled,
    data,
}: {
    enabled: boolean;
    data: DatabaseOverviewResponse["topQueries"];
}) {
    if (!enabled) {
        return (
            <Card className="overflow-hidden">
                <EmptyState message="pg_stat_statements is not enabled." />
            </Card>
        );
    }

    return <DatabaseTableShell data={data} columns={columns} maxHeight="520px" />;
}
