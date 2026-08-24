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
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface CountRowProps {
    readonly label: string;
    readonly value: number;
    readonly variant?: "danger" | "default" | "success" | "warning";
}

function CountRow({ label, value, variant = "default" }: CountRowProps) {
    return (
        <div className="flex items-center justify-between gap-3">
            <dt className="text-primary-400 text-sm">{label}</dt>
            <dd>
                <Badge variant={variant}>{value}</Badge>
            </dd>
        </div>
    );
}

export interface OverviewReportsCardProps {
    readonly hasMore: boolean;
    readonly reports: readonly ReportSummary[];
}

/**
 * Renders one bounded newest-report window without loading report bodies.
 * @param properties Validated summaries and continuation state.
 * @returns Read-only reports overview with a route link.
 */
export function OverviewReportsCard({ hasMore, reports }: OverviewReportsCardProps) {
    const headingId = useId();
    const latestHeadingId = useId();
    const latest = reports[0];
    const warningCount = reports.filter(({ status }) => status === "warning").length;
    const errorCount = reports.filter(({ status }) => status === "error").length;

    return (
        <Card aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                        <Icon icon={Newspaper} tone="accent" />
                    </span>
                    <div className="min-w-0">
                        <Heading id={headingId} level={2} size="subsection">
                            Recent reports
                        </Heading>
                        <Text className="mt-1" size="sm" tone="muted">
                            See the newest report summaries. Open Reports to read a full
                            report.
                        </Text>
                    </div>
                </div>
                <ActionLink size="sm" to="/reports" variant="secondary">
                    View reports
                </ActionLink>
            </div>

            {latest === undefined ? (
                <div className="border-primary-700 bg-primary-900/35 mt-5 rounded-lg border p-4">
                    <Text>No reports yet.</Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        New monitoring reports will appear here.
                    </Text>
                </div>
            ) : (
                <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
                    <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-4">
                        <dl className="space-y-3">
                            <CountRow label="Shown" value={reports.length} />
                            <CountRow
                                label="Warnings"
                                value={warningCount}
                                variant={warningCount > 0 ? "warning" : "success"}
                            />
                            <CountRow
                                label="Errors"
                                value={errorCount}
                                variant={errorCount > 0 ? "danger" : "success"}
                            />
                        </dl>
                        {hasMore && (
                            <Text className="mt-3" size="sm" tone="muted">
                                Open Reports to see older reports.
                            </Text>
                        )}
                    </div>

                    <section
                        aria-labelledby={latestHeadingId}
                        className="border-primary-700 bg-primary-900/35 min-w-0 rounded-lg border p-4"
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
                </div>
            )}
        </Card>
    );
}
