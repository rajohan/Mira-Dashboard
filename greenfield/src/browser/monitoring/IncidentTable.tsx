import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";

import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { DataTable } from "../ui/DataTable.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";
import { incidentSeverityVariant } from "./incidentPresentation.ts";

const minimumVirtualizedRows = 50;
const incidentTableFeatures = tableFeatures({});

interface IncidentTableRow {
    readonly incident: IncidentSummary;
    readonly onSelect: (id: string) => void;
    readonly selected: boolean;
}

const incidentColumnHelper = createColumnHelper<
    typeof incidentTableFeatures,
    IncidentTableRow
>();

const incidentColumns = incidentColumnHelper.columns([
    incidentColumnHelper.accessor((row) => row.incident.title, {
        cell: ({ getValue, row }) => (
            <Button
                aria-current={row.original.selected ? "true" : undefined}
                aria-label={`${row.original.incident.title}; ${row.original.incident.monitorKey}; occurrence group ${row.original.incident.generation}`}
                className={cn(
                    "text-primary-100 hover:text-accent-300 text-left font-medium wrap-break-word",
                    row.original.selected && "text-accent-300"
                )}
                onClick={() => row.original.onSelect(row.original.incident.id)}
                variant="unstyled"
                type="button"
            >
                {getValue()}
            </Button>
        ),
        header: "Incident",
        id: "title",
    }),
    incidentColumnHelper.accessor((row) => row.incident.state, {
        cell: ({ getValue }) => (
            <Badge variant={getValue() === "active" ? "warning" : "success"}>
                {getValue()}
            </Badge>
        ),
        header: "Status",
        id: "state",
    }),
    incidentColumnHelper.accessor((row) => row.incident.severity, {
        cell: ({ getValue }) => (
            <Badge variant={incidentSeverityVariant(getValue())}>{getValue()}</Badge>
        ),
        header: "Severity",
        id: "severity",
    }),
    incidentColumnHelper.accessor((row) => row.incident.monitorKey, {
        cell: ({ getValue }) => <Text className="wrap-break-word">{getValue()}</Text>,
        header: "Check",
        id: "monitorKey",
    }),
    incidentColumnHelper.accessor((row) => row.incident.kind, {
        cell: ({ getValue }) => <Text className="wrap-break-word">{getValue()}</Text>,
        header: "Type",
        id: "kind",
    }),
    incidentColumnHelper.accessor((row) => row.incident.lastSeenAtMs, {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Last seen",
        id: "lastSeenAtMs",
    }),
]);

interface IncidentTableProps {
    readonly incidents: readonly IncidentSummary[];
    readonly onSelect: (id: string) => void;
    readonly selectedId: string | undefined;
}

/** @returns Selectable incident lifecycle table with bounded virtual rendering. */
export function IncidentTable({ incidents, onSelect, selectedId }: IncidentTableProps) {
    const table = useTable({
        columns: incidentColumns,
        data: incidents.map((incident) => ({
            incident,
            onSelect,
            selected: incident.id === selectedId,
        })),
        features: incidentTableFeatures,
        getRowId: ({ incident }) => incident.id,
    });
    const rows = table.getRowModel().rows;
    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            label="Incidents"
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
            estimateSize={() => 72}
            getItemKey={(index) => rows[index]?.id ?? `missing-incident-${index}`}
        >
            {(virtualization) => tableElement(virtualization)}
        </Virtualizer>
    );
}
