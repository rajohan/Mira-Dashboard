import {
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type ColumnDef,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

interface Props<T extends object> {
    data: T[];
    columns: ColumnDef<T, any>[];
    emptyMessage?: string;
    maxHeight?: string;
    onRowClick?: (row: T) => void;
}

export function DatabaseTableShell<T extends object>({
    data,
    columns,
    emptyMessage = "No data available.",
    maxHeight = "420px",
    onRowClick,
}: Props<T>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [scrollbarWidth, setScrollbarWidth] = useState(0);
    const [columnWidths, setColumnWidths] = useState<number[]>([]);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const firstRowRef = useRef<HTMLTableRowElement | null>(null);

    const table = useReactTable({
        data,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    useLayoutEffect(() => {
        const measure = () => {
            if (!bodyRef.current) return;
            setScrollbarWidth(bodyRef.current.offsetWidth - bodyRef.current.clientWidth);

            const cells = firstRowRef.current ? Array.from(firstRowRef.current.children) as HTMLElement[] : [];
            if (cells.length > 0) {
                setColumnWidths(cells.map((cell) => cell.getBoundingClientRect().width));
            }
        };

        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [data, columns, sorting, maxHeight]);

    if (data.length === 0) {
        return (
            <Card className="overflow-hidden">
                <EmptyState message={emptyMessage} />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div
                className="border-b border-primary-700/50 bg-primary-900/95 backdrop-blur"
                style={{ paddingRight: scrollbarWidth }}
            >
                <table className="min-w-full text-sm">
                    <thead className="text-left text-primary-300">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header, index) => (
                                    <th
                                        key={header.id}
                                        className="px-4 py-3 align-top"
                                        style={columnWidths[index] ? { width: columnWidths[index] } : undefined}
                                    >
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
                </table>
            </div>

            <div ref={bodyRef} className="overflow-y-auto overflow-x-auto" style={{ maxHeight }}>
                <table className="min-w-full text-sm">
                    <tbody>
                        {table.getRowModel().rows.map((row, rowIndex) => (
                            <tr
                                key={row.id}
                                ref={rowIndex === 0 ? firstRowRef : undefined}
                                className={[
                                    "border-b border-primary-700/50 hover:bg-primary-700/30",
                                    onRowClick ? "cursor-pointer" : "",
                                ].join(" ")}
                                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                            >
                                {row.getVisibleCells().map((cell, cellIndex) => (
                                    <td
                                        key={cell.id}
                                        className="px-4 py-3 align-top"
                                        style={columnWidths[cellIndex] ? { width: columnWidths[cellIndex] } : undefined}
                                    >
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}
