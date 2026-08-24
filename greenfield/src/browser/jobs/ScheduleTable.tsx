import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";

import type { JobRunState, ScheduleSummary } from "../../contracts/jobModel.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { DataTable } from "../ui/DataTable.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";
import { scheduleConfigurationLabel } from "./schedulePresentation.ts";

const minimumVirtualizedRows = 50;
const scheduleTableFeatures = tableFeatures({});

function runStateVariant(state: JobRunState) {
    if (["failed", "timed-out"].includes(state)) return "danger" as const;
    if (state === "succeeded") return "success" as const;
    if (["queued", "running"].includes(state)) return "info" as const;
    return "default" as const;
}

interface ScheduleTableRow {
    readonly onSelect: (id: string) => void;
    readonly schedule: ScheduleSummary;
    readonly selected: boolean;
}

const scheduleColumnHelper = createColumnHelper<
    typeof scheduleTableFeatures,
    ScheduleTableRow
>();

const scheduleColumns = scheduleColumnHelper.columns([
    scheduleColumnHelper.accessor((row) => row.schedule.name, {
        cell: ({ getValue, row }) => (
            <button
                aria-current={row.original.selected ? "true" : undefined}
                aria-label={`${getValue()}; ${row.original.schedule.id}`}
                className={cn(
                    "text-primary-100 hover:text-accent-300 text-left font-medium wrap-break-word",
                    row.original.selected && "text-accent-300"
                )}
                onClick={() => row.original.onSelect(row.original.schedule.id)}
                type="button"
            >
                {getValue()}
            </button>
        ),
        header: "Schedule",
        id: "name",
    }),
    scheduleColumnHelper.accessor((row) => row.schedule.enabled, {
        cell: ({ getValue }) => (
            <Badge variant={getValue() ? "success" : "default"}>
                {getValue() ? "enabled" : "disabled"}
            </Badge>
        ),
        header: "Status",
        id: "enabled",
    }),
    scheduleColumnHelper.accessor((row) => row.schedule.schedule, {
        cell: ({ getValue }) => (
            <Text className="font-mono wrap-break-word" size="sm">
                {scheduleConfigurationLabel(getValue())}
            </Text>
        ),
        header: "Schedule",
        id: "cadence",
    }),
    scheduleColumnHelper.accessor((row) => row.schedule.nextRunAtMs, {
        cell: ({ getValue }) => {
            const nextRunAtMs = getValue();
            return nextRunAtMs === undefined ? (
                <Text tone="muted">—</Text>
            ) : (
                <time dateTime={new Date(nextRunAtMs).toISOString()}>
                    {formatDashboardDateTime(nextRunAtMs)}
                </time>
            );
        },
        header: "Next run",
        id: "nextRunAtMs",
    }),
    scheduleColumnHelper.accessor((row) => row.schedule.activeRun?.state, {
        cell: ({ getValue }) => {
            const state = getValue();
            return state === undefined ? (
                <Text tone="muted">Idle</Text>
            ) : (
                <Badge variant={runStateVariant(state)}>{state}</Badge>
            );
        },
        header: "Active run",
        id: "activeRun",
    }),
]);

interface ScheduleTableProps {
    readonly onSelect: (id: string) => void;
    readonly schedules: readonly ScheduleSummary[];
    readonly selectedId?: string;
}

/** @returns Selectable, virtualized Dashboard-local schedule directory. */
export function ScheduleTable({ onSelect, schedules, selectedId }: ScheduleTableProps) {
    const table = useTable({
        columns: scheduleColumns,
        data: schedules.map((schedule) => ({
            onSelect,
            schedule,
            selected: schedule.id === selectedId,
        })),
        features: scheduleTableFeatures,
        getRowId: ({ schedule }) => schedule.id,
    });
    const rows = table.getRowModel().rows;
    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            label="Dashboard schedules"
            rowWindow={rowWindow}
            scrollContainerRef={rowWindow?.scrollContainerRef}
            table={table}
            tableClassName="min-w-224"
        />
    );

    if (rows.length < minimumVirtualizedRows) return tableElement();
    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 68}
            getItemKey={(index) => rows[index]?.id ?? `missing-schedule-${index}`}
        >
            {(virtualization) => tableElement(virtualization)}
        </Virtualizer>
    );
}
