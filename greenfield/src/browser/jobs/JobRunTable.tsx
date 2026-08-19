import { createColumnHelper, useTable } from "@tanstack/react-table";
import { History } from "lucide-react";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { dashboardTableFeatures } from "../ui/dashboardTableFeatures.ts";
import { DataTable } from "../ui/DataTable.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "./jobRunPresentation.ts";

const minimumVirtualizedRows = 50;
const jobRunTableFeatures = dashboardTableFeatures;

interface JobRunTableRow {
    readonly onSelect: (id: string) => void;
    readonly run: JobRunSummary;
    readonly selected: boolean;
}

const jobRunColumnHelper = createColumnHelper<
    typeof jobRunTableFeatures,
    JobRunTableRow
>();

const jobRunColumns = jobRunColumnHelper.columns([
    jobRunColumnHelper.accessor((row) => row.run.displayName, {
        cell: ({ getValue, row }) => (
            <Button
                aria-current={row.original.selected ? "true" : undefined}
                aria-label={`Open run ${getValue()}; action ${row.original.run.actionKey}; id ${row.original.run.id}`}
                className={cn(
                    "text-primary-100 hover:text-accent-300 block max-w-80 text-left font-medium wrap-break-word",
                    row.original.selected && "text-accent-300"
                )}
                onClick={() => row.original.onSelect(row.original.run.id)}
                variant="unstyled"
                type="button"
            >
                <span className="block">{getValue()}</span>
                <span className="text-primary-400 mt-0.5 block font-mono text-xs wrap-anywhere">
                    {row.original.run.actionKey}
                </span>
            </Button>
        ),
        header: "Job run",
        id: "displayName",
    }),
    jobRunColumnHelper.accessor((row) => row.run.state, {
        cell: ({ getValue }) => (
            <Badge className="capitalize" variant={jobRunStateBadgeVariant(getValue())}>
                {jobRunStateLabel(getValue())}
            </Badge>
        ),
        header: "Status",
        id: "state",
    }),
    jobRunColumnHelper.accessor((row) => row.run.triggerType, {
        cell: ({ getValue, row }) => (
            <div>
                <Text as="span" className="capitalize">
                    {getValue()}
                </Text>
                {row.original.run.scheduledJobId !== undefined && (
                    <Text
                        as="span"
                        className="mt-0.5 block font-mono wrap-anywhere"
                        size="sm"
                        tone="muted"
                    >
                        {row.original.run.scheduledJobId}
                    </Text>
                )}
            </div>
        ),
        header: "Started by",
        id: "triggerType",
    }),
    jobRunColumnHelper.accessor((row) => row.run.resourceClass, {
        cell: ({ getValue, row }) => (
            <div>
                <Text as="span" className="capitalize">
                    {getValue()}
                </Text>
                <Text as="span" className="mt-0.5 block" size="sm" tone="muted">
                    Priority {row.original.run.priority}
                </Text>
            </div>
        ),
        header: "Work size",
        id: "resourceClass",
    }),
    jobRunColumnHelper.accessor((row) => row.run.attemptCount, {
        cell: ({ getValue, row }) => (
            <Text as="span">
                {getValue()} / {row.original.run.attemptLimit}
            </Text>
        ),
        header: "Attempts",
        id: "attemptCount",
    }),
    jobRunColumnHelper.accessor((row) => row.run.queuedAtMs, {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Queued",
        id: "queuedAtMs",
    }),
    jobRunColumnHelper.accessor((row) => row.run.updatedAtMs, {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Updated",
        id: "updatedAtMs",
    }),
]);

export interface JobRunTableProps {
    readonly compact?: boolean;
    readonly label?: string;
    readonly onSelect: (id: string) => void;
    readonly runs: readonly JobRunSummary[];
    readonly selectedId?: string;
}

/** @returns Selectable durable run inventory with bounded virtual rendering. */
export function JobRunTable({
    compact = false,
    label = "Job runs",
    onSelect,
    runs,
    selectedId,
}: JobRunTableProps) {
    const table = useTable({
        columns: jobRunColumns,
        data: runs.map((run) => ({
            onSelect,
            run,
            selected: run.id === selectedId,
        })),
        features: jobRunTableFeatures,
        getRowId: ({ run }) => run.id,
    });
    const rows = table.getRowModel().rows;

    if (rows.length === 0) {
        return (
            <EmptyState
                description="Waiting, running, and completed jobs will appear here."
                icon={History}
                title="No job runs"
            />
        );
    }

    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            label={label}
            rowWindow={rowWindow}
            scrollContainerRef={rowWindow?.scrollContainerRef}
            table={table}
            tableClassName={
                compact
                    ? "min-w-0 [&_td:nth-child(n+4)]:hidden [&_th:nth-child(n+4)]:hidden @min-[66rem]:min-w-192 @min-[66rem]:[&_td:nth-child(n+4)]:table-cell @min-[66rem]:[&_th:nth-child(n+4)]:table-cell"
                    : "min-w-256"
            }
        />
    );

    if (rows.length < minimumVirtualizedRows) return tableElement();
    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 76}
            getItemKey={(index) => rows[index]?.id ?? `missing-job-run-${index}`}
        >
            {(virtualization) => tableElement(virtualization)}
        </Virtualizer>
    );
}
