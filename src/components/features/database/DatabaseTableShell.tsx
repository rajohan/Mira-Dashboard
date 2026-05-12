import {
    type ColumnDef,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

/** Represents props. */
interface Props<T extends object> {
    data: T[];
    // TanStack column definitions are invariant in TValue; the shell accepts mixed accessor value types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    columns: ColumnDef<T, any>[];
    emptyMessage?: string;
    maxHeight?: string;
    onRowClick?: (row: T) => void;
    renderMobileCard?: (row: T) => ReactNode;
}

/** Renders the database table shell UI. */
export function DatabaseTableShell<T extends object>({
    data,
    columns,
    emptyMessage = "No data available.",
    maxHeight = "420px",
    onRowClick,
    renderMobileCard,
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
                <>
                    {renderMobileCard ? (
                        <div className="space-y-3 p-3 md:hidden">
                            {table.getRowModel().rows.map((row) => (
                                <div
                                    key={row.id}
                                    role={onRowClick ? "button" : undefined}
                                    tabIndex={onRowClick ? 0 : undefined}
                                    className={[
                                        "border-primary-700 bg-primary-900/40 rounded-lg border p-3",
                                        onRowClick
                                            ? "hover:bg-primary-800/50 cursor-pointer"
                                            : "",
                                    ].join(" ")}
                                    onClick={
                                        onRowClick
                                            ? () => onRowClick(row.original)
                                            : undefined
                                    }
                                    onKeyDown={
                                        onRowClick
                                            ? (event) => {
                                                  if (
                                                      event.key === "Enter" ||
                                                      event.key === " "
                                                  ) {
                                                      event.preventDefault();
                                                      onRowClick(row.original);
                                                  }
                                              }
                                            : undefined
                                    }
                                >
                                    {renderMobileCard(row.original)}
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <div
                        className={[
                            "overflow-auto",
                            renderMobileCard ? "hidden md:block" : "",
                        ].join(" ")}
                        style={{ maxHeight }}
                    >
                        <table className="min-w-[760px] text-sm lg:min-w-full">
                            <thead className="bg-primary-900/95 text-primary-300 sticky top-0 z-10 text-left backdrop-blur">
                                {table.getHeaderGroups().map((headerGroup) => (
                                    <tr key={headerGroup.id}>
                                        {headerGroup.headers.map((header) => (
                                            <th
                                                key={header.id}
                                                className="px-4 py-3 align-top"
                                            >
                                                {header.column.getCanSort() ? (
                                                    <button
                                                        type="button"
                                                        className="hover:text-primary-100 flex items-center gap-1 select-none"
                                                        onClick={header.column.getToggleSortingHandler()}
                                                    >
                                                        {flexRender(
                                                            header.column.columnDef
                                                                .header,
                                                            header.getContext()
                                                        )}
                                                        <span className="text-primary-500">
                                                            {header.column.getIsSorted() ===
                                                            "asc" ? (
                                                                <ChevronDown className="h-3 w-3" />
                                                            ) : header.column.getIsSorted() ===
                                                              "desc" ? (
                                                                <ChevronDown className="h-3 w-3 rotate-180" />
                                                            ) : null}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    <div>
                                                        {flexRender(
                                                            header.column.columnDef
                                                                .header,
                                                            header.getContext()
                                                        )}
                                                    </div>
                                                )}
                                            </th>
                                        ))}
                                    </tr>
                                ))}
                            </thead>
                            <tbody>
                                {table.getRowModel().rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        className={[
                                            "border-primary-700/50 hover:bg-primary-700/30 border-b",
                                            onRowClick ? "cursor-pointer" : "",
                                        ].join(" ")}
                                        onClick={
                                            onRowClick
                                                ? () => onRowClick(row.original)
                                                : undefined
                                        }
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <td
                                                key={cell.id}
                                                className="px-4 py-3 align-top"
                                            >
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext()
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </Card>
    );
}
