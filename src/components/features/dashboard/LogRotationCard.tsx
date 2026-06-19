import { FlaskConical, Play, RotateCw } from "lucide-react";

import {
    useLogRotationStatus,
    useRunLogRotationDryRun,
    useRunLogRotationNow,
} from "../../../hooks/useLogRotation";
import { type ScheduledJob, useScheduledJobs } from "../../../hooks/useScheduledJobs";
import {
    formatDate,
    formatOsloClock,
    formatUtcTimeOfDayInAppTimeZone,
} from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

function formatSchedule(job: ScheduledJob | undefined): string {
    if (!job) {
        return "Loading...";
    }

    if (!job.enabled) {
        return "Disabled";
    }

    if (job.scheduleType === "daily" && job.timeOfDay) {
        return `${formatJobNextRunTime(job) ?? formatUtcTimeOfDayInAppTimeZone(job.timeOfDay, job.nextRunAt)} daily`;
    }

    if (job.scheduleType === "daily") {
        return "Daily";
    }

    if (job.scheduleType === "cron" && job.cronExpression) {
        return formatCronSchedule(job, job.cronExpression);
    }

    if (job.scheduleType === "cron") {
        return "Cron schedule";
    }

    const minutes = Math.round(job.intervalSeconds / 60);
    return minutes >= 60 && minutes % 60 === 0
        ? `Every ${minutes / 60}h`
        : `Every ${minutes}m`;
}

function formatJobNextRunTime(job: ScheduledJob): string | null {
    if (!job.nextRunAt) return null;
    const formatted = formatOsloClock(job.nextRunAt);
    return formatted === "--:--" ? null : formatted;
}

function formatCronSchedule(job: ScheduledJob, expression: string): string {
    const parts = expression.trim().split(/\s+/u);
    if (
        parts.length === 5 &&
        /^\d+$/u.test(parts[0]) &&
        /^\d+$/u.test(parts[1]) &&
        parts.slice(2).every((part) => part === "*")
    ) {
        const fallbackDate = new Date(
            Date.UTC(2026, 5, 1, Number(parts[1]), Number(parts[0]))
        );
        const localTime = formatJobNextRunTime(job) ?? formatOsloClock(fallbackDate);
        return `${localTime} daily (${expression} UTC)`;
    }

    return expression;
}

/** Renders the log rotation card UI. */
export function LogRotationCard() {
    const status = useLogRotationStatus(30_000);
    const scheduledJobs = useScheduledJobs();
    const isDryRun = useRunLogRotationDryRun();
    const realRun = useRunLogRotationNow();
    const lastAction = realRun.data || isDryRun.data;
    const lastRun = status.data?.lastRun;
    const logRotationJob = scheduledJobs.data?.find(
        (job) => job.id === "ops.log-rotation"
    );

    return (
        <Card className="overflow-hidden">
            <div className="border-primary-700 border-b px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <RotateCw className="text-accent-400 h-4 w-4" />
                            Log rotation
                        </div>
                        <div className="text-primary-400 text-xs">
                            Dashboard scheduled job for approved file logs under
                            /opt/docker/data.
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                        <Button
                            size="sm"
                            onClick={() => isDryRun.mutate()}
                            disabled={isDryRun.isPending || realRun.isPending}
                            className="w-full sm:w-auto"
                        >
                            <FlaskConical className="h-4 w-4" />
                            {isDryRun.isPending ? "Running..." : "Run dry-run now"}
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            onClick={() => realRun.mutate()}
                            disabled={isDryRun.isPending || realRun.isPending}
                            className="w-full sm:w-auto"
                        >
                            <Play className="h-4 w-4" />
                            {realRun.isPending ? "Running..." : "Run real now"}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Workflow</div>
                    <div className="mt-2 text-lg font-semibold">Scheduled real</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Schedule</div>
                    <div className="mt-2 text-lg font-semibold">
                        {formatSchedule(logRotationJob)}
                    </div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Retention</div>
                    <div className="mt-2 text-lg font-semibold">3 archives</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Rotate at</div>
                    <div className="mt-2 text-lg font-semibold">10 MB / daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Last run</div>
                    <div className="mt-2 text-lg font-semibold">
                        {lastRun?.finishedAt
                            ? formatDate(new Date(lastRun.finishedAt))
                            : "—"}
                    </div>
                    <div className="text-primary-400 mt-1 text-xs">
                        {lastRun
                            ? `${lastRun.rotatedFiles} rotated · ${lastRun.errors.length} errors`
                            : status.isLoading
                              ? "Loading..."
                              : "No recorded run yet"}
                    </div>
                </Card>
            </div>

            {lastAction ? (
                <div className="border-primary-700 border-t px-4 py-3">
                    <div className="text-primary-400 mb-2 text-xs font-semibold tracking-wide uppercase">
                        Last {lastAction.result?.isDryRun ? "dry-run" : "real run"} output
                    </div>
                    <pre className="text-primary-100 max-h-52 overflow-auto rounded-lg bg-black/40 p-3 text-xs">
                        {JSON.stringify(lastAction, null, 2)}
                    </pre>
                </div>
            ) : null}
        </Card>
    );
}
