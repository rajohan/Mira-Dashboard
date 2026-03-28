import {
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type ColumnDef,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

interface Props<T extends object> {
    data: T[];
    columns: ColumnDef<T, any>[];
    emptyMessage?: string;
    maxHeight?: string;
}

export function DatabaseTableShell<T extends object>({
    data,
    columns,
    emptyMessage = "No data available.",
    maxHeight = "420px",
}: Props<T>) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const table = useReactTable({
        data,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    return (
        <Card className="overflow-hidden">
            {data.length === 0 ? (
                <EmptyState message={emptyMessage} />
            ) : (
                <div className="overflow-auto" style={{ maxHeight }}>
                    <table className="min-w-full text-sm">
                        <thead className="sticky top-0 z-10 bg-primary-900/95 text-left text-primary-300 backdrop-blur">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <th key={header.id} className="px-4 py-3 align-top">
                                            {header.column.getCanSort() ? (
                                                <button
                                                    type="button"
                                                    className="flex items-center gap-1 select-none hover:text-primary-100"
                                                    onClick={header.column.getToggleSortingHandler()}
                                                >
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    <span className="text-primary-500">
                                                        {header.column.getIsSorted() === "asc" ? (
                                                            <ChevronDown className="h-3 w-3" />
                                                        ) : header.column.getIsSorted() === "desc" ? (
                                                            <ChevronDown className="h-3 w-3 rotate-180" />
                                                        ) : null}
                                                    </span>
                                                </button>
                                            ) : (
                                                <div>{flexRender(header.column.columnDef.header, header.getContext())}</div>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {table.getRowModel().rows.map((row) => (
                                <tr key={row.id} className="border-b border-primary-700/50 hover:bg-primary-700/30">
                                    {row.getVisibleCells().map((cell) => (
                                        <td key={cell.id} className="px-4 py-3">
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
}
