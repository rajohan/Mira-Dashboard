import { useQuery } from "@tanstack/react-query";
import { Boxes, Database, FileText, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { DatabaseOverview } from "../../contracts/database.ts";
import type { DockerOverview } from "../../contracts/docker.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenancePolicyStatus,
    LogMaintenanceStatusOutput,
} from "../../contracts/logs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { databaseOverviewQueryOptions } from "../database/databaseQueries.ts";
import { dockerClient } from "../docker/dockerClient.ts";
import { dockerOverviewQueryOptions } from "../docker/dockerQueries.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import type { DashboardRoutePath } from "../lib/dashboardRoutes.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { logClient } from "../logs/logClient.ts";
import {
    logMaintenanceQueryOptions,
    logSourcesQueryOptions,
} from "../logs/logQueries.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";

interface DomainCardProps {
    readonly children: ReactNode;
    readonly icon: LucideIcon;
    readonly linkLabel: string;
    readonly to: DashboardRoutePath;
    readonly title: string;
}

function DomainCard({ children, icon, linkLabel, to, title }: DomainCardProps) {
    return (
        <Card className="min-w-0">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Icon icon={icon} size="md" tone="accent" />
                        <Heading level={3}>{title}</Heading>
                    </div>
                </div>
                <ActionLink size="sm" to={to} variant="secondary">
                    {linkLabel}
                </ActionLink>
            </div>
            <div className="mt-5">{children}</div>
        </Card>
    );
}

function backgroundWarning(
    error: Error | null,
    available: boolean,
    sampledAtMs?: number
) {
    return error !== null && available ? (
        <Alert
            className="mb-4"
            focusOnError={false}
            message={`The refresh failed. Showing the retained validated result.${sampledAtMs === undefined ? "" : ` Last sample: ${formatDashboardDateTime(sampledAtMs)}.`}`}
        />
    ) : null;
}

function DockerStatus({ overview }: { readonly overview: DockerOverview }) {
    if (overview.state === "unavailable") {
        return <Text tone="warning">Docker inventory is unavailable.</Text>;
    }
    const running = overview.containers.filter(({ state }) => state === "running").length;
    const unhealthy = overview.containers.filter(
        ({ health }) => health === "unhealthy"
    ).length;
    const updates = overview.updaterServices.filter(
        ({ status }) => status.state === "update-available"
    ).length;
    const imageBytes = overview.images.reduce(
        (total, image) => total + image.sizeBytes,
        0
    );
    const knownVolumeBytes = overview.volumes.reduce(
        (total, volume) => total + (volume.sizeBytes ?? 0),
        0
    );
    const knownVolumeCount = overview.volumes.filter(
        ({ sizeBytes }) => sizeBytes !== undefined
    ).length;
    return (
        <div>
            <div className="flex flex-wrap gap-2">
                <Badge variant={overview.state === "fresh" ? "success" : "warning"}>
                    {overview.state === "fresh" ? "Fresh" : "Last known good"}
                </Badge>
                <Badge variant={unhealthy > 0 ? "danger" : "success"}>
                    {unhealthy} unhealthy
                </Badge>
                {updates > 0 && <Badge variant="warning">{updates} updates</Badge>}
            </div>
            <Text className="mt-3">
                {running} of {overview.containers.length} containers running
            </Text>
            <Text className="mt-1" size="sm" tone="muted">
                {overview.images.length.toLocaleString()} images ·{" "}
                {formatByteCount(imageBytes)} · {overview.volumes.length.toLocaleString()}{" "}
                volumes
                {knownVolumeCount > 0
                    ? ` · ${formatByteCount(knownVolumeBytes)} across ${knownVolumeCount.toLocaleString()} measured`
                    : ""}
            </Text>
        </div>
    );
}

function databaseStateLabel(state: DatabaseOverview["sqlite"]["state"]): string {
    if (state === "fresh") return "Fresh";
    if (state === "last-known-good") return "Last known good";
    return "Unavailable";
}

