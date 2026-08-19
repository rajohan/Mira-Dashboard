import type { ReactTable, Row, RowData, TableFeatures } from "@tanstack/react-table";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    type ReactNode,
    type RefObject,
    type CSSProperties,
    type UIEventHandler,
} from "react";

import { cn } from "../lib/classNames.ts";
import { dashboardDataTableClassNames } from "./dataTableStyles.ts";
import { TableSortButton } from "./TableSortButton.tsx";

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
    readonly columnWidths?: Readonly<Record<string, CSSProperties["width"]>>;
    readonly footer?: ReactNode;
    readonly label: string;
    readonly onScroll?: UIEventHandler<HTMLElement>;
    readonly scrollClassName?: string;
    readonly scrollContainerRef?: RefObject<HTMLDivElement | null>;
    readonly table: ReactTable<TFeatures, TData>;
    readonly tableClassName?: string;
}

type DataTableProps<
    TFeatures extends TableFeatures,
    TData extends RowData,
> = DataTableBaseProps<TFeatures, TData> & Readonly<{ rowWindow?: DataTableRowWindow }>;

interface SortableColumn {
    getCanSort(): boolean;
    getIsSorted(): false | "asc" | "desc";
    toggleSorting(desc?: boolean, multi?: boolean): void;
}

function sortableColumn(value: unknown): SortableColumn | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<SortableColumn>;
    return typeof candidate.getCanSort === "function" &&
        typeof candidate.getIsSorted === "function" &&
        typeof candidate.toggleSorting === "function" &&
        candidate.getCanSort()
        ? (candidate as SortableColumn)
        : undefined;
}

function ariaSortDirection(
    direction: false | "asc" | "desc" | undefined
): "ascending" | "descending" | "none" {
    if (direction === "asc") return "ascending";
    if (direction === "desc") return "descending";
    return "none";
}

function tableSortDirection(direction: false | "asc" | "desc") {
    if (direction === "asc") return "ascending" as const;
    if (direction === "desc") return "descending" as const;
    return false;
}

function SortableHeaderButton({
    children,
    column,
    direction,
}: {
    readonly children: ReactNode;
    readonly column: SortableColumn;
    readonly direction: false | "asc" | "desc";
}) {
    return (
        <TableSortButton
            direction={tableSortDirection(direction)}
            onClick={(event) => column.toggleSorting(undefined, event.shiftKey)}
        >
            {children}
        </TableSortButton>
    );
}

/**
 * Renders one TanStack Table instance with shared Dashboard table semantics.
 * It renders every row by default and accepts an optional external row window.
 * @returns A styled table that is independent of sorting and virtualization policy.
 */
