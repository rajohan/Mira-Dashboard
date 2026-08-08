import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { PauseCircle, PlayCircle, Server } from "lucide-react";

import type { JobRunState, JobWorkerSummary } from "../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { DataTable } from "../ui/DataTable.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "./jobRunPresentation.ts";

const workerTableFeatures = tableFeatures({});
const queueStateDefinitions = Object.freeze([
    { label: "Queued", state: "queued" },
    { label: "Running", state: "running" },
    { label: "Failed", state: "failed" },
    { label: "Timed out", state: "timed-out" },
    { label: "Succeeded", state: "succeeded" },
    { label: "Cancelled", state: "cancelled" },
] satisfies readonly Readonly<{ label: string; state: JobRunState }>[]);

function workerStateBadgeVariant(
    state: JobWorkerSummary["state"]
): "default" | "success" | "warning" {
    switch (state) {
        case "draining": {
            return "warning";
        }
        case "online": {
            return "success";
        }
        case "stopped": {
            return "default";
        }
    }
}

const workerColumnHelper = createColumnHelper<
    typeof workerTableFeatures,
    JobWorkerSummary
>();
const workerColumns = workerColumnHelper.columns([
    workerColumnHelper.accessor("id", {
        cell: ({ getValue }) => (
            <code className="text-primary-200 text-xs wrap-anywhere">{getValue()}</code>
        ),
        header: "Worker",
    }),
    workerColumnHelper.accessor("state", {
        cell: ({ getValue }) => (
            <Badge className="capitalize" variant={workerStateBadgeVariant(getValue())}>
                {getValue()}
            </Badge>
        ),
        header: "State",
    }),
    workerColumnHelper.accessor("activeRunCount", {
        cell: ({ getValue, row }) => (
            <Text as="span">
                {getValue()} / {row.original.capacity}
            </Text>
        ),
        header: "Active / capacity",
    }),
    workerColumnHelper.accessor("releaseId", {
        cell: ({ getValue }) => (
            <code className="text-primary-300 text-xs" title={getValue()}>
                {getValue().slice(0, 12)}
            </code>
        ),
        header: "Release",
    }),
    workerColumnHelper.accessor("startedAtMs", {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Started",
    }),
    workerColumnHelper.accessor("heartbeatAtMs", {
        cell: ({ getValue }) => (
            <time dateTime={new Date(getValue()).toISOString()}>
                {formatDashboardDateTime(getValue())}
            </time>
        ),
        header: "Heartbeat",
    }),
]);

export interface JobQueuePanelProps {
    readonly controlBusy: boolean;
    readonly controlDisabled?: boolean;
    readonly onSetClaimingPaused: (paused: boolean) => void;
    readonly summary: JobQueueSummary;
}

/** @returns Durable queue counts, worker inventory, and versioned claim control. */
export function JobQueuePanel({
    controlBusy,
    controlDisabled = false,
    onSetClaimingPaused,
    summary,
}: JobQueuePanelProps) {
    const workerTable = useTable({
        columns: workerColumns,
        data: summary.workers,
        features: workerTableFeatures,
        getRowId: (worker) => worker.id,
    });
    const claimingPaused = summary.control.claimingPaused;
    const actionLabel = claimingPaused ? "Resume claiming" : "Pause claiming";
    const actionBusyLabel = claimingPaused ? "Resuming claiming…" : "Pausing claiming…";

    return (
        <Card aria-label="Job queue and workers">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <Heading level={2}>Queue and workers</Heading>
                    <Text className="mt-1" tone="muted">
                        Durable claim state and the currently registered worker fleet.
                    </Text>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                    <output aria-atomic="true" aria-live="polite">
                        <Badge variant={claimingPaused ? "warning" : "success"}>
                            Claiming {claimingPaused ? "paused" : "active"}
                        </Badge>
                    </output>
                    <Button
                        aria-label={`${actionLabel} for new job runs`}
                        busy={controlBusy}
                        busyLabel={actionBusyLabel}
                        disabled={controlDisabled}
                        onClick={() => onSetClaimingPaused(!claimingPaused)}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon
                            icon={claimingPaused ? PlayCircle : PauseCircle}
                            size="sm"
                            tone="inherit"
                        />
                        {actionLabel}
                    </Button>
                </div>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {queueStateDefinitions.map(({ label, state }) => (
                    <div
                        className="border-primary-700 bg-primary-900/70 rounded-lg border p-3"
                        key={state}
                    >
                        <dt>
                            <Badge variant={jobRunStateBadgeVariant(state)}>
                                {jobRunStateLabel(state)}
                            </Badge>
                        </dt>
                        <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                            {summary.stateCounts[state]}
                            <span className="sr-only">
                                {" "}
                                {label.toLowerCase()} job runs
                            </span>
                        </dd>
                    </div>
                ))}
            </dl>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="border-primary-700 rounded-lg border p-3">
                    <Text size="sm" tone="muted">
                        Oldest queued
                    </Text>
                    {summary.oldestQueuedAtMs === undefined ? (
                        <Text className="mt-1">No runs waiting</Text>
                    ) : (
                        <time
                            className="text-primary-200 mt-1 block text-sm"
                            dateTime={new Date(summary.oldestQueuedAtMs).toISOString()}
                        >
                            {formatDashboardDateTime(summary.oldestQueuedAtMs)}
                        </time>
                    )}
                </div>
                <div className="border-primary-700 rounded-lg border p-3">
                    <Text size="sm" tone="muted">
                        Active resource classes
                    </Text>
                    <Text className="mt-1 wrap-break-word capitalize">
                        {summary.activeResourceClasses.length === 0
                            ? "None"
                            : summary.activeResourceClasses.join(", ")}
                    </Text>
                </div>
                <div className="border-primary-700 rounded-lg border p-3">
                    <Text size="sm" tone="muted">
                        Claim control updated
                    </Text>
                    <time
                        className="text-primary-200 mt-1 block text-sm"
                        dateTime={new Date(summary.control.updatedAtMs).toISOString()}
                    >
                        {formatDashboardDateTime(summary.control.updatedAtMs)} · version{" "}
                        {summary.control.version}
                    </time>
                </div>
            </div>

            <div className="mt-6">
                <div className="mb-3 flex items-center gap-2">
                    <Icon icon={Server} />
                    <Heading level={3}>Workers</Heading>
                </div>
                {summary.workers.length === 0 ? (
                    <output>
                        <Text as="span" tone="muted">
                            No workers are registered.
                        </Text>
                    </output>
                ) : (
                    <DataTable
                        label="Job workers"
                        table={workerTable}
                        tableClassName="min-w-224"
                    />
                )}
            </div>
        </Card>
    );
}
