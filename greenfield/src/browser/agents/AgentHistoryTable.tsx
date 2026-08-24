import { createColumnHelper, useTable } from "@tanstack/react-table";
import { History } from "lucide-react";

import type { AgentTaskRun } from "../../contracts/agentModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { dashboardTableFeatures } from "../ui/dashboardTableFeatures.ts";
import { DataTable } from "../ui/DataTable.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import {
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "../ui/InfiniteScrollTrigger.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";

const minimumVirtualizedRows = 50;
const historyTableFeatures = dashboardTableFeatures;
const compactMobileHistoryClassName =
    "min-w-224 @max-[66rem]:[&_.dashboard-data-table-row]:grid @max-[66rem]:[&_.dashboard-data-table-row]:grid-cols-2 @max-[66rem]:[&_.dashboard-data-table-cell]:p-2.5 @max-[66rem]:[&_.dashboard-data-table-cell]:gap-1 @max-[66rem]:[&_.dashboard-data-table-label]:text-[10px] @max-[66rem]:[&_.dashboard-data-table-label]:leading-3 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(1)]:order-1 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(2)]:order-3 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(2)]:col-span-2 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(3)]:order-2 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(4)]:order-4 @max-[66rem]:[&_.dashboard-data-table-cell:nth-child(5)]:order-5";
const historyColumnHelper = createColumnHelper<
    typeof historyTableFeatures,
    AgentTaskRun
>();

const historyColumns = historyColumnHelper.columns([
    historyColumnHelper.accessor("agentId", {
        cell: ({ getValue }) => (
            <Text as="span" className="font-medium" tone="accent">
                {getValue()}
            </Text>
        ),
        header: "Agent",
        enableSorting: false,
    }),
    historyColumnHelper.accessor("task", {
        cell: ({ getValue }) => <Text className="wrap-break-word">{getValue()}</Text>,
        header: "Task",
        enableSorting: false,
    }),
    historyColumnHelper.accessor("status", {
        cell: ({ getValue }) => (
            <Badge variant={getValue() === "active" ? "success" : "default"}>
                {getValue()}
            </Badge>
        ),
        header: "Status",
        enableSorting: false,
    }),
    historyColumnHelper.accessor("startedAtMs", {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Started",
        enableSorting: false,
    }),
    historyColumnHelper.accessor(
        (run) => (run.status === "completed" ? run.completedAtMs : undefined),
        {
            cell: ({ getValue }) => {
                const completedAtMs = getValue();
                return completedAtMs === undefined ? (
                    <Text as="span" tone="muted">
                        In progress
                    </Text>
                ) : (
                    <time dateTime={new Date(completedAtMs).toISOString()}>
                        {formatDashboardDateTime(completedAtMs)}
                    </time>
                );
            },
            header: "Completed",
            id: "completedAtMs",
            enableSorting: false,
        }
    ),
]);

interface AgentHistoryTableProps {
    readonly pagination?: InfiniteScrollContinuation;
    readonly runs: readonly AgentTaskRun[];
}

/** @returns Shared table and virtual window for durable agent task history. */
export function AgentHistoryTable({ pagination, runs }: AgentHistoryTableProps) {
    const table = useTable({
        columns: historyColumns,
        data: runs,
        features: historyTableFeatures,
        getRowId: (run) => run.id,
    });
    const rows = table.getRowModel().rows;

    if (rows.length === 0) {
        return (
            <EmptyState
                description="Completed and active current-task intervals will appear here."
                icon={History}
                title="No agent task history"
            />
        );
    }

    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            footer={
                pagination === undefined ||
                (!pagination.hasMore &&
                    !pagination.loading &&
                    pagination.error === undefined) ? undefined : (
                    <InfiniteScrollTrigger
                        className="p-3"
                        rootRef={rowWindow?.scrollContainerRef}
                        {...pagination}
                    />
                )
            }
            label="Agent task history"
            rowWindow={rowWindow}
            scrollContainerRef={rowWindow?.scrollContainerRef}
            table={table}
            tableClassName={compactMobileHistoryClassName}
        />
    );

    return (
        <section aria-labelledby="agent-history-heading">
            <Heading id="agent-history-heading" level={2}>
                Task history
            </Heading>
            <div className="mt-4">
                {rows.length < minimumVirtualizedRows ? (
                    tableElement()
                ) : (
                    <Virtualizer<HTMLTableRowElement>
                        count={rows.length}
                        estimateSize={() => 72}
                        getItemKey={(index) =>
                            rows[index]?.id ?? `missing-agent-history-${index}`
                        }
                    >
                        {(virtualization) => tableElement(virtualization)}
                    </Virtualizer>
                )}
            </div>
        </section>
    );
}
