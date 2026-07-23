import { Activity, Clock3, Layers3, XCircle } from "lucide-react";

import {
    type JobExecution,
    useCancelJobExecution,
    useJobExecutions,
} from "../../../hooks";
import { formatDate, formatDuration } from "../../../utils/format";
import { Alert } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";

function statusVariant(execution: JobExecution) {
    if (execution.status === "failed") return "error" as const;
    if (execution.status === "success") return "success" as const;
    if (execution.status === "cancelled") return "warning" as const;
    return "info" as const;
}

function resourceLabel(resourceClass: JobExecution["resourceClass"]): string {
    return resourceClass.replace("-", " ");
}

/** Shows global queue pressure and cancellation controls for active executions. */
export function JobExecutionQueueCard() {
    const queue = useJobExecutions();
    const cancelExecution = useCancelJobExecution();
    const summary = queue.data?.summary;
    const activeExecutions = (queue.data?.executions ?? []).filter(
        (execution) => execution.status === "queued" || execution.status === "running"
    );
    const activeClasses = summary?.activeResourceClasses
        .map((resourceClass) => resourceLabel(resourceClass))
        .join(", ");
    const oldestQueuedTimestamp = summary?.oldestQueuedAt
        ? Date.parse(summary.oldestQueuedAt)
        : NaN;
    const oldestWait = Number.isFinite(oldestQueuedTimestamp)
        ? formatDuration(oldestQueuedTimestamp, { includeSeconds: true })
        : "None";

    return (
        <Card variant="bordered" className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <CardTitle>Execution queue</CardTitle>
                    <p className="mt-1 text-sm text-primary-400">
                        Persistent worker queue · global concurrency 1
                    </p>
                </div>
                <Badge
                    variant={
                        queue.isLoading
                            ? "default"
                            : summary?.workerOnline
                              ? summary.running
                                  ? "info"
                                  : "success"
                              : "error"
                    }
                >
                    {queue.isLoading
                        ? "Loading worker"
                        : summary?.workerOnline
                          ? summary.running
                              ? "Worker active"
                              : "Worker idle"
                          : "Worker offline"}
                </Badge>
            </div>

            {queue.error ? (
                <Alert variant="warning">
                    Queue refresh failed. {queue.error.message}
                </Alert>
            ) : undefined}
            {cancelExecution.error ? (
                <Alert variant="error">{cancelExecution.error.message}</Alert>
            ) : undefined}

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                    <div className="flex items-center gap-2 text-xs text-primary-400">
                        <Layers3 className="size-4" /> Queue depth
                    </div>
                    <div className="mt-1 text-lg font-semibold text-primary-100">
                        {summary?.queued ?? 0}
                    </div>
                </div>
                <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                    <div className="flex items-center gap-2 text-xs text-primary-400">
                        <Activity className="size-4" /> Running
                    </div>
                    <div className="mt-1 text-lg font-semibold text-primary-100">
                        {summary?.running ?? 0}/{summary?.workerCapacity ?? 0}
                    </div>
                </div>
                <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                    <div className="flex items-center gap-2 text-xs text-primary-400">
                        <Clock3 className="size-4" /> Oldest queued
                    </div>
                    <div className="mt-1 text-sm font-semibold text-primary-100">
                        {oldestWait}
                    </div>
                </div>
                <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Active class</div>
                    <div className="mt-1 text-sm font-semibold text-primary-100 capitalize">
                        {activeClasses || "None"}
                    </div>
                </div>
            </div>

            {activeExecutions.length > 0 ? (
                <div className="space-y-2" aria-label="Active job executions">
                    {activeExecutions.map((execution) => {
                        const isCancelling =
                            cancelExecution.isPending &&
                            cancelExecution.variables === execution.id;
                        return (
                            <div
                                key={execution.id}
                                className="flex flex-col gap-2 rounded-lg border border-primary-700 bg-primary-900/30 p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate text-sm font-medium text-primary-100">
                                            {execution.displayName}
                                        </span>
                                        <Badge variant={statusVariant(execution)}>
                                            {execution.cancelRequestedAt
                                                ? "cancel requested"
                                                : execution.status}
                                        </Badge>
                                        <Badge variant="default" className="capitalize">
                                            {resourceLabel(execution.resourceClass)}
                                        </Badge>
                                    </div>
                                    <div className="mt-1 text-xs text-primary-400">
                                        Queued {formatDate(execution.queuedAt)}
                                        {execution.startedAt
                                            ? ` · started ${formatDate(execution.startedAt)}`
                                            : ""}
                                    </div>
                                </div>
                                {execution.cancellable && !execution.cancelRequestedAt ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="danger"
                                        disabled={isCancelling}
                                        aria-label={`Cancel ${execution.displayName}`}
                                        onClick={() =>
                                            cancelExecution.mutate(execution.id)
                                        }
                                        className="w-full shrink-0 sm:w-auto"
                                    >
                                        <XCircle className="size-4" />
                                        {isCancelling ? "Cancelling..." : "Cancel"}
                                    </Button>
                                ) : undefined}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="text-sm text-primary-400">No queued or running jobs.</p>
            )}
        </Card>
    );
}
