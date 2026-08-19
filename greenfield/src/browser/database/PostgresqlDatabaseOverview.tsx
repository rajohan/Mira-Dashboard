import { Activity, Database, Gauge, Magnet, Network, Orbit } from "lucide-react";

import type { DatabaseOverview } from "../../contracts/database.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { PostgresqlDatabaseTables } from "./PostgresqlDatabaseTables.tsx";

type PostgresqlObservation = DatabaseOverview["postgresql"];
type AvailablePostgresqlObservation = Exclude<
    PostgresqlObservation,
    { readonly state: "unavailable" }
>;

const countFormatter = new Intl.NumberFormat();
const decimalFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
});

function formatCount(value: number): string {
    return countFormatter.format(value);
}

function formatMilliseconds(value: number): string {
    return `${decimalFormatter.format(value)} ms`;
}

function formatSeconds(value: number): string {
    return `${decimalFormatter.format(value)} s`;
}

function torrentCountValue(
    value: AvailablePostgresqlObservation["torrentCounts"]["bitmagnet"]
): string {
    return value.state === "available" ? formatCount(value.count) : "Unavailable";
}

function PostgresqlObservationTime({ timestampMs }: { readonly timestampMs: number }) {
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

function maintenanceStatusLabel(
    status: AvailablePostgresqlObservation["summary"]["maintenance"]["status"]
): string {
    switch (status) {
        case "healthy": {
            return "Healthy";
        }
        case "not-assessed": {
            return "Not assessed";
        }
        case "review": {
            return "Review";
        }
    }
}

function maintenanceStatusBadge(
    status: AvailablePostgresqlObservation["summary"]["maintenance"]["status"]
) {
    let variant: "default" | "success" | "warning" = "default";
    if (status === "healthy") variant = "success";
    else if (status === "review") variant = "warning";
    return <Badge variant={variant}>{maintenanceStatusLabel(status)}</Badge>;
}

function postgresqlMaintenanceAttention(
    observation: AvailablePostgresqlObservation
): ReadonlyArray<{ readonly message: string; readonly warning: boolean }> {
    const maintenance = observation.summary.maintenance;
    const messages: Array<{ readonly message: string; readonly warning: boolean }> = [];
    if (maintenance.requiresBloatReview) {
        messages.push({
            message: `PostgreSQL has an estimated ${formatByteCount(maintenance.estimatedReclaimableBytes)} (${formatPercent(maintenance.estimatedReclaimablePercent)}) reclaimable table space. Review the affected tables; standard VACUUM makes space reusable internally, while returning disk to the host requires planned compaction or a table rebuild.`,
            warning: true,
        });
    }
    if (maintenance.highDeadTupleTableCount > 0) {
        messages.push({
            message: `${formatCount(maintenance.highDeadTupleTableCount)} PostgreSQL table${maintenance.highDeadTupleTableCount === 1 ? " exceeds" : "s exceed"} the dead-tuple maintenance threshold. Review autovacuum behavior and plan VACUUM where needed; refresh planner statistics with ANALYZE separately when stale.`,
            warning: true,
        });
    }
    if (maintenance.slowStatementCount > 0) {
        messages.push({
            message: `${formatCount(maintenance.slowStatementCount)} identity-free PostgreSQL statement aggregate${maintenance.slowStatementCount === 1 ? " exceeds" : "s exceed"} the slow-statement threshold. Review query plans and indexes through an authorized database tool.`,
            warning: true,
        });
    }
    if (observation.summary.unavailableDatabaseCount > 0) {
        messages.push({
            message: `${formatCount(observation.summary.unavailableDatabaseCount)} PostgreSQL database${observation.summary.unavailableDatabaseCount === 1 ? "" : "s"} could not be fully assessed. Restore database observability before treating maintenance as healthy.`,
            warning: false,
        });
    }
    if (maintenance.unassessedTableCount > 0) {
        messages.push({
            message: `${formatCount(maintenance.unassessedTableCount)} PostgreSQL table${maintenance.unassessedTableCount === 1 ? "" : "s"} (${formatByteCount(maintenance.unassessedPhysicalBytes)}) could not be assessed for reclaimable space.`,
            warning: false,
        });
    }
    if (!observation.summary.pgStatStatementsEnabled) {
        messages.push({
            message:
                "PostgreSQL statement maintenance assessment is unavailable until the sanitized pg_stat_statements capability is restored.",
            warning: false,
        });
    }
    return messages;
}

function MaintenanceSummary({
    observation,
}: {
    readonly observation: AvailablePostgresqlObservation;
}) {
    const maintenance = observation.summary.maintenance;
    const rows = [
        ["Status", maintenanceStatusBadge(maintenance.status)],
        ["Bloat assessment", maintenance.assessmentComplete ? "Complete" : "Incomplete"],
        [
            "Estimated reclaimable",
            `${formatByteCount(maintenance.estimatedReclaimableBytes)} · ${formatPercent(maintenance.estimatedReclaimablePercent)}`,
        ],
        ["Bloat review", maintenance.requiresBloatReview ? "Required" : "Not required"],
        ["High-dead-tuple tables", formatCount(maintenance.highDeadTupleTableCount)],
        ["Slow statement aggregates", formatCount(maintenance.slowStatementCount)],
        [
            "Unavailable database details",
            formatCount(observation.summary.unavailableDatabaseCount),
        ],
        ["Unassessed tables", formatCount(maintenance.unassessedTableCount)],
        [
            "Unassessed physical size",
            formatByteCount(maintenance.unassessedPhysicalBytes),
        ],
    ] as const;
    return (
        <Card aria-labelledby="postgresql-maintenance-summary-heading">
            <div className="flex items-center gap-2">
                <Icon icon={Activity} tone="accent" />
                <Heading
                    id="postgresql-maintenance-summary-heading"
                    level={2}
                    size="section"
                >
                    Maintenance assessment
                </Heading>
            </div>
            <Text className="mt-1" tone="muted">
                Aggregate table-health and reclaimability signals for operator review.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-sm">{label}</dt>
                        <dd className="text-primary-50 mt-1 font-medium tabular-nums">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

function PgBouncerSummary({
    observation,
}: {
    readonly observation: AvailablePostgresqlObservation;
}) {
    const rows = [
        ["Client connections", formatCount(observation.pgbouncer.clientConnections)],
        ["Waiting clients", formatCount(observation.pgbouncer.waitingClients)],
        ["Server connections", formatCount(observation.pgbouncer.serverConnections)],
        ["Average query", formatMilliseconds(observation.pgbouncer.averageQueryMs)],
        [
            "Average transaction",
            formatMilliseconds(observation.pgbouncer.averageTransactionMs),
        ],
        ["Maximum wait", formatSeconds(observation.pgbouncer.maxWaitSeconds)],
    ] as const;
    return (
        <Card aria-labelledby="pgbouncer-summary-heading">
            <div className="flex items-center gap-2">
                <Icon icon={Network} tone="accent" />
                <Heading id="pgbouncer-summary-heading" level={2} size="section">
                    PgBouncer aggregate
                </Heading>
            </div>
            <Text className="mt-1" tone="muted">
                Bounded pool totals without users, hosts, ports, or credentials.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-sm">{label}</dt>
                        <dd className="text-primary-50 mt-1 font-medium tabular-nums">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

interface PostgresqlDatabaseOverviewProps {
    readonly browserCacheRetained: boolean;
    readonly observation: PostgresqlObservation;
    readonly observationConfirmed: boolean;
}

/** @returns Independent PostgreSQL/PgBouncer availability and bounded observations. */
export function PostgresqlDatabaseOverview({
    browserCacheRetained,
    observation,
    observationConfirmed,
}: PostgresqlDatabaseOverviewProps) {
    if (observation.state === "unavailable") {
        if (!observationConfirmed) {
            return (
                <PageState
                    label="Revalidating PostgreSQL diagnostics…"
                    size="lg"
                    status="loading"
                />
            );
        }
        return (
            <PageState
                description="No previously verified external observation is available. Dashboard SQLite remains available independently."
                icon={Database}
                status="empty"
                title="PostgreSQL diagnostics unavailable"
            />
        );
    }

    const retained = observationConfirmed && observation.state === "last-known-good";
    const maintenanceAttention = postgresqlMaintenanceAttention(observation);
    return (
        <PageState status="ready">
            <section
                aria-labelledby="postgresql-database-details-heading"
                className="space-y-6"
            >
                <Heading
                    className="sr-only"
                    id="postgresql-database-details-heading"
                    level={2}
                >
                    PostgreSQL and PgBouncer details
                </Heading>
                {retained ? (
                    <Alert
                        focusOnError={false}
                        message="The latest PostgreSQL/PgBouncer collection failed. Showing the most recent server-verified observation."
                        variant="info"
                    />
                ) : null}
                {maintenanceAttention.map(({ message, warning }) => (
                    <Alert
                        focusOnError={false}
                        key={message}
                        message={message}
                        variant={warning ? "warning" : "info"}
                    />
                ))}
                {retained || browserCacheRetained ? (
                    <div className="flex flex-wrap items-center gap-3">
                        {retained ? (
                            <Badge variant="warning">Last-known-good</Badge>
                        ) : null}
                        {browserCacheRetained ? (
                            <Badge variant="warning">Browser cache retained</Badge>
                        ) : null}
                        <Text size="sm" tone="muted">
                            Observed{" "}
                            <PostgresqlObservationTime
                                timestampMs={observation.observedAtMs}
                            />
                        </Text>
                        {retained ? (
                            <Text size="sm" tone="muted">
                                Retained since{" "}
                                <PostgresqlObservationTime
                                    timestampMs={observation.staleSinceMs}
                                />
                            </Text>
                        ) : null}
                    </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <MetricCard
                        description={`${formatCount(observation.databases.length)} bounded database rows.`}
                        icon={Database}
                        title="Database storage"
                        value={formatByteCount(
                            observation.summary.totalDatabaseSizeBytes
                        )}
                    />
                    <MetricCard
                        description={`${formatCount(observation.summary.activeConnections)} active · ${formatCount(observation.summary.idleConnections)} idle.`}
                        icon={Network}
                        title="Connections"
                        value={formatCount(observation.summary.totalConnections)}
                    />
                    <MetricCard
                        description="Average PostgreSQL block-cache hit ratio."
                        icon={Gauge}
                        title="Cache hit"
                        value={formatPercent(observation.summary.averageCacheHitRatio)}
                    />
                    <MetricCard
                        description={`${formatCount(observation.pgbouncer.waitingClients)} waiting clients.`}
                        icon={Activity}
                        title="PgBouncer clients"
                        value={formatCount(observation.pgbouncer.clientConnections)}
                    />
                    <MetricCard
                        description="Dedicated count-only Comet projection."
                        icon={Orbit}
                        title="Comet torrents"
                        value={torrentCountValue(observation.torrentCounts.comet)}
                    />
                    <MetricCard
                        description="Dedicated count-only Bitmagnet projection."
                        icon={Magnet}
                        title="Bitmagnet torrents"
                        value={torrentCountValue(observation.torrentCounts.bitmagnet)}
                    />
                </div>
                <MaintenanceSummary observation={observation} />
                <PgBouncerSummary observation={observation} />
                <PostgresqlDatabaseTables
                    databases={observation.databases}
                    statements={observation.statements}
                    statementsEnabled={observation.summary.pgStatStatementsEnabled}
                    tableHealth={observation.tableHealth}
                />
            </section>
        </PageState>
    );
}
