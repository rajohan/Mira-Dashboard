import { createColumnHelper } from "@tanstack/react-table";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseTableShell } from "./DatabaseTableShell";

const columnHelper = createColumnHelper<DatabaseOverviewResponse["pgbouncerPools"][number]>();

const columns = [
    columnHelper.accessor("database", { header: "Database" }),
    columnHelper.accessor("user", { header: "User" }),
    columnHelper.accessor((row) => Number(row.cl_active), {
        id: "clients",
        header: "Clients",
        cell: (info) => info.row.original.cl_active,
    }),
    columnHelper.accessor((row) => Number(row.cl_waiting), {
        id: "waiting",
        header: "Waiting",
        cell: (info) => info.row.original.cl_waiting,
    }),
    columnHelper.accessor(
        (row) => Number(row.sv_active) + Number(row.sv_idle) + Number(row.sv_used),
        {
            id: "servers",
            header: "Servers",
            cell: (info) =>
                String(
                    Number(info.row.original.sv_active) +
                        Number(info.row.original.sv_idle) +
                        Number(info.row.original.sv_used)
                ),
        }
    ),
    columnHelper.accessor((row) => Number(row.maxwait), {
        id: "maxwait",
        header: "Maxwait",
        cell: (info) => info.row.original.maxwait,
    }),
];

export function PgBouncerPoolsTable({ data }: { data: DatabaseOverviewResponse["pgbouncerPools"] }) {
    return <DatabaseTableShell data={data} columns={columns} />;
}
