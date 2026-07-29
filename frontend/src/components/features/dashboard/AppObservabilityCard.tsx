import {
    Activity,
    ChartNoAxesCombined,
    Database,
    Gauge,
    Network,
    Radio,
    RefreshCw,
    Workflow,
} from "lucide-react";

import type { Metrics } from "../../../../../contracts/metrics";
import { formatDate, formatSize, formatUptime } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card, CardTitle } from "../../ui/Card";

interface AppObservabilityCardProperties {
    metrics: Metrics | undefined;
}

interface MetricRowProperties {
    label: string;
    value: React.ReactNode;
}

function MetricRow({ label, value }: MetricRowProperties) {
    return (
        <div className="flex items-center justify-between gap-3 text-xs">
            <dt className="min-w-0 text-primary-400">{label}</dt>
            <dd className="shrink-0 text-right font-medium text-primary-100 tabular-nums">
                {value}
            </dd>
        </div>
    );
}

interface MetricGroupProperties {
    children: React.ReactNode;
    icon: React.ReactNode;
    title: string;
}

function MetricGroup({ children, icon, title }: MetricGroupProperties) {
    return (
        <section className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
            <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-primary-100">
                <span className="text-accent-300">{icon}</span>
                {title}
            </h4>
            <dl className="space-y-2">{children}</dl>
        </section>
    );
}

function formatMilliseconds(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return "—";
    if (value < 1) return `${value.toFixed(2)} ms`;
    if (value < 100) return `${value.toFixed(1)} ms`;
    return `${Math.round(value)} ms`;
}

function formatTimestamp(value: string | undefined): string {
    return value ? formatDate(value) : "—";
}

/**
 * Renders authenticated application runtime, queue, dependency, and cache metrics.
 * @returns Rendered authenticated application runtime, queue, dependency, and cache metrics.
 */
