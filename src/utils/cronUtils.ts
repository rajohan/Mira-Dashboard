import type { CronJob } from "../hooks";
import { formatDate } from "./format";

/** Returns cron job ID. */
export function getCronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

/** Returns cron job name. */
export function getCronJobName(job: CronJob): string {
    return String(job.name || getCronJobId(job) || "Unnamed job");
}

/** Sorts cron jobs. */
export function sortCronJobs(jobs: CronJob[]): CronJob[] {
    return [...jobs].sort((a, b) => {
        const enabledA = a.enabled === false ? 1 : 0;
        const enabledB = b.enabled === false ? 1 : 0;
        if (enabledA !== enabledB) {
            return enabledA - enabledB;
        }

        return getCronJobName(a).localeCompare(getCronJobName(b));
    });
}

/** Returns cron state value. */
export function getCronStateValue(job: CronJob, key: string): unknown {
    const state = job.state;
    if (!state || typeof state !== "object") {
        return undefined;
    }

    return (state as Record<string, unknown>)[key];
}

/** Formats cron timestamp for display. */
export function formatCronTimestamp(value: unknown): string {
    if (typeof value !== "number") {
        return "—";
    }

    return formatDate(value);
}

/** Formats cron last status for display. */
export function formatCronLastStatus(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        return "UNKNOWN";
    }

    return value.toUpperCase();
}

/** Returns cron status variant. */
export function getCronStatusVariant(
    value: string
): "success" | "warning" | "error" | "default" {
    const normalized = value.toLowerCase();
    if (normalized === "ok" || normalized === "success") {
        return "success";
    }

    if (normalized === "running") {
        return "warning";
    }

    if (normalized === "error" || normalized === "failed") {
        return "error";
    }

    return "default";
}
