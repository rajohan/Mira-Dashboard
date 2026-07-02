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
        <Card className="overflow-hidden">
            <div className="border-b border-primary-700 px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <RotateCw className="size-4 text-accent-400" />
                            Log rotation
                        </div>
                        <div className="text-xs text-primary-400">
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
                            <FlaskConical className="size-4" />
                            {isDryRun.isPending ? "Running..." : "Run dry-run now"}
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            onClick={() => realRun.mutate()}
                            disabled={isDryRun.isPending || realRun.isPending}
                            className="w-full sm:w-auto"
                        >
                            <Play className="size-4" />
                            {realRun.isPending ? "Running..." : "Run real now"}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-5">
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Workflow</div>
                    <div className="mt-2 text-lg font-semibold">Scheduled real</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Schedule</div>
                    <div className="mt-2 text-lg font-semibold">
                        {formatSchedule(logRotationJob)}
                    </div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Retention</div>
                    <div className="mt-2 text-lg font-semibold">3 archives</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Rotate at</div>
                    <div className="mt-2 text-lg font-semibold">10 MB / daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Last run</div>
                    <div className="mt-2 text-lg font-semibold">
                        {lastRun?.finishedAt
                            ? formatDate(new Date(lastRun.finishedAt))
                            : "—"}
                    </div>
                    <div className="mt-1 text-xs text-primary-400">
                        {lastRun
                            ? `${lastRun.rotatedFiles} rotated · ${lastRun.errors.length} errors`
                            : status.isLoading
                              ? "Loading..."
                              : "No recorded run yet"}
                    </div>
                </Card>
            </div>

            {lastAction ? (
                <div className="border-t border-primary-700 px-4 py-3">
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