export function DataTable<TFeatures extends TableFeatures, TData extends RowData>({
    columnWidths,
    footer,
    label,
    onScroll,
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
    const footerElementRef = useRef<HTMLTableSectionElement>(null);
    const footerPresentRef = useRef(footer !== undefined);
    const scrollWasAtEndRef = useRef(false);
    const stableAnchorIndexRef = useRef<number | undefined>(undefined);
    const suppressForwardedScrollRef = useRef(false);
    const tableElementRef = useRef<HTMLTableElement>(null);
    const tableUsesCardLayoutRef = useRef<boolean | undefined>(undefined);
    const getVirtualItemForOffset = rowWindow?.getVirtualItemForOffset;
    const measureRows = rowWindow?.measure;
    const scrollToIndex = rowWindow?.scrollToIndex;

    function handleScroll(event: React.UIEvent<HTMLElement>): void {
        const container = event.currentTarget;
        scrollWasAtEndRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight <= 1;
        if (suppressForwardedScrollRef.current) return;
        const tableElement = tableElementRef.current;
        if (
            tableElement !== null &&
            getVirtualItemForOffset !== undefined &&
            (getComputedStyle(tableElement).display === "block") !==
                tableUsesCardLayoutRef.current
        ) {
            suppressForwardedScrollRef.current = true;
            return;
        }
        stableAnchorIndexRef.current = getVirtualItemForOffset?.(
            container.scrollTop
        )?.index;
        onScroll?.(event);
    }

    useLayoutEffect(() => {
        const footerPresent = footer !== undefined;
        const footerBecamePresent = footerPresent && !footerPresentRef.current;
        footerPresentRef.current = footerPresent;
        if (!footerBecamePresent || !scrollWasAtEndRef.current) return;
        const scrollContainer = scrollContainerRef?.current;
        if (scrollContainer == null || footerElementRef.current === null) return;
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
    }, [footer, scrollContainerRef]);

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
        let releaseFrame: number | undefined;
        let usesCardLayout = getComputedStyle(tableElement).display === "block";
        tableUsesCardLayoutRef.current = usesCardLayout;
        stableAnchorIndexRef.current = getVirtualItemForOffset(
            scrollContainer.scrollTop
        )?.index;
        const observer = new ResizeObserver(() => {
            const nextUsesCardLayout = getComputedStyle(tableElement).display === "block";
            if (nextUsesCardLayout === usesCardLayout) return;
            suppressForwardedScrollRef.current = true;
            usesCardLayout = nextUsesCardLayout;
            tableUsesCardLayoutRef.current = nextUsesCardLayout;
            if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
            if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
            if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
            const anchorIndex =
                stableAnchorIndexRef.current ??
                getVirtualItemForOffset(scrollContainer.scrollTop)?.index;
            measureFrame = requestAnimationFrame(() => {
                measureRows();
                if (anchorIndex === undefined) {
                    suppressForwardedScrollRef.current = false;
                    return;
                }
                restoreFrame = requestAnimationFrame(() => {
                    scrollToIndex(anchorIndex, { align: "start" });
                    releaseFrame = requestAnimationFrame(() => {
                        stableAnchorIndexRef.current =
                            getVirtualItemForOffset(scrollContainer.scrollTop)?.index ??
                            anchorIndex;
                        suppressForwardedScrollRef.current = false;
                    });
                });
            });
        });
        observer.observe(queryContainer);

        return () => {
            observer.disconnect();
            if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
            if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
            if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
            suppressForwardedScrollRef.current = false;
            tableUsesCardLayoutRef.current = undefined;
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
                className={dashboardDataTableClassNames.row}
                data-index={virtualItem?.index}
                key={row.id}
                ref={virtualItem === undefined ? undefined : rowWindow?.measureElement}
            >
                {row.getAllCells().map((cell) => (
                    <td className={dashboardDataTableClassNames.cell} key={cell.id}>
                        <div
                            aria-hidden="true"
                            className={dashboardDataTableClassNames.label}
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
                        <div className={dashboardDataTableClassNames.value}>
                            <table.FlexRender cell={cell} />
                        </div>
                    </td>
                ))}
            </tr>
        );
    }

    return (
        <div
            className={dashboardDataTableClassNames.queryContainer}
            ref={queryContainerRef}
        >
            <section
                aria-label={label}
                className={cn(
                    dashboardDataTableClassNames.scrollContainer,
                    rowWindow === undefined
                        ? undefined
                        : [
                              "max-h-128 overflow-y-auto outline-none [-webkit-overflow-scrolling:touch]",
                              "focus-visible:border-accent-400 focus-visible:ring-accent-400/30 focus-visible:ring-2",
                          ],
                    scrollClassName
                )}
                data-virtualized={rowWindow === undefined ? undefined : "true"}
                onScroll={handleScroll}
                ref={scrollContainerRef}
                tabIndex={rowWindow === undefined ? undefined : 0}
            >
                <table
                    aria-label={label}
                    aria-rowcount={
                        headerGroups.length + rows.length + (footer === undefined ? 0 : 1)
                    }
                    className={cn(dashboardDataTableClassNames.table, tableClassName)}
                    ref={tableElementRef}
                >
                    {columnWidths !== undefined && (
                        <colgroup>
                            {leafHeaders.map((header) => (
                                <col
                                    key={header.id}
                                    style={{ width: columnWidths[header.column.id] }}
                                />
                            ))}
                        </colgroup>
                    )}
                    <thead className={dashboardDataTableClassNames.head}>
                        {headerGroups.map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        aria-sort={ariaSortDirection(
                                            sortableColumn(header.column)?.getIsSorted()
                                        )}
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                        key={header.id}
                                        scope="col"
                                    >
                                        {!header.isPlaceholder &&
                                            (() => {
                                                const column = sortableColumn(
                                                    header.column
                                                );
                                                const content = (
                                                    <table.FlexRender header={header} />
                                                );
                                                return column === undefined ? (
                                                    content
                                                ) : (
                                                    <SortableHeaderButton
                                                        column={column}
                                                        direction={column.getIsSorted()}
                                                    >
                                                        {content}
                                                    </SortableHeaderButton>
                                                );
                                            })()}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody className={dashboardDataTableClassNames.body}>
                        {topSpacerHeight > 0 && (
                            <tr
                                aria-hidden="true"
                                className={dashboardDataTableClassNames.spacerRow}
                            >
                                <td
                                    className={dashboardDataTableClassNames.spacerCell}
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
                                className={dashboardDataTableClassNames.spacerRow}
                            >
                                <td
                                    className={dashboardDataTableClassNames.spacerCell}
                                    colSpan={visibleColumnCount}
                                    height={bottomSpacerHeight}
                                />
                            </tr>
                        )}
                    </tbody>
                    {footer !== undefined && (
                        <tfoot
                            className="@max-[66rem]:block @max-[66rem]:w-full"
                            ref={footerElementRef}
                        >
                            <tr
                                aria-rowindex={headerGroups.length + rows.length + 1}
                                className="@max-[66rem]:block @max-[66rem]:w-full"
                            >
                                <td
                                    className="border-primary-700/60 bg-primary-950/40 border-t p-0 @max-[66rem]:block @max-[66rem]:w-full"
                                    colSpan={visibleColumnCount}
                                >
                                    {footer}
                                </td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </section>
        </div>
    );
}
