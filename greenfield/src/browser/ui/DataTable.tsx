import type { ReactTable, Row, RowData, TableFeatures } from "@tanstack/react-table";
import type { RefObject } from "react";

import { cn } from "../lib/classNames.ts";

export interface DataTableRowWindow {
    readonly measureElement: (node: HTMLTableRowElement | null) => void;
    readonly totalSize: number;
    readonly virtualItems: readonly Readonly<{
        end: number;
        index: number;
        start: number;
    }>[];
}

interface DataTableBaseProps<TFeatures extends TableFeatures, TData extends RowData> {
    readonly label: string;
    readonly scrollClassName?: string;
    readonly scrollContainerRef?: RefObject<HTMLDivElement | null>;
    readonly table: ReactTable<TFeatures, TData>;
    readonly tableClassName?: string;
}

type DataTableProps<
    TFeatures extends TableFeatures,
    TData extends RowData,
> = DataTableBaseProps<TFeatures, TData> & Readonly<{ rowWindow?: DataTableRowWindow }>;

/**
 * Renders one TanStack Table instance with shared Dashboard table semantics.
 * It renders every row by default and accepts an optional external row window.
 * @returns A styled table that is independent of sorting and virtualization policy.
 */
export function DataTable<TFeatures extends TableFeatures, TData extends RowData>({
    label,
    rowWindow,
    scrollClassName,
    scrollContainerRef,
    table,
    tableClassName,
}: DataTableProps<TFeatures, TData>) {
    const headerGroups = table.getHeaderGroups();
    const rows = table.getRowModel().rows;
    const visibleColumnCount = headerGroups.at(-1)?.headers.length ?? 1;
    const firstVirtualItem = rowWindow?.virtualItems.at(0);
    const lastVirtualItem = rowWindow?.virtualItems.at(-1);
    const topSpacerHeight = firstVirtualItem?.start ?? 0;
    const bottomSpacerHeight =
        rowWindow === undefined
            ? 0
            : Math.max(0, rowWindow.totalSize - (lastVirtualItem?.end ?? 0));

    function renderRow(
        row: Row<TFeatures, TData>,
        virtualItem?: DataTableRowWindow["virtualItems"][number]
    ) {
        return (
            <tr
                aria-rowindex={
                    virtualItem === undefined
                        ? undefined
                        : headerGroups.length + virtualItem.index + 1
                }
                className={cn("border-primary-700 border-b text-sm")}
                data-index={virtualItem?.index}
                key={row.id}
                ref={virtualItem === undefined ? undefined : rowWindow?.measureElement}
            >
                {row.getAllCells().map((cell) => (
                    <td className="min-w-0 p-3" key={cell.id}>
                        <table.FlexRender cell={cell} />
                    </td>
                ))}
            </tr>
        );
    }

    return (
        <section
            aria-label={label}
            className={cn(
                "border-primary-700 max-h-128 overflow-auto rounded-lg border",
                scrollClassName
            )}
            ref={scrollContainerRef}
        >
            <table
                aria-rowcount={headerGroups.length + rows.length}
                className={cn("w-full", tableClassName)}
            >
                <thead className="bg-primary-900 sticky top-0 z-10 shadow-sm">
                    {headerGroups.map((headerGroup) => (
                        <tr key={headerGroup.id}>
                            {headerGroup.headers.map((header) => (
                                <th
                                    className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                    key={header.id}
                                    scope="col"
                                >
                                    {!header.isPlaceholder && (
                                        <table.FlexRender header={header} />
                                    )}
                                </th>
                            ))}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {topSpacerHeight > 0 && (
                        <tr aria-hidden="true">
                            <td
                                className="border-0 p-0"
                                colSpan={visibleColumnCount}
                                height={topSpacerHeight}
                            />
                        </tr>
                    )}
                    {rowWindow === undefined
                        ? rows.map((row) => renderRow(row))
                        : rowWindow.virtualItems.map((virtualItem) => {
                              const row = rows[virtualItem.index];
                              return row === undefined
                                  ? null
                                  : renderRow(row, virtualItem);
                          })}
                    {bottomSpacerHeight > 0 && (
                        <tr aria-hidden="true">
                            <td
                                className="border-0 p-0"
                                colSpan={visibleColumnCount}
                                height={bottomSpacerHeight}
                            />
                        </tr>
                    )}
                </tbody>
            </table>
        </section>
    );
}