export function AppObservabilityCard({ metrics }: AppObservabilityCardProperties) {
    if (!metrics) {
        return (
            <Card variant="bordered">
                <CardTitle>Application observability</CardTitle>
                <p className="mt-2 text-sm text-primary-400">Loading metrics…</p>
            </Card>
        );
    }

    const {
        cacheRefresh,
        database,
        gateway,
        http,
        polling,
        processes,
        runtime,
        scheduler,
    } = metrics;

    return (
        <Card variant="bordered">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <CardTitle>Application observability</CardTitle>
                    <p className="mt-1 text-xs text-primary-400">
                        Dashboard web, worker, queue, database, Gateway, HTTP, and cache
                        telemetry
                    </p>
                </div>
                <Badge
                    variant={
                        gateway.connected && scheduler.workerOnline
                            ? "success"
                            : "warning"
                    }
                >
                    {gateway.connected && scheduler.workerOnline
                        ? "Dependencies healthy"
                        : "Attention needed"}
                </Badge>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricGroup title="Runtime" icon={<Activity className="size-4" />}>
                    <MetricRow label="RSS" value={formatSize(runtime.rssBytes)} />
                    <MetricRow
                        label="Heap"
                        value={`${formatSize(runtime.heapUsedBytes)} / ${formatSize(runtime.heapTotalBytes)}`}
                    />
                    <MetricRow
                        label="External memory"
                        value={formatSize(runtime.externalBytes)}
                    />
                    <MetricRow
                        label="Event-loop lag"
                        value={formatMilliseconds(runtime.eventLoopDelayMs)}
                    />
                    <MetricRow
                        label="Process uptime"
                        value={formatUptime(runtime.uptimeSeconds)}
                    />
                </MetricGroup>

                <MetricGroup
                    title="Child processes"
                    icon={<Workflow className="size-4" />}
                >
                    <MetricRow label="Active" value={processes.active} />
                    <MetricRow label="Started" value={processes.started} />
                    <MetricRow label="Succeeded" value={processes.succeeded} />
                    <MetricRow label="Failed" value={processes.failed} />
                    <MetricRow
                        label="Last duration"
                        value={formatMilliseconds(processes.lastDurationMs)}
                    />
                    <MetricRow
                        label="Average duration"
                        value={formatMilliseconds(processes.averageDurationMs)}
                    />
                    <MetricRow
                        label="Maximum duration"
                        value={formatMilliseconds(processes.maxDurationMs)}
                    />
                </MetricGroup>

                <MetricGroup title="Scheduler" icon={<Gauge className="size-4" />}>
                    <MetricRow
                        label="Worker"
                        value={
                            <Badge variant={scheduler.workerOnline ? "success" : "error"}>
                                {scheduler.workerOnline ? "Online" : "Offline"}
                            </Badge>
                        }
                    />
                    <MetricRow
                        label="Workers / capacity"
                        value={`${scheduler.workerCount} / ${scheduler.workerCapacity}`}
                    />
                    <MetricRow
                        label="Queued / running"
                        value={`${scheduler.queued} / ${scheduler.running}`}
                    />
                    <MetricRow label="Due jobs" value={scheduler.dueJobs} />
                    <MetricRow
                        label="Schedule lag"
                        value={formatMilliseconds(scheduler.scheduleLagMs)}
                    />
                    <MetricRow label="Ticks" value={scheduler.ticks} />
                    <MetricRow
                        label="Tick / queue failures"
                        value={`${scheduler.tickFailures} / ${scheduler.queueFailures}`}
                    />
                    <MetricRow
                        label="Last tick duration"
                        value={formatMilliseconds(scheduler.lastTickDurationMs)}
                    />
                    <MetricRow
                        label="Oldest queued"
                        value={formatMilliseconds(scheduler.oldestQueuedAgeMs)}
                    />
                    <MetricRow
                        label="Last worker heartbeat"
                        value={formatTimestamp(scheduler.workerLastHeartbeatAt)}
                    />
                </MetricGroup>

                <MetricGroup title="SQLite" icon={<Database className="size-4" />}>
                    <MetricRow
                        label="Status"
                        value={
                            <Badge variant={database.available ? "success" : "error"}>
                                {database.available ? "Available" : "Unavailable"}
                            </Badge>
                        }
                    />
                    <MetricRow
                        label="Probe latency"
                        value={formatMilliseconds(database.latencyMs)}
                    />
                    <MetricRow label="Operations" value={database.operations} />
                    <MetricRow
                        label="Average / maximum"
                        value={`${formatMilliseconds(database.averageDurationMs)} / ${formatMilliseconds(database.maxDurationMs)}`}
                    />
                    <MetricRow label="Lock errors" value={database.lockErrors} />
                    <MetricRow label="Database" value={formatSize(database.fileBytes)} />
                    <MetricRow label="WAL" value={formatSize(database.walBytes)} />
                    <MetricRow label="SHM" value={formatSize(database.shmBytes)} />
                    <MetricRow
                        label="Freelist"
                        value={`${formatSize(database.freelistBytes)} (${database.freelistPercent.toFixed(1)}%)`}
                    />
                </MetricGroup>

                <MetricGroup title="Gateway" icon={<Radio className="size-4" />}>
                    <MetricRow
                        label="Connection"
                        value={
                            <Badge variant={gateway.connected ? "success" : "error"}>
                                {gateway.connected ? "Connected" : "Disconnected"}
                            </Badge>
                        }
                    />
                    <MetricRow label="Pending requests" value={gateway.pendingRequests} />
                    <MetricRow label="Connections" value={gateway.connections} />
                    <MetricRow label="Reconnects" value={gateway.reconnects} />
                    <MetricRow label="Disconnects" value={gateway.disconnects} />
                    <MetricRow label="Connect failures" value={gateway.connectFailures} />
                    <MetricRow
                        label="Last connected"
                        value={formatTimestamp(gateway.lastConnectedAt)}
                    />
                    <MetricRow
                        label="Last disconnected"
                        value={formatTimestamp(gateway.lastDisconnectedAt)}
                    />
                </MetricGroup>

                <MetricGroup
                    title="Cache refresh"
                    icon={<RefreshCw className="size-4" />}
                >
                    <MetricRow label="Requests" value={cacheRefresh.requests} />
                    <MetricRow label="Refreshes" value={cacheRefresh.refreshes} />
                    <MetricRow label="Active" value={cacheRefresh.active} />
                    <MetricRow label="Coalesced" value={cacheRefresh.coalesced} />
                    <MetricRow label="Failures" value={cacheRefresh.failures} />
                    <MetricRow
                        label="Last duration"
                        value={formatMilliseconds(cacheRefresh.lastDurationMs)}
                    />
                    <MetricRow
                        label="Average duration"
                        value={formatMilliseconds(cacheRefresh.averageDurationMs)}
                    />
                    <MetricRow
                        label="Maximum duration"
                        value={formatMilliseconds(cacheRefresh.maxDurationMs)}
                    />
                </MetricGroup>

                <MetricGroup title="HTTP" icon={<Network className="size-4" />}>
                    <MetricRow label="Requests" value={http.requests} />
                    <MetricRow label="Errors" value={http.errors} />
                    <MetricRow
                        label="Average duration"
                        value={formatMilliseconds(http.averageDurationMs)}
                    />
                    <MetricRow
                        label="Maximum duration"
                        value={formatMilliseconds(http.maxDurationMs)}
                    />
                    <div className="max-h-40 space-y-1 overflow-y-auto border-t border-primary-700 pt-2">
                        {http.routes.length === 0 ? (
                            <p className="text-xs text-primary-500">
                                No route samples yet.
                            </p>
                        ) : (
                            http.routes.map((route) => (
                                <div
                                    key={`${route.method}:${route.route}`}
                                    className="rounded border border-primary-700/70 bg-primary-950/30 px-2 py-1.5 text-[11px]"
                                >
                                    <div className="truncate text-primary-200">
                                        {route.method} {route.route}
                                    </div>
                                    <div className="mt-0.5 text-primary-500 tabular-nums">
                                        {route.requests} requests · {route.errors} errors
                                        · {formatMilliseconds(route.averageDurationMs)}{" "}
                                        avg
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </MetricGroup>

                <MetricGroup
                    title="Polling snapshots"
                    icon={<ChartNoAxesCombined className="size-4" />}
                >
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                        {polling.snapshots.length === 0 ? (
                            <p className="text-xs text-primary-500">
                                No polling samples yet.
                            </p>
                        ) : (
                            polling.snapshots.map((snapshot) => (
                                <div
                                    key={snapshot.name}
                                    className="rounded border border-primary-700/70 bg-primary-950/30 px-2 py-1.5 text-[11px]"
                                >
                                    <div className="truncate text-primary-200">
                                        {snapshot.name}
                                    </div>
                                    <div className="mt-0.5 text-primary-500 tabular-nums">
                                        {snapshot.requests} requests · {snapshot.loads}{" "}
                                        loads · {snapshot.coalescedHits} coalesced ·{" "}
                                        {snapshot.failures} failed
                                    </div>
                                    <div className="text-primary-500 tabular-nums">
                                        {snapshot.freshHits} fresh · {snapshot.staleHits}{" "}
                                        stale · {snapshot.activeLoads} active ·{" "}
                                        {formatMilliseconds(snapshot.averageLoadMs)} avg
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </MetricGroup>
            </div>
        </Card>
    );
}
