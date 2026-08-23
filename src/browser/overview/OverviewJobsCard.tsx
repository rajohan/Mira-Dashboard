import { Server } from "lucide-react";
import { useId } from "react";

import { jobWorkerSummaryMaximum, type JobRunState } from "../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";

const overviewRunStates = Object.freeze([
    "queued",
    "running",
    "failed",
    "timed-out",
] satisfies readonly JobRunState[]);

interface RunStateCountProps {
    readonly state: JobRunState;
    readonly value: number;
}

function RunStateCount({ state, value }: RunStateCountProps) {
    return (
        <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
            <dt>
                <Badge className="capitalize" variant={jobRunStateBadgeVariant(state)}>
                    {jobRunStateLabel(state)}
                </Badge>
            </dt>
            <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                {value}
                <span className="sr-only"> background jobs</span>
            </dd>
        </div>
    );
}

export interface OverviewJobsCardProps {
    readonly summary: JobQueueSummary;
}

/**
 * Renders the bounded Dashboard-local queue projection without control authority.
 * @param properties Validated global run-state and fresh-worker summary.
 * @returns Read-only queue overview with an explicit jobs-route link.
 */
export function OverviewJobsCard({ summary }: OverviewJobsCardProps) {
    const headingId = useId();
    const freshWorkerCount =
        summary.workers.length === jobWorkerSummaryMaximum
            ? `${jobWorkerSummaryMaximum}+`
            : summary.workers.length;

    return (
        <Card aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                    <Server aria-hidden="true" className="text-accent-300 size-5" />
                    <Heading id={headingId} level={2} size="subsection">
                        Dashboard background jobs
                    </Heading>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                    <output aria-atomic="true" aria-live="polite">
                        <Badge
                            variant={
                                summary.control.claimingPaused ? "warning" : "success"
                            }
                        >
                            {summary.control.claimingPaused
                                ? "New jobs paused"
                                : "Accepting new jobs"}
                        </Badge>
                    </output>
                    <ActionLink size="sm" to="/jobs" variant="secondary">
                        View Dashboard jobs
                    </ActionLink>
                </div>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {overviewRunStates.map((state) => (
                    <RunStateCount
                        key={state}
                        state={state}
                        value={summary.stateCounts[state]}
                    />
                ))}
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">
                        Workers recently available
                    </dt>
                    <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                        {freshWorkerCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Oldest waiting since</dt>
                    <dd className="text-primary-100 mt-2 text-sm">
                        {summary.oldestQueuedAtMs === undefined ? (
                            "None"
                        ) : (
                            <time
                                dateTime={new Date(
                                    summary.oldestQueuedAtMs
                                ).toISOString()}
                            >
                                {formatDashboardDateTime(summary.oldestQueuedAtMs)}
                            </time>
                        )}
                    </dd>
                </div>
            </dl>
        </Card>
    );
}
