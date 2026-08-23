import { Newspaper } from "lucide-react";
import { useId } from "react";

import type { ReportSummary } from "../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    reportKindLabel,
    reportStatusVariant,
} from "../monitoring/monitoringPresentation.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

export interface OverviewReportsCardProps {
    readonly reports: readonly ReportSummary[];
    readonly truncated?: boolean;
}

/**
 * Renders one bounded newest-report window without loading report bodies.
 * @param properties Validated summaries and continuation state.
 * @returns Read-only reports overview with a route link.
 */
export function OverviewReportsCard({
    reports,
    truncated = false,
}: OverviewReportsCardProps) {
    const headingId = useId();
    const latestHeadingId = useId();
    const latest = reports[0];
    const warningCount = reports.filter(({ status }) => status === "warning").length;
    const errorCount = reports.filter(({ status }) => status === "error").length;

    return (
        <Card aria-labelledby={headingId} className="h-full">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                    <Newspaper aria-hidden="true" className="text-accent-300 size-5" />
                    <Heading id={headingId} level={2} size="subsection">
                        Recent reports
                    </Heading>
                </div>
                <ActionLink size="sm" to="/reports" variant="secondary">
                    View reports
                </ActionLink>
            </div>

            <dl className="mt-5 grid grid-cols-3 gap-3">
                {[
                    ["Reports", reports.length],
                    ["Warnings", warningCount],
                    ["Errors", errorCount],
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
                    <Text>No reports yet.</Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        New monitoring reports will appear here.
                    </Text>
                </div>
            ) : (
                <section
                    aria-labelledby={latestHeadingId}
                    className="border-primary-700 bg-primary-900/35 mt-4 min-w-0 rounded-lg border p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={reportStatusVariant(latest.status)}>
                            {latest.status}
                        </Badge>
                        <Badge className="capitalize">
                            {reportKindLabel(latest.kind)}
                        </Badge>
                    </div>
                    <Heading
                        className="mt-3 wrap-break-word"
                        id={latestHeadingId}
                        level={3}
                    >
                        {latest.title}
                    </Heading>
                    {latest.summary !== undefined && (
                        <Text className="mt-2 line-clamp-2" tone="muted">
                            {latest.summary}
                        </Text>
                    )}
                    <time
                        className="text-primary-400 mt-3 block text-xs"
                        dateTime={new Date(latest.occurredAtMs).toISOString()}
                    >
                        {formatDashboardDateTime(latest.occurredAtMs)}
                    </time>
                </section>
            )}
        </Card>
    );
}
