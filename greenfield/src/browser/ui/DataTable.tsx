import type { ReactTable, Row, RowData, TableFeatures } from "@tanstack/react-table";
import { useEffect, useRef, type RefObject } from "react";

import { cn } from "../lib/classNames.ts";

export interface DataTableRowWindow {
    readonly getVirtualItemForOffset: (
        offset: number
    ) => Readonly<{ index: number }> | undefined;
    readonly measure: () => void;
    readonly measureElement: (node: HTMLTableRowElement | null) => void;
    readonly scrollToIndex: (
        index: number,
        options?: Readonly<{ align?: "auto" | "center" | "end" | "start" }>
    ) => void;
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
    const leafHeaders = table.getLeafHeaders();
    const visibleColumnCount = leafHeaders.length || 1;
    const headerByColumnId = new Map(
        leafHeaders.map((header) => [header.column.id, header] as const)
    );
    const firstVirtualItem = rowWindow?.virtualItems.at(0);
    const lastVirtualItem = rowWindow?.virtualItems.at(-1);
    const topSpacerHeight = firstVirtualItem?.start ?? 0;
    const bottomSpacerHeight =
        rowWindow === undefined
            ? 0
            : Math.max(0, rowWindow.totalSize - (lastVirtualItem?.end ?? 0));
    const queryContainerRef = useRef<HTMLDivElement>(null);
    const tableElementRef = useRef<HTMLTableElement>(null);
    const getVirtualItemForOffset = rowWindow?.getVirtualItemForOffset;
    const measureRows = rowWindow?.measure;
    const scrollToIndex = rowWindow?.scrollToIndex;

    useEffect(() => {
        const queryContainer = queryContainerRef.current;
        const scrollContainer = scrollContainerRef?.current;
        const tableElement = tableElementRef.current;
        if (
            getVirtualItemForOffset === undefined ||
            measureRows === undefined ||
            scrollToIndex === undefined ||
            queryContainer === null ||
            scrollContainer == null ||
            tableElement === null ||
            typeof ResizeObserver === "undefined"
        ) {
            return;
        }

        let measureFrame: number | undefined;
        let restoreFrame: number | undefined;
        let usesCardLayout = getComputedStyle(tableElement).display === "block";
        const observer = new ResizeObserver(() => {
            const nextUsesCardLayout = getComputedStyle(tableElement).display === "block";
            if (nextUsesCardLayout === usesCardLayout) return;
            usesCardLayout = nextUsesCardLayout;
            if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
            if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
            const anchorIndex = getVirtualItemForOffset(scrollContainer.scrollTop)?.index;
            measureFrame = requestAnimationFrame(() => {
                measureRows();
                if (anchorIndex !== undefined) {
                    restoreFrame = requestAnimationFrame(() =>
                        scrollToIndex(anchorIndex, { align: "start" })
                    );
                }
            });
        });
        observer.observe(queryContainer);

        return () => {
            observer.disconnect();
            if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
            if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
        };
    }, [getVirtualItemForOffset, measureRows, scrollContainerRef, scrollToIndex]);

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
                className={cn(
                    "dashboard-data-table-row border-primary-700 border-b text-sm"
                )}
                data-index={virtualItem?.index}
                key={row.id}
                ref={virtualItem === undefined ? undefined : rowWindow?.measureElement}
            >
                {row.getAllCells().map((cell) => (
                    <td className="dashboard-data-table-cell min-w-0 p-3" key={cell.id}>
                        <div
                            aria-hidden="true"
                            className="dashboard-data-table-label text-primary-400"
                        >
                            {(() => {
                                const header = headerByColumnId.get(cell.column.id);
                                return header === undefined || header.isPlaceholder ? (
                                    cell.column.id
                                ) : (
                                    <table.FlexRender header={header} />
                                );
                            })()}
                        </div>
                        <div className="dashboard-data-table-value">
                            <table.FlexRender cell={cell} />
                        </div>
                    </td>
                ))}
            </tr>
        );
    }

    return (
        <div
            className="dashboard-data-table-query-container w-full max-w-full min-w-0"
            ref={queryContainerRef}
        >
            <section
                aria-label={label}
                className={cn(
                    "dashboard-data-table-container border-primary-700 w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg border",
                    rowWindow === undefined
                        ? undefined
                        : [
                              "max-h-128 overflow-y-auto outline-none [-webkit-overflow-scrolling:touch]",
                              "focus-visible:border-accent-400 focus-visible:ring-accent-400/30 focus-visible:ring-2",
                          ],
                    scrollClassName
                )}
                data-virtualized={rowWindow === undefined ? undefined : "true"}
                ref={scrollContainerRef}
                tabIndex={rowWindow === undefined ? undefined : 0}
            >
                <table
                    aria-label={label}
                    aria-rowcount={headerGroups.length + rows.length}
                    className={cn(
                        "dashboard-data-table w-full min-w-full border-separate border-spacing-0",
                        tableClassName
                    )}
                    ref={tableElementRef}
                >
                    <thead className="dashboard-data-table-head bg-primary-950 sticky top-0 z-20 shadow-sm">
                        {headerGroups.map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
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
                    <tbody className="dashboard-data-table-body">
                        {topSpacerHeight > 0 && (
                            <tr
                                aria-hidden="true"
                                className="dashboard-data-table-spacer-row"
                            >
                                <td
                                    className="dashboard-data-table-spacer-cell border-0 p-0"
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
                            <tr
                                aria-hidden="true"
                                className="dashboard-data-table-spacer-row"
                            >
                                <td
                                    className="dashboard-data-table-spacer-cell border-0 p-0"
                                    colSpan={visibleColumnCount}
                                    height={bottomSpacerHeight}
                                />
                            </tr>
                        )}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
