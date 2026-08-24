import { Activity, Braces, Package, SquareTerminal } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
    jobRunEventMessageMaximumLength,
    jobRunEventProgressMaximumBytes,
    jobRunResultMaximumBytes,
    type JobRunEvent,
    type JobRunSummary,
} from "../../contracts/jobModel.ts";
import { type JobRunDetail as JobRunDetailData } from "../../contracts/jobs.ts";
import type { JsonObject } from "../../shared/json.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { Text } from "../ui/Text.tsx";
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "./jobRunPresentation.ts";

const browserTruncationSuffix = "\n… [display truncated]";

function boundedDisplayText(value: string, maximumCharacters: number): string {
    if (value.length <= maximumCharacters) return value;
    return `${value.slice(
        0,
        Math.max(0, maximumCharacters - browserTruncationSuffix.length)
    )}${browserTruncationSuffix}`;
}

/**
 * Pretty printing adds whitespace, so clamp the browser text after serialization.
 * @returns Safe JSON text bounded for one browser rendering surface.
 */
function boundedJsonText(value: JsonObject, maximumCharacters: number): string {
    return boundedDisplayText(JSON.stringify(value, undefined, 2), maximumCharacters);
}

function jobRunEventBadgeVariant(
    kind: JobRunEvent["kind"]
): "danger" | "default" | "info" | "success" | "warning" {
    switch (kind) {
        case "failed":
        case "stderr":
        case "timed-out": {
            return "danger";
        }
        case "progress":
        case "stdout": {
            return "info";
        }
        case "succeeded": {
            return "success";
        }
        case "cancel-requested":
        case "cancelled":
        case "lease-expired":
        case "retry-scheduled": {
            return "warning";
        }
        case "claimed":
        case "output-truncated":
        case "queued": {
            return "default";
        }
    }
}

interface CancellationPresentation {
    readonly busyLabel: string;
    readonly enabled: boolean;
    readonly label: string;
}

function cancellationPresentation(
    run: JobRunSummary
): CancellationPresentation | undefined {
    if (run.state !== "queued" && run.state !== "running") return undefined;
    if (run.cancelRequestedAtMs !== undefined) {
        return {
            busyLabel: "Requesting cancellation…",
            enabled: false,
            label: "Cancellation requested",
        };
    }
    if (run.state === "queued" && run.cancellationPolicy !== "never") {
        return {
            busyLabel: "Cancelling run…",
            enabled: true,
            label: "Cancel queued run",
        };
    }
    if (run.state === "running" && run.cancellationPolicy === "cooperative") {
        return {
            busyLabel: "Requesting cancellation…",
            enabled: true,
            label: "Request cancellation",
        };
    }
    return {
        busyLabel: "Requesting cancellation…",
        enabled: false,
        label: "Cancellation unavailable",
    };
}

function formatDuration(durationMs: number): string {
    if (durationMs % 3_600_000 === 0) return `${durationMs / 3_600_000} h`;
    if (durationMs % 60_000 === 0) return `${durationMs / 60_000} min`;
    if (durationMs % 1000 === 0) return `${durationMs / 1000} s`;
    return `${durationMs} ms`;
}

interface DetailValueProps {
    readonly children: ReactNode;
    readonly label: string;
}

function DetailValue({ children, label }: DetailValueProps) {
    return (
        <div className="border-primary-600 bg-primary-800 rounded-lg border p-3">
            <dt className="text-primary-400 text-xs font-semibold tracking-wide uppercase">
                {label}
            </dt>
            <dd className="text-primary-200 mt-1 text-sm wrap-anywhere">{children}</dd>
        </div>
    );
}

interface TimestampValueProps {
    readonly timestampMs: number | undefined;
}

