import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

const columnHelper = createColumnHelper<DatabaseOverviewResponse["databases"][number]>();

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
        cell: (info) => info.row.original.numbackends,
    }),
    columnHelper.accessor((row) => Number(row.cache_hit_ratio), {
        id: "cacheHit",
        header: "Cache hit",
        cell: (info) => `${info.row.original.cache_hit_ratio}%`,
    }),
];

export function DatabaseSizesTable({ data }: { data: DatabaseOverviewResponse["databases"] }) {
    return <DatabaseTableShell data={data} columns={columns} />;
}
