import { Pencil, Play, Power, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Text } from "../ui/Text.tsx";
import type { OpenClawCronRunsView } from "./openClawCronQueries.ts";
import { openClawCronScheduleLabel } from "./presentation.ts";

interface OpenClawCronDetailProps {
    readonly actionBusy: boolean;
    readonly actionError?: string;
    readonly definitionControlsAvailable: boolean;
    readonly job: OpenClawCronJob;
    readonly onDelete: () => void;
    readonly onEdit: () => void;
    readonly onLoadMoreRuns?: () => void;
    readonly onRun: () => void;
    readonly onSetEnabled: () => void;
    readonly onRetryRuns?: () => void;
    readonly runs?: OpenClawCronRunsView;
    readonly runsError?: string;
    readonly runsLoading?: boolean;
    readonly runsLoadingMore?: boolean;
}

function dateTime(timestampMs: number | undefined): ReactNode {
    if (timestampMs === undefined) return "—";
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

function synchronizationBadgeVariant(
    state: OpenClawCronJob["synchronization"]["state"]
): "danger" | "success" | "warning" {
    if (state === "confirmed") return "success";
    if (state === "pending") return "warning";
    return "danger";
}

function runBadgeVariant(status: "error" | "ok" | "skipped" | "unknown") {
    if (status === "ok") return "success" as const;
    if (status === "error") return "danger" as const;
    return "default" as const;
}

/** @returns Bounded OpenClaw definition, controls, and Gateway-owned run history. */
export function OpenClawCronDetail({
    actionBusy,
    actionError,
    definitionControlsAvailable,
    job,
    onDelete,
    onEdit,
    onLoadMoreRuns,
    onRetryRuns,
    onRun,
    onSetEnabled,
    runs,
    runsError,
    runsLoading = false,
    runsLoadingMore = false,
}: OpenClawCronDetailProps) {
    const headingId = useId();
    const historyHeadingId = useId();
    const payloadTruncated = "truncated" in job.payload && job.payload.truncated;
    const payloadRedacted =
        "contentRedacted" in job.payload && job.payload.contentRedacted;
    const scheduleTruncated = "truncated" in job.schedule && job.schedule.truncated;
    const delivery = job.delivery;
    const definitionRows: readonly (readonly [string, ReactNode])[] = [
        ["Schedule", openClawCronScheduleLabel(job)],
        ...(job.agentId === undefined ? [] : ([["Agent", job.agentId]] as const)),
        ["Session target", job.sessionTarget],
        ["Payload kind", job.payload.kind],
        ...(payloadRedacted
            ? ([["Payload content", "Redacted privileged content"]] as const)
            : []),
        ["Delivery", job.deliveryMode],
        ...(delivery === undefined
            ? []
            : ([
                  [
                      "Delivery target",
                      delivery.targetConfigured
                          ? "Configured (write-only)"
                          : "Not configured",
                  ],
                  [
                      "Completion webhook",
                      delivery.completionDestinationConfigured
                          ? "Configured (write-only)"
                          : "Not configured",
                  ],
                  [
                      "Failure target",
                      delivery.failureDestination?.targetConfigured === true
                          ? "Configured (write-only)"
                          : "Not configured",
                  ],
              ] as const)),
        ["Wake mode", job.wakeMode],
        ["Next run", dateTime(job.state.nextRunAtMs)],
        ["Last run", dateTime(job.state.lastRunAtMs)],
        ["Last status", job.state.lastRunStatus ?? "—"],
        ["Updated", dateTime(job.updatedAtMs)],
    ];
    return (
        <div className="space-y-5">
            <Card aria-labelledby={headingId}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <Heading id={headingId} level={3} size="section">
                            {job.name}
                        </Heading>
                        <Text
                            className="mt-1 font-mono wrap-break-word"
                            size="sm"
                            tone="muted"
                        >
                            {job.id}
                        </Text>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Badge variant={job.enabled ? "success" : "default"}>
                            Gateway {job.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge
                            variant={synchronizationBadgeVariant(
                                job.synchronization.state
                            )}
                        >
                            {job.synchronization.state}
                        </Badge>
                    </div>
                </div>
                <Alert className="mt-4" message={actionError} focusOnError={false} />
                {job.synchronization.state !== "confirmed" && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message={
                            job.synchronization.state === "pending"
                                ? "Dashboard has saved a desired enabled state that still awaits Gateway confirmation."
                                : "Dashboard intent and authoritative Gateway state disagree. Refresh before another control action."
                        }
                        variant="info"
                    />
                )}
                {(job.nameTruncated ||
                    job.agentIdTruncated ||
                    job.descriptionTruncated ||
                    delivery?.metadataTruncated === true ||
                    scheduleTruncated ||
                    payloadTruncated) && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message="One or more definition values are bounded or sanitized. Incomplete fields are omitted from the editor so an unrelated change cannot overwrite the authoritative Gateway value."
                        variant="info"
                    />
                )}
                <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                    {definitionRows.map(([label, value]) => (
                        <div key={label}>
                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                {label}
                            </dt>
                            <dd className="text-primary-100 mt-1 text-sm wrap-break-word">
                                {value}
                            </dd>
                        </div>
                    ))}
                </dl>
                {job.synchronization.disableIntent !== undefined && (
                    <div className="border-primary-700 mt-5 border-t pt-4">
                        <Text size="sm" tone="muted">
                            Disable intent
                        </Text>
                        <Text className="mt-1">
                            {job.synchronization.disableIntent.reason}
                        </Text>
                        {job.synchronization.disableIntent.expiresAtMs !== undefined && (
                            <Text className="mt-1" size="sm" tone="muted">
                                Expires{" "}
                                {dateTime(job.synchronization.disableIntent.expiresAtMs)}
                            </Text>
                        )}
                    </div>
                )}
                <div className="mt-6 flex flex-wrap gap-2">
                    <Button disabled={actionBusy} onClick={onRun} variant="secondary">
                        <Icon icon={Play} size="sm" tone="inherit" />
                        Run now
                    </Button>
                    <Button
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onSetEnabled}
                        variant="secondary"
                    >
                        <Icon icon={Power} size="sm" tone="inherit" />
                        {job.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onEdit}
                        variant="secondary"
                    >
                        <Icon icon={Pencil} size="sm" tone="inherit" />
                        Edit reviewed fields
                    </Button>
                    <Button
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onDelete}
                        variant="danger"
                    >
                        <Icon icon={Trash2} size="sm" tone="inherit" />
                        Delete
                    </Button>
                </div>
            </Card>

            <Card aria-labelledby={historyHeadingId}>
                <Heading id={historyHeadingId} level={3}>
                    OpenClaw run history
                </Heading>
                <Text className="mt-1" tone="muted">
                    These are Gateway cron runs, not Dashboard durable job runs.
                </Text>
                {runsLoading && runs === undefined && (
                    <LoadingState
                        className="mt-5"
                        label="Loading OpenClaw runs…"
                        size="sm"
                    />
                )}
                {runsError !== undefined && runs === undefined && (
                    <div className="mt-5">
                        <Alert message={runsError} />
                        {onRetryRuns !== undefined && (
                            <Button
                                className="mt-3"
                                onClick={onRetryRuns}
                                variant="secondary"
                            >
                                Try again
                            </Button>
                        )}
                    </div>
                )}
                {runsError !== undefined && runs !== undefined && (
                    <Alert className="mt-5" focusOnError={false} message={runsError} />
                )}
                {runs !== undefined && runs.freshness.kind === "last-known-good" && (
                    <Alert
                        className="mt-5"
                        focusOnError={false}
                        message="Showing last-known-good OpenClaw run history while Gateway refresh is unavailable."
                        variant="info"
                    />
                )}
                {runs !== undefined && runs.runs.length === 0 && (
                    <Text className="mt-5" tone="muted">
                        No bounded run history is available for this OpenClaw job.
                    </Text>
                )}
                {runs !== undefined && runs.runs.length > 0 && (
                    <div className="border-primary-700 mt-5 overflow-x-auto rounded-lg border">
                        <table
                            aria-label={`OpenClaw runs for ${job.name}`}
                            className="w-full min-w-240"
                        >
                            <thead className="bg-primary-900">
                                <tr>
                                    {[
                                        "Completed",
                                        "Status",
                                        "Delivery",
                                        "Duration",
                                        "Model",
                                        "Provider",
                                        "Summary",
                                    ].map((heading) => (
                                        <th
                                            className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                            key={heading}
                                            scope="col"
                                        >
                                            {heading}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {runs.runs.map((run, index) => (
                                    <tr
                                        className="border-primary-700 border-b text-sm"
                                        key={run.runId ?? `${run.completedAtMs}-${index}`}
                                    >
                                        <td className="p-3">
                                            {dateTime(run.completedAtMs)}
                                        </td>
                                        <td className="p-3">
                                            <Badge variant={runBadgeVariant(run.status)}>
                                                {run.status}
                                            </Badge>
                                        </td>
                                        <td className="p-3">{run.deliveryStatus}</td>
                                        <td className="p-3">
                                            {run.durationMs === undefined
                                                ? "—"
                                                : `${run.durationMs} ms`}
                                        </td>
                                        <td className="p-3">
                                            {run.model ?? "—"}
                                            {run.modelTruncated && " (bounded)"}
                                        </td>
                                        <td className="p-3">
                                            {run.provider ?? "—"}
                                            {run.providerTruncated && " (bounded)"}
                                        </td>
                                        <td className="max-w-md p-3 wrap-break-word">
                                            {run.summary ?? run.errorReason ?? "—"}
                                            {run.summaryTruncated && " (bounded preview)"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {runs?.hasMore && onLoadMoreRuns !== undefined && (
                    <Button
                        busy={runsLoadingMore}
                        busyLabel="Loading…"
                        className="mt-4"
                        onClick={onLoadMoreRuns}
                        variant="secondary"
                    >
                        Load older OpenClaw runs
                    </Button>
                )}
                {runs?.hasMore && onLoadMoreRuns === undefined && (
                    <Text className="mt-3" size="sm" tone="muted">
                        More Gateway run history exists beyond this bounded browser
                        window.
                    </Text>
                )}
            </Card>
        </div>
    );
}
