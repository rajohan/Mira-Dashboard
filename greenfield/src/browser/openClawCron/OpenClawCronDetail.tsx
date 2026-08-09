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
import {
    openClawCronDeliveryModeLabel,
    openClawCronDeliveryStatusLabel,
    openClawCronPayloadLabel,
    openClawCronRunStatusLabel,
    openClawCronScheduleLabel,
    openClawCronSessionTargetLabel,
    openClawCronSynchronizationLabel,
    openClawCronWakeModeLabel,
} from "./presentation.ts";

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
        ["Session", openClawCronSessionTargetLabel(job.sessionTarget)],
        ["Task type", openClawCronPayloadLabel(job.payload.kind)],
        ...(payloadRedacted ? ([["Task content", "Hidden for security"]] as const) : []),
        ["Delivery", openClawCronDeliveryModeLabel(job.deliveryMode)],
        ...(delivery === undefined
            ? []
            : ([
                  [
                      "Delivery target",
                      delivery.targetConfigured
                          ? "Configured (hidden for security)"
                          : "Not configured",
                  ],
                  [
                      "Completion webhook",
                      delivery.completionDestinationConfigured
                          ? "Configured (hidden for security)"
                          : "Not configured",
                  ],
                  [
                      "Failure target",
                      delivery.failureDestination?.targetConfigured === true
                          ? "Configured (hidden for security)"
                          : "Not configured",
                  ],
              ] as const)),
        ["Start timing", openClawCronWakeModeLabel(job.wakeMode)],
        ["Next run", dateTime(job.state.nextRunAtMs)],
        ["Last run", dateTime(job.state.lastRunAtMs)],
        [
            "Last status",
            job.state.lastRunStatus === undefined
                ? "—"
                : openClawCronRunStatusLabel(job.state.lastRunStatus),
        ],
        ["Updated", dateTime(job.updatedAtMs)],
    ];
    return (
        <div className="max-w-full min-w-0 space-y-5">
            <Card aria-labelledby={headingId} className="max-w-full min-w-0">
                <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="w-full max-w-full min-w-0 sm:flex-1">
                        <Heading
                            className="max-w-full wrap-anywhere"
                            id={headingId}
                            level={3}
                            size="section"
                        >
                            {job.name}
                        </Heading>
                        <Text
                            className="mt-1 max-w-full font-mono wrap-anywhere"
                            size="sm"
                            tone="muted"
                        >
                            {job.id}
                        </Text>
                    </div>
                    <section
                        aria-label="Scheduled job status"
                        className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end"
                    >
                        <Badge
                            className="max-w-full shrink-0 whitespace-nowrap"
                            variant={job.enabled ? "success" : "default"}
                        >
                            OpenClaw {job.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge
                            className="max-w-full shrink-0 whitespace-nowrap"
                            variant={synchronizationBadgeVariant(
                                job.synchronization.state
                            )}
                        >
                            {openClawCronSynchronizationLabel(job.synchronization.state)}
                        </Badge>
                    </section>
                </header>
                <Alert className="mt-4" message={actionError} focusOnError={false} />
                {job.synchronization.state !== "confirmed" && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message={
                            job.synchronization.state === "pending"
                                ? "Dashboard is waiting for OpenClaw to confirm this change."
                                : "Dashboard and OpenClaw report different settings. Refresh before taking another action."
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
                        message="Some details were shortened or hidden. Hidden fields will not be changed when you edit this job."
                        variant="info"
                    />
                )}
                <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                    {definitionRows.map(([label, value]) => (
                        <div className="min-w-0" key={label}>
                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                {label}
                            </dt>
                            <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere">
                                {value}
                            </dd>
                        </div>
                    ))}
                </dl>
                {job.synchronization.disableIntent !== undefined && (
                    <div className="border-primary-700 mt-5 border-t pt-4">
                        <Text size="sm" tone="muted">
                            Reason for disabling
                        </Text>
                        <Text className="mt-1 max-w-full wrap-anywhere">
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
                <div
                    aria-label="Scheduled job actions"
                    className="mt-6 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap"
                    role="toolbar"
                >
                    <Button
                        className="w-full sm:w-auto"
                        disabled={actionBusy}
                        onClick={onRun}
                        variant="secondary"
                    >
                        <Icon icon={Play} size="sm" tone="inherit" />
                        Run now
                    </Button>
                    <Button
                        className="w-full sm:w-auto"
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onSetEnabled}
                        variant="secondary"
                    >
                        <Icon icon={Power} size="sm" tone="inherit" />
                        {job.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                        className="w-full sm:w-auto"
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onEdit}
                        variant="secondary"
                    >
                        <Icon icon={Pencil} size="sm" tone="inherit" />
                        Edit settings
                    </Button>
                    <Button
                        className="w-full sm:w-auto"
                        disabled={actionBusy || !definitionControlsAvailable}
                        onClick={onDelete}
                        variant="danger"
                    >
                        <Icon icon={Trash2} size="sm" tone="inherit" />
                        Delete
                    </Button>
                </div>
            </Card>

            <Card aria-labelledby={historyHeadingId} className="max-w-full min-w-0">
                <Heading id={historyHeadingId} level={3}>
                    OpenClaw run history
                </Heading>
                <Text className="mt-1" tone="muted">
                    These runs belong to OpenClaw and are separate from Dashboard
                    background jobs.
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
                        message="The latest refresh failed, so the most recent available run history is shown."
                        variant="info"
                    />
                )}
                {runs !== undefined && runs.runs.length === 0 && (
                    <Text className="mt-5" tone="muted">
                        No run history is available for this OpenClaw job.
                    </Text>
                )}
                {runs !== undefined && runs.runs.length > 0 && (
                    <ol
                        aria-label={`OpenClaw runs for ${job.name}`}
                        className="mt-5 grid max-w-full min-w-0 grid-cols-1 gap-3"
                    >
                        {runs.runs.map((run, index) => (
                            <li
                                className="border-primary-700 bg-primary-900/40 max-w-full min-w-0 rounded-lg border p-3 sm:p-4"
                                key={run.runId ?? `${run.completedAtMs}-${index}`}
                            >
                                <dl className="grid max-w-full min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Completed
                                        </dt>
                                        <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                            {dateTime(run.completedAtMs)}
                                        </dd>
                                    </div>
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Status
                                        </dt>
                                        <dd className="mt-1">
                                            <Badge variant={runBadgeVariant(run.status)}>
                                                {openClawCronRunStatusLabel(run.status)}
                                            </Badge>
                                        </dd>
                                    </div>
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Delivery
                                        </dt>
                                        <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                            {openClawCronDeliveryStatusLabel(
                                                run.deliveryStatus
                                            )}
                                        </dd>
                                    </div>
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Duration
                                        </dt>
                                        <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                            {run.durationMs === undefined
                                                ? "—"
                                                : `${run.durationMs} ms`}
                                        </dd>
                                    </div>
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Model
                                        </dt>
                                        <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere">
                                            {run.model ?? "—"}
                                            {run.modelTruncated && " (shortened)"}
                                        </dd>
                                    </div>
                                    <div className="min-w-0">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Provider
                                        </dt>
                                        <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere">
                                            {run.provider ?? "—"}
                                            {run.providerTruncated && " (shortened)"}
                                        </dd>
                                    </div>
                                    <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                            Summary
                                        </dt>
                                        <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere whitespace-pre-wrap">
                                            {run.summary ?? run.errorReason ?? "—"}
                                            {run.summaryTruncated &&
                                                " (shortened preview)"}
                                        </dd>
                                    </div>
                                </dl>
                            </li>
                        ))}
                    </ol>
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
                        More OpenClaw run history is available.
                    </Text>
                )}
            </Card>
        </div>
    );
}
