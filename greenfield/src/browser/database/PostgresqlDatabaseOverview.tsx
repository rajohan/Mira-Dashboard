import {
    Activity,
    Database,
    Gauge,
    Magnet,
    Network,
    Orbit,
    ScrollText,
    Wrench,
} from "lucide-react";

import type { DatabaseOverview } from "../../contracts/database.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
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

function MaintenanceSummary({
    observation,
}: {
    readonly observation: AvailablePostgresqlObservation;
}) {
    const maintenance = observation.summary.maintenance;
    const rows = [
        ["Status", maintenanceStatusLabel(maintenance.status)],
        ["Bloat assessment", maintenance.assessmentComplete ? "Complete" : "Incomplete"],
        [
            "Estimated reclaimable",
            `${formatByteCount(maintenance.estimatedReclaimableBytes)} · ${formatPercent(maintenance.estimatedReclaimablePercent)}`,
        ],
        ["Bloat review", maintenance.requiresBloatReview ? "Required" : "Not required"],
        ["High-dead-tuple tables", formatCount(maintenance.highDeadTupleTableCount)],
        ["Slow statement aggregates", formatCount(maintenance.slowStatementCount)],
        ["Unassessed tables", formatCount(maintenance.unassessedTableCount)],
        [
            "Unassessed physical size",
            formatByteCount(maintenance.unassessedPhysicalBytes),
        ],
    ] as const;
    return (
        <Card aria-labelledby="postgresql-maintenance-summary-heading">
            <Heading id="postgresql-maintenance-summary-heading" level={2} size="section">
                Maintenance assessment
            </Heading>
            <Text className="mt-1" tone="muted">
                Aggregate table-health and reclaimability signals for operator review.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(([label, value]) => (
                    <div className="border-primary-700 rounded-lg border p-3" key={label}>
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
            <Heading id="pgbouncer-summary-heading" level={2} size="section">
                PgBouncer aggregate
            </Heading>
            <Text className="mt-1" tone="muted">
                Bounded pool totals without users, hosts, ports, or credentials.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(([label, value]) => (
                    <div className="border-primary-700 rounded-lg border p-3" key={label}>
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
}

/** @returns Independent PostgreSQL/PgBouncer availability and bounded observations. */
export function PostgresqlDatabaseOverview({
    browserCacheRetained,
    observation,
}: PostgresqlDatabaseOverviewProps) {
    if (observation.state === "unavailable") {
        return (
            <PageState
                description="No previously verified external observation is available. Dashboard SQLite remains available independently."
                icon={Database}
                status="empty"
                title="PostgreSQL diagnostics unavailable"
            />
        );
    }

    const retained = observation.state === "last-known-good";
    let observationBadgeLabel = "Fresh observation";
    if (retained) observationBadgeLabel = "Last-known-good";
    else if (browserCacheRetained) observationBadgeLabel = "Browser cache retained";
    return (
        <PageState status="ready">
            <div className="space-y-6">
                {retained ? (
                    <Alert
                        focusOnError={false}
                        message="The latest PostgreSQL/PgBouncer collection failed. Showing the most recent server-verified observation."
                        variant="info"
                    />
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                    <Badge
                        variant={retained || browserCacheRetained ? "warning" : "success"}
                    >
                        {observationBadgeLabel}
                    </Badge>
                    {browserCacheRetained && retained ? (
                        <Badge variant="warning">Browser cache retained</Badge>
                    ) : null}
                    <Text size="sm" tone="muted">
                        Observed{" "}
                        <PostgresqlObservationTime
                            timestampMs={observation.observedAtMs}
                        />
                    </Text>
                    {observation.state === "last-known-good" ? (
                        <Text size="sm" tone="muted">
                            Retained since{" "}
                            <PostgresqlObservationTime
                                timestampMs={observation.staleSinceMs}
                            />
                        </Text>
                    ) : null}
                </div>
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
                        description={`${formatCount(observation.summary.maintenance.highDeadTupleTableCount)} high-dead-tuple tables · ${formatCount(observation.summary.maintenance.slowStatementCount)} slow statement aggregates.`}
                        icon={Wrench}
                        title="Maintenance"
                        value={maintenanceStatusLabel(
                            observation.summary.maintenance.status
                        )}
                    />
                    <MetricCard
                        description={`${formatCount(observation.statements.length)} identity-free ranked rows.`}
                        icon={ScrollText}
                        title="Statement metrics"
                        value={
                            observation.summary.pgStatStatementsEnabled
                                ? "Enabled"
                                : "Unavailable"
                        }
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
            </div>
        </PageState>
    );
}
