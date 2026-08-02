import type { ScheduledJob, ScheduledJobRunStatus } from "../../../../../contracts/jobs";
import { formatUtcTimeOfDayInAppTimeZone } from "../../../utils/format";

export const scheduleTypeOptions = [
    { value: "interval", label: "Interval", description: "Run every N seconds" },
    { value: "daily", label: "Daily", description: "Run once per day" },
    { value: "cron", label: "Cron", description: "Use a five-field cron expression" },
];
export const hourOptions = Array.from({ length: 24 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});
export const minuteOptions = Array.from({ length: 60 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});
export function formatScheduledJobSchedule(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.scheduleType === "daily") {
        return `Daily at ${formatUtcTimeOfDayInAppTimeZone(job.timeOfDay, job.nextRunAt)}`;
    }
    if (job.scheduleType === "cron") return job.cronExpression || "Cron schedule";
    if (job.intervalSeconds < 60) return `Every ${job.intervalSeconds}s`;
    const minutes = Math.round(job.intervalSeconds / 60);
    if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60}h`;
    return `Every ${minutes}m`;
}

export function scheduledJobStatusVariant(job: ScheduledJob) {
    if (!job.enabled) return "warning" as const;
    if (job.isQueued || job.lastRun?.status === "queued") return "info" as const;
    if (job.isRunning || job.lastRun?.status === "running") return "info" as const;
    if (job.lastRun?.status === "cancelled") return "warning" as const;
    if (job.lastRun?.status === "failed") return "error" as const;
    if (job.lastRun?.status === "success") return "success" as const;
    return "default" as const;
}

export function scheduledJobStatusLabel(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.isQueued || job.lastRun?.status === "queued") return "Queued";
    if (job.isRunning || job.lastRun?.status === "running") return "Running";
    return job.lastRun?.status || "Never run";
}

export function scheduledRunButtonLabel(job: ScheduledJob, runPending: boolean): string {
    if (runPending) return "Queueing...";
    if (job.isQueued) return "Queued";
    if (job.isRunning) return "Running...";
    return "Run now";
}

export function scheduledRunStatusVariant(status: ScheduledJobRunStatus) {
    if (status === "success") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "cancelled") return "warning" as const;
    return "info" as const;
}

export function parsePositiveInteger(value: string): number | undefined {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatRunOutput(output: Record<string, unknown>): string {
    return JSON.stringify(output, undefined, 2);
}
