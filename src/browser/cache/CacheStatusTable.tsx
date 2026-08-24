import { createColumnHelper, useTable } from "@tanstack/react-table";

import type { CacheEntryStatus } from "../../contracts/cache.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { dashboardTableFeatures } from "../ui/dashboardTableFeatures.ts";
import { DataTable } from "../ui/DataTable.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";
import {
    cacheAttemptLabel,
    cacheAttemptVariant,
    cacheFreshnessLabel,
    cacheFreshnessVariant,
} from "./cachePresentation.ts";

const minimumVirtualizedRows = 50;
const cacheStatusTableFeatures = dashboardTableFeatures;

interface CacheStatusTableRow {
    readonly entry: CacheEntryStatus;
    readonly onSelect: (key: string) => void;
    readonly selected: boolean;
}

const cacheStatusColumnHelper = createColumnHelper<
    typeof cacheStatusTableFeatures,
    CacheStatusTableRow
>();

const cacheStatusColumns = cacheStatusColumnHelper.columns([
    cacheStatusColumnHelper.accessor((row) => row.entry.key, {
        cell: ({ getValue, row }) => (
            <Button
                aria-current={row.original.selected ? "true" : undefined}
                className={cn(
                    "text-primary-100 hover:text-accent-300 focus-visible:ring-accent-300 block min-h-8 min-w-8 rounded px-2 py-1 text-left font-mono text-sm font-medium wrap-break-word",
                    row.original.selected &&
                        "bg-accent-500/10 text-accent-300 underline decoration-2"
                )}
                onClick={() => row.original.onSelect(getValue())}
                variant="unstyled"
                type="button"
            >
                {getValue()}
            </Button>
        ),
        header: "Data source",
        id: "key",
    }),
    cacheStatusColumnHelper.accessor((row) => row.entry.freshness, {
        cell: ({ getValue }) => (
            <Badge variant={cacheFreshnessVariant(getValue())}>
                {cacheFreshnessLabel(getValue())}
            </Badge>
        ),
        header: "Status",
        id: "freshness",
    }),
    cacheStatusColumnHelper.accessor((row) => row.entry.lastAttemptStatus, {
        cell: ({ getValue }) => (
            <Badge variant={cacheAttemptVariant(getValue())}>
                {cacheAttemptLabel(getValue())}
            </Badge>
        ),
        header: "Last refresh",
        id: "lastAttemptStatus",
    }),
    cacheStatusColumnHelper.accessor((row) => row.entry.updatedAtMs, {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Updated",
        id: "updatedAtMs",
    }),
    cacheStatusColumnHelper.accessor((row) => row.entry.manualRunAvailable, {
        cell: ({ getValue }) => (
            <Text tone={getValue() ? "default" : "muted"}>
                {getValue() ? "Available" : "Unavailable"}
            </Text>
        ),
        header: "Manual refresh",
        id: "manualRunAvailable",
    }),
]);

interface CacheStatusTableProps {
    readonly entries: readonly CacheEntryStatus[];
    readonly onSelect: (key: string) => void;
    readonly selectedKey?: string;
}

/** @returns Selectable, bounded cache status inventory with large-page virtualization. */
export function CacheStatusTable({
    entries,
    onSelect,
    selectedKey,
}: CacheStatusTableProps) {
    const table = useTable({
        columns: cacheStatusColumns,
        data: entries.map((entry) => ({
            entry,
            onSelect,
            selected: entry.key === selectedKey,
        })),
        features: cacheStatusTableFeatures,
        getRowId: ({ entry }) => entry.key,
    });
    const rows = table.getRowModel().rows;
    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            label="Saved data sources"
            rowWindow={rowWindow}
            scrollContainerRef={rowWindow?.scrollContainerRef}
            table={table}
            tableClassName="min-w-192"
        />
    );

    if (rows.length < minimumVirtualizedRows) return tableElement();
    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 58}
            getItemKey={(index) => rows[index]?.id ?? `missing-cache-entry-${index}`}
        >
            {(virtualization) => tableElement(virtualization)}
        </Virtualizer>
    );
}
