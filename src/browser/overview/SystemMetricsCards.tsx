import {
    Activity,
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

import type { SystemMetrics } from "../../contracts/system.ts";
import {
    formatBitsPerSecond,
    formatByteCount,
    formatLoadValue,
    formatPercent,
    formatUptime,
} from "../lib/formatMeasurements.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { Text } from "../ui/Text.tsx";

function capacityDescription(capacity: SystemMetrics["memory"]): string {
    return `${formatByteCount(capacity.usedBytes)} / ${formatByteCount(
        capacity.totalBytes
    )} · ${formatByteCount(capacity.freeBytes)} free`;
}

function networkValue(
    state: SystemMetrics["network"]["state"],
    bitsPerSecond: number
): string {
    return state === "warming" ? "Measuring…" : formatBitsPerSecond(bitsPerSecond);
}

interface SystemMetricsCardsProps {
    readonly metrics: SystemMetrics;
}

function applicationRuntimeStatus(application: SystemMetrics["application"]): Readonly<{
    readonly label: string;
    readonly variant: "danger" | "success" | "warning";
}> {
    const runtimeComponents = [
        application.web,
        application.jobs,
        application.sqlite,
        application.gateway,
        application.realtime,
        application.cache,
        application.chat,
        application.operations,
    ];
    const observedCount = runtimeComponents.filter(
        ({ state }) => state === "observed"
    ).length;
    if (observedCount === runtimeComponents.length) {
        return { label: "All observed", variant: "success" };
    }
    if (observedCount === 0) {
        return { label: "Runtime unavailable", variant: "danger" };
    }
    return {
        label: `${observedCount} of ${runtimeComponents.length} observed`,
        variant: "warning",
    };
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
export function SystemMetricsCards({ metrics }: SystemMetricsCardsProps) {
    const coreLabel = metrics.cpu.logicalCoreCount === 1 ? "CPU core" : "CPU cores";
    const applicationStatus = applicationRuntimeStatus(metrics.application);
    const httpTotals = httpMetricTotals(metrics.application.http.procedures);
    return (
        <div className="space-y-8">
            <div
                aria-label="Host metrics"
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
                <MetricCard
                    description={`Average load over 1 minute: ${formatLoadValue(metrics.cpu.loadAverage[0])} · ${metrics.cpu.logicalCoreCount} ${coreLabel}`}
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
                    description="Host uptime"
                    icon={Clock}
                    title="Uptime"
                    value={formatUptime(metrics.uptimeSeconds)}
                />
                <MetricCard
                    description="Current total download speed"
                    icon={ArrowDown}
                    title="Download"
                    value={networkValue(
                        metrics.network.state,
                        metrics.network.downloadBitsPerSecond
                    )}
                />
                <MetricCard
                    description="Current total upload speed"
                    icon={ArrowUp}
                    title="Upload"
                    value={networkValue(
                        metrics.network.state,
                        metrics.network.uploadBitsPerSecond
                    )}
                />
            </div>
            <div>
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <Heading level={3}>Application observability</Heading>
                        <Text className="mt-1" tone="muted">
                            Each runtime reader remains visible when another component is
                            unavailable.
                        </Text>
                    </div>
                    <Badge variant={applicationStatus.variant}>
                        {applicationStatus.label}
                    </Badge>
                </div>
                <div
                    aria-label="Application metrics"
                    className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
                >
                    <MetricCard
                        description={
                            metrics.application.web.state === "observed"
                                ? `${formatByteCount(metrics.application.web.heapUsedBytes)} / ${formatByteCount(metrics.application.web.heapTotalBytes)} heap · ${formatByteCount(metrics.application.web.externalBytes)} external · ${formatMilliseconds(metrics.application.web.eventLoopDelayMs)} event-loop delay · ${formatUptime(metrics.application.web.uptimeSeconds)} uptime.`
                                : "Web-process metrics could not be observed."
                        }
                        icon={Server}
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
                        icon={Activity}
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
                        title="HTTP requests"
                        value={httpTotals.requests.toLocaleString()}
                    />
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <Card aria-labelledby="cache-snapshot-metrics-heading">
                        <Heading id="cache-snapshot-metrics-heading" level={3}>
                            Cache snapshots
                        </Heading>
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
                        <Heading id="http-procedure-metrics-heading" level={3}>
                            HTTP procedures
                        </Heading>
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
