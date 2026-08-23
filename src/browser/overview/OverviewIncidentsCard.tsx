import { ShieldAlert } from "lucide-react";
import { useId } from "react";

import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { incidentSeverityVariant } from "../monitoring/incidentPresentation.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

export interface OverviewIncidentsCardProps {
    readonly incidents: readonly IncidentSummary[];
    readonly truncated?: boolean;
}

/**
 * Renders a disclosed newest-active incident window without implying monitor health.
 * @param properties Validated persisted incident generations and continuation state.
 * @returns Read-only active-incident overview with exact incident navigation.
 */
export function OverviewIncidentsCard({
    incidents,
    truncated = false,
}: OverviewIncidentsCardProps) {
    const headingId = useId();
    const latestHeadingId = useId();
    const latest = incidents[0];
    const criticalCount = incidents.filter(
        ({ severity }) => severity === "critical"
    ).length;
    const errorCount = incidents.filter(({ severity }) => severity === "error").length;

    return (
        <Card aria-labelledby={headingId} className="h-full">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                    <ShieldAlert aria-hidden="true" className="text-accent-300 size-5" />
                    <Heading id={headingId} level={2} size="subsection">
                        Active incidents
                    </Heading>
                </div>
                <ActionLink
                    className="ml-auto shrink-0"
                    size="sm"
                    to="/incidents"
                    variant="secondary"
                >
                    View incidents
                </ActionLink>
            </div>

            <dl className="mt-5 grid grid-cols-3 gap-3">
                {[
                    ["Incidents", incidents.length],
                    ["Critical", criticalCount],
                    ["Error", errorCount],
                ].map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-xs">{label}</dt>
                        <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                            {value}
                            {truncated ? "+" : ""}
                        </dd>
                    </div>
                ))}
            </dl>

            {latest === undefined ? (
                <div className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4">
                    <Text>No active incidents.</Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        Resolved incidents remain available on the Incidents page.
                    </Text>
                </div>
            ) : (
                <section
                    aria-labelledby={latestHeadingId}
                    className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={incidentSeverityVariant(latest.severity)}>
                            {latest.severity}
                        </Badge>
                        <Badge>Incident group {latest.generation}</Badge>
                    </div>
                    <Heading
                        className="mt-3 line-clamp-2 wrap-break-word"
                        id={latestHeadingId}
                        level={3}
                    >
                        {latest.title}
                    </Heading>
                    <Text className="mt-2 wrap-break-word" size="sm" tone="muted">
                        Check: {latest.monitorKey} · Seen {latest.occurrenceCount} time
                        {latest.occurrenceCount === 1 ? "" : "s"}
                    </Text>
                    <time
                        className="text-primary-400 mt-3 block text-xs"
                        dateTime={new Date(latest.lastSeenAtMs).toISOString()}
                    >
                        Last seen {formatDashboardDateTime(latest.lastSeenAtMs)}
                    </time>
                </section>
            )}
        </Card>
    );
}