function databaseStateVariant(
    state: DatabaseOverview["sqlite"]["state"]
): "danger" | "success" | "warning" {
    if (state === "fresh") return "success";
    if (state === "last-known-good") return "warning";
    return "danger";
}

function DatabaseStatus({ overview }: { readonly overview: DatabaseOverview }) {
    const postgresqlReview =
        overview.postgresql.state !== "unavailable" &&
        overview.postgresql.summary.maintenance.status === "review";
    return (
        <div>
            <div className="flex flex-wrap gap-2">
                <Badge variant={databaseStateVariant(overview.sqlite.state)}>
                    SQLite: {databaseStateLabel(overview.sqlite.state)}
                </Badge>
                <Badge variant={databaseStateVariant(overview.postgresql.state)}>
                    PostgreSQL: {databaseStateLabel(overview.postgresql.state)}
                </Badge>
                {postgresqlReview && <Badge variant="warning">Maintenance review</Badge>}
            </div>
            {overview.sqlite.state === "unavailable" ? null : (
                <Text className="mt-3">
                    SQLite {formatByteCount(overview.sqlite.storage.databaseBytes)}
                    {" database · "}
                    {formatByteCount(overview.sqlite.storage.storageBytes)} total ·{" "}
                    {formatByteCount(overview.sqlite.storage.freeBytes)} reusable
                </Text>
            )}
            {overview.postgresql.state === "unavailable" ? null : (
                <div className="mt-2">
                    <Text>
                        PostgreSQL{" "}
                        {formatByteCount(
                            overview.postgresql.summary.totalDatabaseSizeBytes
                        )}
                        {" · "}
                        {overview.postgresql.summary.totalConnections.toLocaleString()}{" "}
                        connections ·{" "}
                        {formatPercent(overview.postgresql.summary.averageCacheHitRatio)}{" "}
                        cache hit
                    </Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        PgBouncer{" "}
                        {overview.postgresql.pgbouncer.clientConnections.toLocaleString()}{" "}
                        clients ·{" "}
                        {overview.postgresql.pgbouncer.serverConnections.toLocaleString()}{" "}
                        servers ·{" "}
                        {overview.postgresql.pgbouncer.waitingClients.toLocaleString()}{" "}
                        waiting
                    </Text>
                </div>
            )}
            {overview.sqlite.state === "unavailable" &&
            overview.postgresql.state === "unavailable" ? (
                <Text className="mt-3" tone="muted">
                    Detailed maintenance, backup, table, and pool signals remain isolated
                    per database source.
                </Text>
            ) : null}
        </div>
    );
}

function LogsStatus({ catalog }: { readonly catalog: ListLogSourcesOutput }) {
    const available = catalog.sources.filter(
        ({ availability }) => availability === "available"
    ).length;
    const unavailable = catalog.sources.length - available;
    return (
        <div>
            <div className="flex flex-wrap gap-2">
                <Badge variant={available > 0 ? "success" : "warning"}>
                    {available} available
                </Badge>
                {unavailable > 0 && (
                    <Badge variant="warning">{unavailable} unavailable</Badge>
                )}
            </div>
            <Text className="mt-3">
                {catalog.sources.length} bounded log sources discovered
            </Text>
        </div>
    );
}

function maintenancePolicyProjection(policy: LogMaintenancePolicyStatus): Readonly<{
    readonly label: string;
    readonly variant: "danger" | "default" | "info" | "success" | "warning";
}> {
    if (policy.activeRun !== undefined) {
        return {
            label: jobRunStateLabel(policy.activeRun.state),
            variant: jobRunStateBadgeVariant(policy.activeRun.state),
        };
    }
    if (policy.state === "unavailable") {
        return { label: "Unavailable", variant: "danger" };
    }
    if (policy.lastRun !== undefined && policy.lastRun.run.state !== "succeeded") {
        return {
            label: `Last ${jobRunStateLabel(policy.lastRun.run.state)}`,
            variant: "warning",
        };
    }
    return { label: "Ready", variant: "success" };
}

