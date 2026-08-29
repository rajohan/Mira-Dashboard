import { Pencil, Play, Power, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

import type { GatewaySession } from "../../contracts/gatewaySessions.ts";
import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InfiniteScrollTrigger } from "../ui/InfiniteScrollTrigger.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import type { OpenClawCronRunsView } from "./openClawCronQueries.ts";
import {
    openClawCronDeliveryModeLabel,
    openClawCronDeliveryStatusLabel,
    openClawCronPayloadLabel,
    openClawCronPayloadMessage,
    openClawCronRunStatusBadgeVariant,
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
    readonly heartbeatSession?: GatewaySession;
    readonly heartbeatSessionStatus?: "loading" | "ready" | "unavailable";
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

/** @returns Bounded OpenClaw definition, controls, and Gateway-owned run history. */
export function OpenClawCronDetail({
    actionBusy,
    actionError,
    definitionControlsAvailable,
    job,
    heartbeatSession,
    heartbeatSessionStatus = heartbeatSession === undefined ? "loading" : "ready",
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
    const isHeartbeat = job.payload.kind === "heartbeat";
    const message = (() => {
        if (job.payload.kind === "agent-turn") return job.payload.message;
        if (job.payload.kind === "system-event") return job.payload.text;
        if (job.payload.kind === "heartbeat") return job.scratch?.content;
        return openClawCronPayloadMessage(job.payload.kind);
    })();
    let configuredModel: string | undefined;
    if (job.payload.kind === "agent-turn") configuredModel = job.payload.model;
    else if (isHeartbeat) configuredModel = heartbeatSession?.model;
    const heartbeatSetting = (value: string | undefined): string => {
        if (heartbeatSessionStatus === "loading") return "Loading…";
        if (heartbeatSessionStatus === "unavailable") return "Unavailable";
        return value ?? "Default";
    };
    const delivery = job.delivery;
    const definitionRows: readonly (readonly [string, ReactNode])[] = [
        ["Schedule", openClawCronScheduleLabel(job)],
        ...(job.agentId === undefined ? [] : ([["Agent", job.agentId]] as const)),
        ["Session", openClawCronSessionTargetLabel(job.sessionTarget)],
        ["Task type", openClawCronPayloadLabel(job.payload.kind)],
        ...(job.payload.kind === "skill-collection-review"
            ? ([
                  ["Owner", "OpenClaw system"],
                  [
                      "Workspace",
                      job.agentIdTruncated ? "Hidden" : (job.agentId ?? "main"),
                  ],
              ] as const)
            : []),
        ...(message === undefined
            ? []
            : ([
                  [
                      "Message",
                      <span className="line-clamp-6 whitespace-pre-wrap" key="message">
                          {message}
                      </span>,
                  ],
              ] as const)),
        ...(job.payload.kind === "agent-turn" || isHeartbeat
            ? ([
                  [
                      "Model",
                      isHeartbeat
                          ? heartbeatSetting(configuredModel)
                          : (configuredModel ?? "Default"),
                  ],
                  [
                      "Provider",
                      isHeartbeat
                          ? heartbeatSetting(heartbeatSession?.modelProvider)
                          : "Default",
                  ],
                  [
                      "Thinking",
                      job.payload.kind === "agent-turn"
                          ? (job.payload.thinking ?? "Default")
                          : heartbeatSetting(
                                heartbeatSession?.thinkingLevel ??
                                    heartbeatSession?.thinkingDefault
                            ),
                  ],
                  [
                      "Timeout",
                      job.payload.kind === "agent-turn" &&
                      job.payload.timeoutSeconds !== undefined
                          ? `${job.payload.timeoutSeconds} seconds`
                          : "Default",
                  ],
              ] as const)
            : []),
        ...(payloadRedacted ? ([["Task content", "Hidden for security"]] as const) : []),
        ["Delivery", openClawCronDeliveryModeLabel(job.deliveryMode)],
        [
            "Delivery target",
            delivery?.targetConfigured === true
                ? "Configured (hidden for security)"
                : "Not configured",
        ],
        [
            "Completion webhook",
            delivery?.completionDestinationConfigured === true
                ? "Configured (hidden for security)"
                : "Not configured",
        ],
        [
            "Failure target",
            delivery?.failureDestination?.targetConfigured === true
                ? "Configured (hidden for security)"
                : "Not configured",
        ],
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
        <div className="max-w-full min-w-0 space-y-4">
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
                            {job.enabled ? "Enabled" : "Disabled"}
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
                    Run history
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
                {runsError !== undefined && (
                    <Alert
                        action={
                            onRetryRuns === undefined ? undefined : (
                                <Button
                                    onClick={onRetryRuns}
                                    size="sm"
                                    variant="secondary"
                                >
                                    Try again
                                </Button>
                            )
                        }
                        className="mt-5"
                        focusOnError={runs === undefined}
                        message={runsError}
                    />
                )}
                {runs !== undefined && runs.freshness.kind === "last-known-good" && (
                    <Alert
                        className="mt-5"
                        focusOnError={false}
                        message="The latest refresh failed, so the most recent available run history is shown."
                        variant="warning"
                    />
                )}
                {runs !== undefined && runs.runs.length === 0 && (
                    <Text className="mt-5" tone="muted">
                        No run history is available for this OpenClaw job.
                    </Text>
                )}
                {runs !== undefined && runs.runs.length > 0 && (
                    <Virtualizer<HTMLLIElement>
                        count={runs.runs.length}
                        estimateSize={() => 210}
                        getItemKey={(index) =>
                            runs.runs[index]?.runId ??
                            `${runs.runs[index]?.completedAtMs ?? "missing"}-${index}`
                        }
                        initialRect={{ height: 560, width: 960 }}
                        overscan={4}
                    >
                        {({
                            containerRef,
                            measureElement,
                            scrollContainerRef,
                            virtualItems,
                        }) => {
                            const visibleRuns =
                                virtualItems.length > 0
                                    ? virtualItems
                                    : runs.runs.slice(0, 7).map((run, index) => ({
                                          index,
                                          key:
                                              run.runId ??
                                              `${run.completedAtMs}-${index}`,
                                          start: index * 210,
                                      }));
                            const historyHeight = runs.runs.length * 210;
                            return (
                                <section
                                    aria-label="OpenClaw run history"
                                    className="mt-5 h-[min(42rem,65dvh)] min-h-72 overflow-x-hidden overflow-y-auto overscroll-contain"
                                    ref={scrollContainerRef}
                                    tabIndex={0}
                                >
                                    <ol
                                        aria-label={`OpenClaw runs for ${job.name}`}
                                        className="relative max-w-full min-w-0"
                                        ref={containerRef}
                                        style={
                                            virtualItems.length > 0
                                                ? undefined
                                                : { height: historyHeight }
                                        }
                                    >
                                        {visibleRuns.map((virtualItem) => {
                                            const run = runs.runs[virtualItem.index];
                                            if (run === undefined) return null;
                                            return (
                                                <li
                                                    className="border-primary-700 bg-primary-900/40 absolute top-0 left-0 w-full max-w-full min-w-0 rounded-lg border p-3 sm:p-4"
                                                    data-index={virtualItem.index}
                                                    key={virtualItem.key}
                                                    ref={measureElement}
                                                    style={
                                                        virtualItems.length > 0
                                                            ? undefined
                                                            : {
                                                                  transform: `translateY(${virtualItem.start}px)`,
                                                              }
                                                    }
                                                >
                                                    <dl className="grid max-w-full min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                                                        <div className="min-w-0">
                                                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                                                Completed
                                                            </dt>
                                                            <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                                                {dateTime(
                                                                    run.completedAtMs
                                                                )}
                                                            </dd>
                                                        </div>
                                                        <div className="min-w-0">
                                                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                                                Status
                                                            </dt>
                                                            <dd className="mt-1">
                                                                <Badge
                                                                    variant={openClawCronRunStatusBadgeVariant(
                                                                        run.status
                                                                    )}
                                                                >
                                                                    {openClawCronRunStatusLabel(
                                                                        run.status
                                                                    )}
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
                                                                {run.durationMs ===
                                                                undefined
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
                                                                {run.model !==
                                                                    undefined &&
                                                                    run.modelTruncated &&
                                                                    " (shortened)"}
                                                            </dd>
                                                        </div>
                                                        <div className="min-w-0">
                                                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                                                Provider
                                                            </dt>
                                                            <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere">
                                                                {run.provider ?? "—"}
                                                                {run.provider !==
                                                                    undefined &&
                                                                    run.providerTruncated &&
                                                                    " (shortened)"}
                                                            </dd>
                                                        </div>
                                                        <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                                                            <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                                                Summary
                                                            </dt>
                                                            <dd className="text-primary-100 mt-1 max-w-full text-sm wrap-anywhere whitespace-pre-wrap">
                                                                {run.summary ??
                                                                    run.errorReason ??
                                                                    "—"}
                                                                {run.summaryTruncated &&
                                                                    " (shortened preview)"}
                                                            </dd>
                                                        </div>
                                                    </dl>
                                                </li>
                                            );
                                        })}
                                    </ol>
                                    {onLoadMoreRuns !== undefined && (
                                        <InfiniteScrollTrigger
                                            hasMore={
                                                runs.hasMore && runsError === undefined
                                            }
                                            loading={runsLoadingMore}
                                            loadingLabel="Loading older runs…"
                                            onLoadMore={onLoadMoreRuns}
                                            rootRef={scrollContainerRef}
                                        />
                                    )}
                                </section>
                            );
                        }}
                    </Virtualizer>
                )}
            </Card>
        </div>
    );
}
