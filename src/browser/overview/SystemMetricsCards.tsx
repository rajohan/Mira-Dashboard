import {
    ArrowDown,
    ArrowUp,
    Clock,
    Cpu,
    Database,
    Gauge,
    Globe2,
    HardDrive,
    MemoryStick,
    MessagesSquare,
    RadioTower,
    RefreshCw,
    Server,
    Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

import type { SystemMetrics } from "../../contracts/system.ts";
import {
    formatBitsPerSecond,
    formatByteCount,
    formatLoadValue,
    formatPercent,
    formatUptime,
} from "../lib/formatMeasurements.ts";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { Text } from "../ui/Text.tsx";

function capacityDescription(capacity: SystemMetrics["memory"]): string {
    return `${formatByteCount(capacity.usedBytes)} of ${formatByteCount(capacity.totalBytes)}`;
}

function loadAverageDescription(cpu: SystemMetrics["cpu"]): string {
    return cpu.loadAverage.map((load) => formatLoadValue(load)).join(", ");
}

function networkValue(
    state: SystemMetrics["network"]["state"],
    bitsPerSecond: number
): string {
    return state === "warming" ? "Measuring…" : formatBitsPerSecond(bitsPerSecond);
}

interface SystemMetricsCardsProps {
    readonly fallback?: ReactNode;
    readonly intermediateContent?: ReactNode;
    readonly leadingCard?: ReactNode;
    readonly metrics?: SystemMetrics;
}

function averageDuration(metric: {
    readonly requestCount: number;
    readonly totalDurationMs: number;
}): number {
    return metric.requestCount === 0
        ? 0
        : Math.round(metric.totalDurationMs / metric.requestCount);
}

function formatMilliseconds(milliseconds: number): string {
    return `${milliseconds.toLocaleString()} ms`;
}

function httpMetricTotals(
    procedures: SystemMetrics["application"]["http"]["procedures"]
): Readonly<{
    readonly errors: number;
    readonly maximumDurationMs: number;
    readonly requests: number;
}> {
    let errors = 0;
    let maximumDurationMs = 0;
    let requests = 0;
    for (const procedure of procedures) {
        errors += procedure.errorCount;
        maximumDurationMs = Math.max(maximumDurationMs, procedure.maximumDurationMs);
        requests += procedure.requestCount;
    }
    return { errors, maximumDurationMs, requests };
}

/** @returns Host gauges and independently degradable application observations. */
export function SystemMetricsCards({
    fallback,
    intermediateContent,
    leadingCard,
    metrics,
}: SystemMetricsCardsProps) {
    if (metrics === undefined) {
        return (
            <div className="space-y-4">
                <div
                    aria-label="Host metrics"
                    className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                >
                    {leadingCard}
                    {fallback}
                </div>
                {intermediateContent}
            </div>
        );
    }
    const httpTotals = httpMetricTotals(metrics.application.http.procedures);
    return (
        <div className="space-y-4">
            <div
                aria-label="Host metrics"
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
                {leadingCard}
                <MetricCard
                    compact
                    compactSummary
                    description={loadAverageDescription(metrics.cpu)}
                    icon={Cpu}
                    meter={{
                        label: "CPU load",
                        maximum: 100,
                        value: metrics.cpu.loadPercent,
                    }}
                    title="CPU"
                    value={formatPercent(metrics.cpu.loadPercent)}
                />
                <MetricCard
                    compact
                    compactSummary
                    description={capacityDescription(metrics.memory)}
                    icon={MemoryStick}
                    meter={{
                        label: "Memory used",
                        maximum: 100,
                        value: metrics.memory.usedPercent,
                    }}
                    title="Memory"
                    value={formatPercent(metrics.memory.usedPercent)}
                />
                <MetricCard
                    compact
                    compactSummary
                    description={capacityDescription(metrics.disk)}
                    icon={HardDrive}
                    meter={{
                        label: "Disk used",
                        maximum: 100,
                        value: metrics.disk.usedPercent,
                    }}
                    title="Disk"
                    value={formatPercent(metrics.disk.usedPercent)}
                />
                <MetricCard
                    compact
                    icon={Clock}
                    title="Uptime"
                    value={formatUptime(metrics.uptimeSeconds)}
                />
                <MetricCard
                    compact
                    icon={ArrowDown}
                    title="Download"
                    value={networkValue(
                        metrics.network.state,
                        metrics.network.downloadBitsPerSecond
                    )}
                />
                <MetricCard
                    compact
                    icon={ArrowUp}
                    title="Upload"
                    value={networkValue(
                        metrics.network.state,
                        metrics.network.uploadBitsPerSecond
                    )}
                />
            </div>
            {intermediateContent}
            <div>
                <div
                    aria-label="Application metrics"
                    className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
                >
                    <MetricCard
                        description={
                            metrics.application.web.state === "observed"
                                ? `${formatByteCount(metrics.application.web.heapUsedBytes)} / ${formatByteCount(metrics.application.web.heapTotalBytes)} heap · ${formatByteCount(metrics.application.web.externalBytes)} external · ${formatMilliseconds(metrics.application.web.eventLoopDelayMs)} event-loop delay · ${formatUptime(metrics.application.web.uptimeSeconds)} uptime.`
                                : "Web-process metrics could not be observed."
                        }
                        icon={Server}
                        iconPosition="leading"
                        title="Web runtime"
                        value={
                            metrics.application.web.state === "observed"
                                ? formatByteCount(metrics.application.web.rssBytes)
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.operations.state === "observed"
                                ? `${metrics.application.operations.succeededRuns.toLocaleString()} succeeded · ${metrics.application.operations.failedRuns.toLocaleString()} failed, cancelled, or timed out · ${formatMilliseconds(metrics.application.operations.averageDurationMs)} average · ${formatMilliseconds(metrics.application.operations.maximumDurationMs)} maximum across the newest ${metrics.application.operations.sampledRuns.toLocaleString()} runs.`
                                : "Durable external-operation metrics could not be observed."
                        }
                        icon={Workflow}
                        iconPosition="leading"
                        title="Durable operations"
                        value={
                            metrics.application.operations.state === "observed"
                                ? `${metrics.application.operations.activeRuns.toLocaleString()} active`
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.jobs.state === "observed"
                                ? `${metrics.application.jobs.queuedRuns.toLocaleString()} queued · ${metrics.application.jobs.workers.online.toLocaleString()} / ${metrics.application.jobs.workers.capacity.toLocaleString()} workers online · ${formatMilliseconds(metrics.application.jobs.scheduleLagMs)} schedule lag${metrics.application.jobs.claimingPaused ? " · claims paused" : ""}.`
                                : "Queue and worker metrics could not be observed."
                        }
                        icon={Server}
                        iconPosition="leading"
                        title="Jobs"
                        value={
                            metrics.application.jobs.state === "observed"
                                ? `${metrics.application.jobs.runningRuns.toLocaleString()} running`
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.chat.state === "observed"
                                ? `${metrics.application.chat.retainedRuns.toLocaleString()} retained runs · ${metrics.application.chat.retainedEvents.toLocaleString()} events (${formatByteCount(metrics.application.chat.retainedEventBytes)}) · ${metrics.application.chat.retainedSnapshots.toLocaleString()} snapshots (${formatByteCount(metrics.application.chat.retainedSnapshotBytes)}) · ${metrics.application.chat.failedOrUnknownRuns.toLocaleString()} failed or uncertain.`
                                : "Durable chat-runtime metrics could not be observed."
                        }
                        icon={MessagesSquare}
                        iconPosition="leading"
                        title="Chat runtime"
                        value={
                            metrics.application.chat.state === "observed"
                                ? `${metrics.application.chat.activeRuns.toLocaleString()} active`
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.sqlite.state === "observed"
                                ? `${formatByteCount(metrics.application.sqlite.freeBytes)} reusable · ${metrics.application.sqlite.freePages.toLocaleString()} free pages · ${formatMilliseconds(metrics.application.sqlite.readLatencyMs)} read latency.`
                                : "SQLite storage and latency metrics could not be observed."
                        }
                        icon={Database}
                        iconPosition="leading"
                        title="SQLite runtime"
                        value={
                            metrics.application.sqlite.state === "observed"
                                ? formatByteCount(metrics.application.sqlite.storageBytes)
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.gateway.state === "observed"
                                ? `${metrics.application.gateway.freshness} observation · ${metrics.application.gateway.reconnectAttempt.toLocaleString()} reconnect attempts.`
                                : "Gateway connection metrics could not be observed."
                        }
                        icon={RadioTower}
                        iconPosition="leading"
                        title="Gateway"
                        value={
                            metrics.application.gateway.state === "observed"
                                ? metrics.application.gateway.phase.replaceAll("-", " ")
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.realtime.state === "observed"
                                ? `${metrics.application.realtime.polls.toLocaleString()} polls · ${metrics.application.realtime.pollFailures.toLocaleString()} failures · ${metrics.application.realtime.forcedResyncs.toLocaleString()} forced resyncs · ${metrics.application.realtime.droppedSlowSubscribers.toLocaleString()} slow subscribers dropped.`
                                : "Realtime pump metrics could not be observed."
                        }
                        icon={Gauge}
                        iconPosition="leading"
                        title="Realtime"
                        value={
                            metrics.application.realtime.state === "observed"
                                ? `${metrics.application.realtime.activeSubscribers.toLocaleString()} subscribers`
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={
                            metrics.application.cache.state === "observed"
                                ? `${metrics.application.cache.staleEntryCount.toLocaleString()} stale · ${metrics.application.cache.missingEntryCount.toLocaleString()} missing · ${metrics.application.cache.failedEntryCount.toLocaleString()} failed · ${formatMilliseconds(metrics.application.cache.maximumAttemptDurationMs)} maximum refresh.`
                                : "Cache refresh metrics could not be observed."
                        }
                        icon={RefreshCw}
                        iconPosition="leading"
                        title="Cache"
                        value={
                            metrics.application.cache.state === "observed"
                                ? `${metrics.application.cache.entryCount.toLocaleString()} entries`
                                : "Unavailable"
                        }
                    />
                    <MetricCard
                        description={`${httpTotals.errors.toLocaleString()} errors · ${formatMilliseconds(httpTotals.maximumDurationMs)} maximum duration across fixed procedure buckets.`}
                        icon={Globe2}
                        iconPosition="leading"
                        title="HTTP requests"
                        value={httpTotals.requests.toLocaleString()}
                    />
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <Card aria-labelledby="cache-snapshot-metrics-heading">
                        <div className="flex items-center gap-2">
                            <RefreshCw
                                aria-hidden="true"
                                className="text-accent-300 size-5"
                            />
                            <Heading id="cache-snapshot-metrics-heading" level={3}>
                                Cache snapshots
                            </Heading>
                        </div>
                        <Text className="mt-1" tone="muted">
                            Payload-free state for each registered cache projection.
                        </Text>
                        {metrics.application.cache.state === "unavailable" ? (
                            <Text className="mt-4" tone="muted">
                                Cache snapshot diagnostics are unavailable.
                            </Text>
                        ) : (
                            <>
                                {metrics.application.cache.snapshots.length === 0 ? (
                                    <Text className="mt-4" tone="muted">
                                        No registered cache snapshots have been attempted.
                                    </Text>
                                ) : (
                                    <section
                                        aria-label="Cache snapshot metrics scroll area"
                                        className="border-primary-700/70 focus-visible:ring-accent-300 mt-4 max-h-64 overflow-y-auto border-t pt-2 focus-visible:ring-2 focus-visible:outline-none"
                                        tabIndex={0}
                                    >
                                        <ul
                                            aria-label="Cache snapshot metrics"
                                            className="space-y-1"
                                        >
                                            {metrics.application.cache.snapshots.map(
                                                (snapshot) => (
                                                    <li
                                                        className="bg-primary-900/45 rounded px-2 py-1.5"
                                                        key={snapshot.key}
                                                    >
                                                        <Text
                                                            as="span"
                                                            className="font-medium"
                                                            size="sm"
                                                        >
                                                            {snapshot.key}
                                                        </Text>
                                                        <Text
                                                            className="mt-0.5"
                                                            size="sm"
                                                            tone="muted"
                                                        >
                                                            {snapshot.freshness} ·{" "}
                                                            {snapshot.attemptCount.toLocaleString()}{" "}
                                                            attempts ·{" "}
                                                            {snapshot.consecutiveFailures.toLocaleString()}{" "}
                                                            consecutive failures ·{" "}
                                                            {formatMilliseconds(
                                                                snapshot.lastAttemptDurationMs
                                                            )}{" "}
                                                            last refresh
                                                        </Text>
                                                    </li>
                                                )
                                            )}
                                        </ul>
                                    </section>
                                )}
                            </>
                        )}
                    </Card>
                    <Card aria-labelledby="http-procedure-metrics-heading">
                        <div className="flex items-center gap-2">
                            <Globe2
                                aria-hidden="true"
                                className="text-accent-300 size-5"
                            />
                            <Heading id="http-procedure-metrics-heading" level={3}>
                                HTTP procedures
                            </Heading>
                        </div>
                        <Text className="mt-1" tone="muted">
                            Fixed procedure buckets; arbitrary routes remain in overflow.
                        </Text>
                        <section
                            aria-label="HTTP procedure metrics scroll area"
                            className="border-primary-700/70 focus-visible:ring-accent-300 mt-4 max-h-64 overflow-y-auto border-t pt-2 focus-visible:ring-2 focus-visible:outline-none"
                            tabIndex={0}
                        >
                            <ul aria-label="HTTP procedure metrics" className="space-y-1">
                                {metrics.application.http.procedures.map((procedure) => (
                                    <li
                                        className="bg-primary-900/45 rounded px-2 py-1.5"
                                        key={procedure.procedure}
                                    >
                                        <Text as="span" className="font-medium" size="sm">
                                            {procedure.procedure}
                                        </Text>
                                        <Text className="mt-0.5" size="sm" tone="muted">
                                            {procedure.requestCount.toLocaleString()}{" "}
                                            requests ·{" "}
                                            {procedure.errorCount.toLocaleString()} errors
                                            ·{" "}
                                            {formatMilliseconds(
                                                averageDuration(procedure)
                                            )}{" "}
                                            average ·{" "}
                                            {formatMilliseconds(
                                                procedure.maximumDurationMs
                                            )}{" "}
                                            maximum
                                        </Text>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    </Card>
                </div>
            </div>
        </div>
    );
}
