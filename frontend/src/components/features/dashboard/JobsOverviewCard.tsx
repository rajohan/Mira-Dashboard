import { Clock3 } from "lucide-react";
import type { ReactNode } from "react";

import type { CronJob } from "../../../../../contracts/cron";
import type { ScheduledJob } from "../../../../../contracts/jobs";
import { useCronJobs } from "../../../hooks";
import { useScheduledJobs } from "../../../hooks/useScheduledJobs";
import {
    formatCronLastStatus,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
} from "../../../utils/cronUtilities";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

function jobTimestamp(job: ScheduledJob, key: "nextRunAt" | "lastRun") {
    const value = key === "lastRun" ? job.lastRun?.startedAt : job.nextRunAt;
    if (!value) {
        return;
    }
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : timestamp;
}

function lastRunVariant(job: ScheduledJob | undefined) {
    const status = job?.lastRun?.status;
    if (status === "failed") return "error" as const;
    if (status === "queued" || status === "running") return "info" as const;
    if (status === "cancelled") return "warning" as const;
    if (status === "success") return "success" as const;
    return "default" as const;
}

function cronTimestamp(job: CronJob, key: "lastRunAtMs" | "nextRunAtMs") {
    const value = getCronStateValue(job, key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function latestRunSource(
    dashboardTimestamp: number | undefined,
    cronTimestampValue: number | undefined
): "cron" | "job" | undefined {
    if (
        dashboardTimestamp !== undefined &&
        (cronTimestampValue === undefined || dashboardTimestamp >= cronTimestampValue)
    ) {
        return "job";
    }
    return cronTimestampValue === undefined ? undefined : "cron";
}

function nextRunSource(
    dashboardTimestamp: number | undefined,
    cronTimestampValue: number | undefined
): "cron" | "job" | undefined {
    if (
        dashboardTimestamp !== undefined &&
        (cronTimestampValue === undefined || dashboardTimestamp <= cronTimestampValue)
    ) {
        return "job";
    }
    return cronTimestampValue === undefined ? undefined : "cron";
}

/**
 * Renders the scheduled jobs overview card UI.
 * @returns Rendered the scheduled jobs overview card UI.
 */
export function JobsOverviewCard() {
    const {
        data: jobsData,
        isError: isJobsError,
        isLoading: isJobsLoading,
    } = useScheduledJobs();
    const {
        data: cronJobsData,
        isError: isCronError,
        isLoading: isCronLoading,
    } = useCronJobs();
    const jobs = jobsData ?? [];
    const cronJobs = cronJobsData ?? [];

    const enabledCount = jobs.filter((job) => job.enabled).length;
    const cronEnabledCount = cronJobs.filter((job) => job.enabled !== false).length;
    const disabledCount = jobs.filter((job) => !job.enabled).length;
    const cronDisabledCount = cronJobs.filter((job) => job.enabled === false).length;
    const activeCount = jobs.filter((job) => job.isQueued || job.isRunning).length;
    const latestRunJob =
        [...jobs]
            .filter((job) => jobTimestamp(job, "lastRun") !== undefined)
            .toSorted(
                (a, b) => jobTimestamp(b, "lastRun")! - jobTimestamp(a, "lastRun")!
            )[0] || undefined;
    const nextRunJob =
        [...jobs]
            .filter((job) => job.enabled && jobTimestamp(job, "nextRunAt") !== undefined)
            .toSorted(
                (a, b) => jobTimestamp(a, "nextRunAt")! - jobTimestamp(b, "nextRunAt")!
            )[0] || undefined;
    const latestCronJob =
        [...cronJobs]
            .filter((job) => cronTimestamp(job, "lastRunAtMs") !== undefined)
            .toSorted(
                (a, b) =>
                    cronTimestamp(b, "lastRunAtMs")! - cronTimestamp(a, "lastRunAtMs")!
            )[0] || undefined;
    const nextCronJob =
        [...cronJobs]
            .filter((job) => job.enabled !== false)
            .filter((job) => cronTimestamp(job, "nextRunAtMs") !== undefined)
            .toSorted(
                (a, b) =>
                    cronTimestamp(a, "nextRunAtMs")! - cronTimestamp(b, "nextRunAtMs")!
            )[0] || undefined;
    const latestRunTimestamp = latestRunJob
        ? jobTimestamp(latestRunJob, "lastRun")
        : undefined;
    const latestCronTimestamp = latestCronJob
        ? cronTimestamp(latestCronJob, "lastRunAtMs")
        : undefined;
    const nextRunTimestamp = nextRunJob
        ? jobTimestamp(nextRunJob, "nextRunAt")
        : undefined;
    const nextCronTimestamp = nextCronJob
        ? cronTimestamp(nextCronJob, "nextRunAtMs")
        : undefined;
    const latestSource = latestRunSource(latestRunTimestamp, latestCronTimestamp);
    const nextSource = nextRunSource(nextRunTimestamp, nextCronTimestamp);
    const latestCronStatus = formatCronLastStatus(
        latestCronJob ? getCronStateValue(latestCronJob, "lastRunStatus") : undefined
    );
    let latestRunLabel = "—";
    if (latestSource === "job" && latestRunJob?.lastRun) {
        latestRunLabel = `${formatDate(latestRunJob.lastRun.startedAt)} (${latestRunJob.name})`;
    } else if (latestSource === "cron" && latestCronJob) {
        latestRunLabel = `${formatDate(cronTimestamp(latestCronJob, "lastRunAtMs")!)} (${getCronJobName(latestCronJob)})`;
    }

    let nextRunLabel = "—";
    if (nextSource === "job" && nextRunJob?.nextRunAt) {
        nextRunLabel = `${formatDate(nextRunJob.nextRunAt)} (${nextRunJob.name})`;
    } else if (nextSource === "cron" && nextCronJob) {
        nextRunLabel = `${formatDate(cronTimestamp(nextCronJob, "nextRunAtMs")!)} (${getCronJobName(nextCronJob)})`;
    }

    let latestStatus: ReactNode = <Badge>none</Badge>;
    if (latestSource === "job") {
        latestStatus = (
            <Badge variant={lastRunVariant(latestRunJob)}>
                {latestRunJob?.lastRun?.status ?? "none"}
            </Badge>
        );
    } else if (latestSource === "cron") {
        latestStatus = (
            <Badge variant={getCronStatusVariant(latestCronStatus)}>
                {latestCronStatus}
            </Badge>
        );
    }

    let content: ReactNode;
    if (isJobsLoading || isCronLoading) {
        content = <div className="text-sm text-primary-300">Loading jobs…</div>;
    } else if ((isJobsError && !jobsData) || (isCronError && !cronJobsData)) {
        content = <div className="text-sm text-rose-300">Jobs unavailable.</div>;
    } else {
        content = (
            <div className="space-y-2 text-sm text-primary-200">
                <div className="flex items-center justify-between">
                    <span>Total</span>
                    <span className="font-semibold text-primary-50">
                        {jobs.length + cronJobs.length}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Dashboard jobs</span>
                    <span className="text-primary-100">{jobs.length}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span>OpenClaw cron</span>
                    <span className="text-primary-100">{cronJobs.length}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Enabled</span>
                    <span className="text-green-300">
                        {enabledCount + cronEnabledCount}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Disabled</span>
                    <span className="text-yellow-300">
                        {disabledCount + cronDisabledCount}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Queued/running</span>
                    <span
                        className={activeCount > 0 ? "text-blue-300" : "text-primary-300"}
                    >
                        {activeCount}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0">Last run</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {latestRunLabel}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0">Next run</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {nextRunLabel}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Last status</span>
                    {latestStatus}
                </div>
            </div>
        );
    }

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Jobs
                </h3>
                <Clock3 className="size-4 text-primary-400" />
            </div>

            {content}
        </Card>
    );
}