function TimestampValue({ timestampMs }: TimestampValueProps) {
    if (timestampMs === undefined) {
        return <span className="text-primary-400">Not yet</span>;
    }
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

interface JobRunEventItemProps {
    readonly event: JobRunEvent;
}

function JobRunEventItem({ event }: JobRunEventItemProps) {
    const eventLabel = event.kind.replaceAll("-", " ");
    const attemptLabel =
        event.attempt === 0 ? "before first attempt" : `attempt ${event.attempt}`;
    const message =
        event.message === undefined
            ? undefined
            : boundedDisplayText(event.message, jobRunEventMessageMaximumLength);
    const outputEvent = event.kind === "stderr" || event.kind === "stdout";

    return (
        <article
            aria-label={`Event ${event.sequence}: ${eventLabel}`}
            className="border-primary-600 bg-primary-800 rounded-lg border p-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge
                        className="capitalize"
                        variant={jobRunEventBadgeVariant(event.kind)}
                    >
                        {eventLabel}
                    </Badge>
                    <Text as="span" size="sm" tone="muted">
                        Event {event.sequence} ·{" "}
                        {event.attempt === 0
                            ? "Before first attempt"
                            : `Attempt ${event.attempt}`}
                    </Text>
                </div>
                <time
                    className="text-primary-400 text-xs"
                    dateTime={new Date(event.occurredAtMs).toISOString()}
                >
                    {formatDashboardDateTime(event.occurredAtMs)}
                </time>
            </div>

            {message !== undefined &&
                (outputEvent ? (
                    <section
                        aria-label={`${eventLabel} output, event ${event.sequence}, ${attemptLabel}`}
                        className="bg-primary-950 text-primary-200 focus-visible:ring-accent-400/30 mt-3 max-h-72 overflow-auto rounded-md p-3 text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:ring-2"
                        tabIndex={0}
                    >
                        <pre className="wrap-anywhere whitespace-pre-wrap">{message}</pre>
                    </section>
                ) : (
                    <Text className="mt-3 wrap-anywhere whitespace-pre-wrap">
                        {message}
                    </Text>
                ))}
            {event.progress !== undefined && (
                <section
                    aria-label={`Progress data, event ${event.sequence}, ${attemptLabel}`}
                    className="bg-primary-950 text-primary-200 focus-visible:ring-accent-400/30 mt-3 max-h-72 overflow-auto rounded-md p-3 text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:ring-2"
                    tabIndex={0}
                >
                    <pre className="wrap-anywhere whitespace-pre-wrap">
                        {boundedJsonText(event.progress, jobRunEventProgressMaximumBytes)}
                    </pre>
                </section>
            )}
            {event.workerInstanceId !== undefined && (
                <Text className="mt-2 wrap-anywhere" size="sm" tone="muted">
                    Worker <code>{event.workerInstanceId}</code>
                </Text>
            )}
        </article>
    );
}

export interface JobRunDetailProps {
    readonly cancelBusy: boolean;
    readonly cancelDisabled?: boolean;
    readonly detail: JobRunDetailData;
    readonly embedded?: boolean;
    readonly focusRequested?: boolean;
    readonly onCancel: (id: string) => void;
    readonly onFocusHandled?: (id: string) => void;
    readonly pagination?: InfiniteScrollContinuation;
}

/** @returns Safe, bounded durable run metadata, result, and newest-first event history. */
export function JobRunDetail({
    cancelBusy,
    cancelDisabled = false,
    detail,
    embedded = false,
    focusRequested = false,
    onCancel,
    onFocusHandled,
    pagination,
}: JobRunDetailProps) {
    const { run } = detail;
    const cancellation = cancellationPresentation(run);
    const events = detail.events;
    const headingId = `job-run-${run.id}-heading`;
    const cancellationActionable = cancellation?.enabled === true;
    const [cancellationFocus, setCancellationFocus] = useState({
        actionable: cancellationActionable,
        restore: false,
        runId: run.id,
    });
    if (
        cancellationFocus.runId !== run.id ||
        cancellationFocus.actionable !== cancellationActionable
    ) {
        setCancellationFocus((current) => ({
            actionable: cancellationActionable,
            restore:
                current.runId === run.id && current.actionable && !cancellationActionable,
            runId: run.id,
        }));
    }
    const shouldRestoreCancellationFocus =
        !cancelBusy && !cancellationActionable && cancellationFocus.restore;

    function restoreCancellationFocus(element: HTMLDivElement | null): void {
        if (!shouldRestoreCancellationFocus || element === null) return;
        setCancellationFocus((current) => ({ ...current, restore: false }));
        element.querySelector<HTMLElement>(`#${headingId}`)?.focus();
    }

    function focusRequestedHeading(element: HTMLHeadingElement | null): void {
        if (!focusRequested || element === null) return;
        element.focus();
        onFocusHandled?.(run.id);
    }

    return (
        <Card
            aria-labelledby={headingId}
            className={
                embedded
                    ? "rounded-none border-0 bg-transparent p-0 shadow-none"
                    : undefined
            }
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0" ref={restoreCancellationFocus}>
                    <div className="flex flex-wrap items-center gap-2">
                        <Heading
                            className="wrap-anywhere"
                            id={headingId}
                            level={2}
                            ref={focusRequestedHeading}
                            tabIndex={-1}
                        >
                            {run.displayName}
                        </Heading>
                        <output
                            aria-atomic="true"
                            aria-label="Run state"
                            aria-live="polite"
                        >
                            <Badge
                                className="capitalize"
                                variant={jobRunStateBadgeVariant(run.state)}
                            >
                                {jobRunStateLabel(run.state)}
                            </Badge>
                        </output>
                    </div>
                    <Text className="mt-1 font-mono wrap-anywhere" size="sm" tone="muted">
                        {run.actionKey}
                    </Text>
                </div>
                {cancellation !== undefined && (
                    <Button
                        aria-label={`${cancellation.label}: ${run.displayName}`}
                        busy={cancelBusy && cancellation.enabled}
                        busyLabel={cancellation.busyLabel}
                        disabled={cancelDisabled || !cancellation.enabled}
                        onClick={() => onCancel(run.id)}
                        size="sm"
                        variant="danger"
                    >
                        {cancellation.label}
                    </Button>
                )}
            </div>

            {run.cancelRequestedAtMs !== undefined && (
                <output className="mt-3 block">
                    <Text as="span" tone="warning">
                        Cancellation requested at{" "}
                        {formatDashboardDateTime(run.cancelRequestedAtMs)}.
                    </Text>
                </output>
            )}

            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <DetailValue label="Run ID">
                    <code>{run.id}</code>
                </DetailValue>
                <DetailValue label="Started by">
                    <span className="capitalize">{run.triggerType}</span>
                    {run.scheduledJobId === undefined ? null : (
                        <span className="mt-1 block font-mono text-xs">
                            {run.scheduledJobId} · version {run.scheduledJobVersion}
                        </span>
                    )}
                </DetailValue>
                <DetailValue label="Work size">
                    <span className="capitalize">{run.resourceClass}</span> · priority{" "}
                    {run.priority}
                </DetailValue>
                <DetailValue label="Attempts">
                    {run.attemptCount} of {run.attemptLimit}
                </DetailValue>
                <DetailValue label="Queued">
                    <TimestampValue timestampMs={run.queuedAtMs} />
                </DetailValue>
                <DetailValue label="Ready to start">
                    <TimestampValue timestampMs={run.availableAtMs} />
                </DetailValue>
                <DetailValue label="Started">
                    <TimestampValue timestampMs={run.firstStartedAtMs} />
                </DetailValue>
                <DetailValue label="Finished">
                    <TimestampValue timestampMs={run.finishedAtMs} />
                </DetailValue>
                <DetailValue label="Timeout">{formatDuration(run.timeoutMs)}</DetailValue>
                <DetailValue label="Cancellation">
                    {run.cancellationPolicy === "cooperative"
                        ? "Supported"
                        : "Not supported"}
                </DetailValue>
                <DetailValue label="Safe to retry">
                    {run.retrySafe ? "Yes" : "No"}
                </DetailValue>
                <DetailValue label="Status update">{run.stateVersion}</DetailValue>
            </dl>

            {run.resourceKeys.length > 0 && (
                <section aria-labelledby={`${headingId}-resources`} className="mt-5">
                    <div className="flex items-center gap-2">
                        <Icon icon={Package} tone="accent" />
                        <Heading id={`${headingId}-resources`} level={3}>
                            Reserved resources
                        </Heading>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-2">
                        {run.resourceKeys.map((resourceKey) => (
                            <li key={resourceKey}>
                                <Badge>
                                    <code className="wrap-anywhere">{resourceKey}</code>
                                </Badge>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {run.terminalCode !== undefined && run.terminalMessage !== undefined && (
                <section
                    aria-labelledby={`${headingId}-terminal`}
                    className="border-primary-600 bg-primary-800 mt-5 rounded-lg border p-4"
                >
                    <div className="flex items-center gap-2">
                        <Icon icon={SquareTerminal} tone="accent" />
                        <Heading id={`${headingId}-terminal`} level={3}>
                            Terminal status
                        </Heading>
                    </div>
                    <Text
                        className="mt-2 font-mono wrap-anywhere"
                        size="sm"
                        tone="danger"
                    >
                        {run.terminalCode}
                    </Text>
                    <Text className="mt-1 wrap-anywhere whitespace-pre-wrap">
                        {run.terminalMessage}
                    </Text>
                </section>
            )}

            {detail.result !== undefined && (
                <section aria-labelledby={`${headingId}-result`} className="mt-5">
                    <div className="flex items-center gap-2">
                        <Icon icon={Braces} tone="accent" />
                        <Heading id={`${headingId}-result`} level={3}>
                            Result
                        </Heading>
                    </div>
                    <section
                        aria-label={`Result for job run ${run.id}`}
                        className="border-primary-600 bg-primary-800 text-primary-200 focus-visible:ring-accent-400/30 mt-2 max-h-96 overflow-auto rounded-lg border p-3 text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:ring-2"
                        tabIndex={0}
                    >
                        <pre className="wrap-anywhere whitespace-pre-wrap">
                            {boundedJsonText(detail.result, jobRunResultMaximumBytes)}
                        </pre>
                    </section>
                </section>
            )}

            <section aria-labelledby={`${headingId}-events`} className="mt-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <Icon icon={Activity} tone="accent" />
                        <Heading id={`${headingId}-events`} level={3}>
                            Job activity
                        </Heading>
                    </div>
                    <Text size="sm" tone="muted">
                        Newest first · {run.eventCount} total
                    </Text>
                </div>
                {events.length === 0 ? (
                    <output className="mt-3 block">
                        <Text as="span" tone="muted">
                            No activity has been recorded.
                        </Text>
                    </output>
                ) : (
                    <VirtualizedList
                        className="mt-3"
                        estimateSize={() => 132}
                        getKey={(event) => String(event.sequence)}
                        itemClassName="pb-3"
                        items={events}
                        label="Job activity"
                        pagination={pagination}
                        renderItem={(event) => <JobRunEventItem event={event} />}
                    />
                )}
            </section>
        </Card>
    );
}