function LogMaintenanceStatus({
    maintenance,
}: {
    readonly maintenance: LogMaintenanceStatusOutput;
}) {
    return (
        <div className="border-primary-700/70 mt-4 border-t pt-3">
            <ul aria-label="Log maintenance policies" className="space-y-2">
                {maintenance.policies.map((policy) => {
                    const projection = maintenancePolicyProjection(policy);
                    return (
                        <li
                            className="flex items-center justify-between gap-3"
                            key={policy.id}
                        >
                            <Text as="span" size="sm">
                                {policy.label}
                            </Text>
                            <Badge variant={projection.variant}>{projection.label}</Badge>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** @returns Independent Docker, database, and logs summary cards linking to detail routes. */
export function OverviewDomainSection() {
    const client = useDashboardTrpcClient();
    const docker = useQuery(dockerOverviewQueryOptions(dockerClient(client)));
    const database = useQuery(databaseOverviewQueryOptions(client));
    const logsClient = logClient(client);
    const logs = useQuery(logSourcesQueryOptions(logsClient));
    const logMaintenance = useQuery(logMaintenanceQueryOptions(logsClient));
    let logMaintenanceContent: ReactNode;
    if (logMaintenance.isPending && logMaintenance.data === undefined) {
        logMaintenanceContent = (
            <Text className="mt-4" tone="muted">
                Checking maintenance policies…
            </Text>
        );
    } else if (logMaintenance.data === undefined) {
        logMaintenanceContent = (
            <Text className="mt-4" tone="warning">
                Maintenance status is temporarily unavailable.
            </Text>
        );
    } else {
        logMaintenanceContent = (
            <LogMaintenanceStatus maintenance={logMaintenance.data} />
        );
    }

    return (
        <section aria-label="Service summaries">
            <div className="grid gap-4 lg:grid-cols-3">
                <DomainCard
                    icon={Boxes}
                    linkLabel="View Docker"
                    to="/docker"
                    title="Docker"
                >
                    {backgroundWarning(docker.error, docker.data !== undefined)}
                    {docker.data === undefined ? (
                        <PageState
                            headingLevel={3}
                            label="Loading Docker status…"
                            message="Docker status is temporarily unavailable."
                            onRetry={() => void docker.refetch()}
                            retryBusy={docker.isFetching}
                            status={docker.isPending ? "loading" : "error"}
                        />
                    ) : (
                        <DockerStatus overview={docker.data} />
                    )}
                </DomainCard>
                <DomainCard
                    icon={Database}
                    linkLabel="View databases"
                    to="/database"
                    title="Databases"
                >
                    {backgroundWarning(database.error, database.data !== undefined)}
                    {database.data === undefined ? (
                        <PageState
                            headingLevel={3}
                            label="Loading database status…"
                            message="Database status is temporarily unavailable."
                            onRetry={() => void database.refetch()}
                            retryBusy={database.isFetching}
                            status={database.isPending ? "loading" : "error"}
                        />
                    ) : (
                        <DatabaseStatus overview={database.data} />
                    )}
                </DomainCard>
                <DomainCard icon={FileText} linkLabel="View logs" to="/logs" title="Logs">
                    {backgroundWarning(logs.error, logs.data !== undefined)}
                    {backgroundWarning(
                        logMaintenance.error,
                        logMaintenance.data !== undefined,
                        logMaintenance.data?.observedAtMs
                    )}
                    {logs.data === undefined ? (
                        <PageState
                            headingLevel={3}
                            label="Loading log sources…"
                            message="Log source inventory is temporarily unavailable."
                            onRetry={() => void logs.refetch()}
                            retryBusy={logs.isFetching}
                            status={logs.isPending ? "loading" : "error"}
                        />
                    ) : (
                        <LogsStatus catalog={logs.data} />
                    )}
                    {logMaintenanceContent}
                </DomainCard>
            </div>
        </section>
    );
}
