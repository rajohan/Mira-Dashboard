import { Clock3 } from "lucide-react";

import { type CronJob, useCronJobs } from "../../../hooks";
import { type ScheduledJob, useScheduledJobs } from "../../../hooks/useScheduledJobs";
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
    if (status === "running") return "info" as const;
    if (status === "success") return "success" as const;
    return "default" as const;
}

function cronTimestamp(job: CronJob, key: "lastRunAtMs" | "nextRunAtMs") {
    const value = getCronStateValue(job, key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Renders the scheduled jobs overview card UI. */
export function JobsOverviewCard() {
    const {
        data: jobs = [],
        isError: isJobsError,
        isLoading: isJobsLoading,
    } = useScheduledJobs();
    const {
        data: cronJobs = [],
        isError: isCronError,
        isLoading: isCronLoading,
    } = useCronJobs();

    const enabledCount = jobs.filter((job) => job.enabled).length;
    const cronEnabledCount = cronJobs.filter((job) => job.enabled !== false).length;
    const runningCount = jobs.filter((job) => job.isRunning).length;
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
    const latestSource =
        latestRunTimestamp !== undefined &&
        (latestCronTimestamp === undefined || latestRunTimestamp >= latestCronTimestamp)
            ? "job"
            : latestCronTimestamp === undefined
              ? undefined
              : "cron";
    const nextSource =
        nextRunTimestamp !== undefined &&
        (nextCronTimestamp === undefined || nextRunTimestamp <= nextCronTimestamp)
            ? "job"
            : nextCronTimestamp === undefined
              ? undefined
              : "cron";
    const latestCronStatus = formatCronLastStatus(
        latestCronJob ? getCronStateValue(latestCronJob, "lastRunStatus") : undefined
    );

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Jobs
                </h3>
                <Clock3 className="size-4 text-primary-400" />
            </div>

            {isJobsLoading || isCronLoading ? (
                <div className="text-sm text-primary-300">Loading jobs…</div>
            ) : isJobsError || isCronError ? (
                <div className="text-sm text-rose-300">Jobs unavailable.</div>
            ) : (
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
                        <span>Running</span>
                        <span
                            className={
                                runningCount > 0 ? "text-blue-300" : "text-primary-300"
                            }
                        >
                            {runningCount}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0">Last run</span>
                        <span className="min-w-0 truncate text-right text-primary-100">
                            {latestSource === "job" && latestRunJob?.lastRun
                                ? `${formatDate(latestRunJob.lastRun.startedAt)} (${latestRunJob.name})`
                                : latestSource === "cron" && latestCronJob
                                  ? `${formatDate(cronTimestamp(latestCronJob, "lastRunAtMs")!)} (${getCronJobName(latestCronJob)})`
                                  : "—"}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0">Next run</span>
                        <span className="min-w-0 truncate text-right text-primary-100">
                            {nextSource === "job" && nextRunJob?.nextRunAt
                                ? `${formatDate(nextRunJob.nextRunAt)} (${nextRunJob.name})`
                                : nextSource === "cron" && nextCronJob
                                  ? `${formatDate(cronTimestamp(nextCronJob, "nextRunAtMs")!)} (${getCronJobName(nextCronJob)})`
                                  : "—"}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Last status</span>
                        {latestSource === "job" ? (
                            <Badge variant={lastRunVariant(latestRunJob)}>
                                {latestRunJob?.lastRun?.status ?? "none"}
                            </Badge>
                        ) : latestSource === "cron" ? (
                            <Badge variant={getCronStatusVariant(latestCronStatus)}>
                                {latestCronStatus}
                            </Badge>
                        ) : (
                            <Badge>none</Badge>
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}
