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

function formatJobNextRunTime(job: ScheduledJob): string | undefined {
    if (!job.nextRunAt) return undefined;
    const formatted = formatOsloClock(job.nextRunAt);
    return formatted === "--:--" ? undefined : formatted;
}

function formatCronSchedule(job: ScheduledJob, expression: string): string {
    const parts = expression.trim().split(/\s+/u);
    if (
        parts.length === 5 &&
        /^\d+$/u.test(parts[0] ?? "") &&
        /^\d+$/u.test(parts[1] ?? "") &&
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
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Log rotation
                </h3>
                <RotateCw className="size-4 text-primary-400" />
            </div>

            <div className="space-y-2 text-sm text-primary-200">
                <div className="flex items-center justify-between gap-2">
                    <span>Workflow</span>
                    <span className="text-primary-100">Scheduled real</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span>Schedule</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {formatSchedule(logRotationJob)}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span>Retention</span>
                    <span className="text-primary-100">3 archives</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span>Rotate at</span>
                    <span className="text-primary-100">10 MB / daily</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0">Last run</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {lastRun?.finishedAt
                            ? formatDate(new Date(lastRun.finishedAt))
                            : "—"}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span>Result</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {lastRun
                            ? `${lastRun.rotatedFiles} rotated · ${lastRun.errors.length} errors`
                            : status.isLoading
                              ? "Loading..."
                              : "No recorded run yet"}
                    </span>
                </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2">
                <Button
                    size="sm"
                    onClick={() => isDryRun.mutate()}
                    disabled={isDryRun.isPending || realRun.isPending}
                    className="w-full justify-center"
                >
                    <FlaskConical className="size-4" />
                    {isDryRun.isPending ? "Running..." : "Run dry-run now"}
                </Button>
                <Button
                    size="sm"
                    variant="danger"
                    onClick={() => realRun.mutate()}
                    disabled={isDryRun.isPending || realRun.isPending}
                    className="w-full justify-center"
                >
                    <Play className="size-4" />
                    {realRun.isPending ? "Running..." : "Run real now"}
                </Button>
            </div>

            {lastAction ? (
                <div className="mt-4 border-t border-primary-700 pt-3">
                    <div className="mb-2 text-xs font-semibold tracking-wide text-primary-400 uppercase">
                        Last {lastAction.result?.isDryRun ? "dry-run" : "real run"} output
                    </div>
                    <pre className="max-h-52 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-primary-100">
                        {JSON.stringify(lastAction, undefined, 2)}
                    </pre>
                </div>
            ) : undefined}
        </Card>
    );
}
