import type { CronJob } from "../hooks";
import { formatDate } from "./format";

export function getCronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

export function getCronJobName(job: CronJob): string {
    return String(job.name || getCronJobId(job) || "Unnamed job");
}

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

export function getCronStateValue(job: CronJob, key: string): unknown {
    const state = job.state;
    if (!state || typeof state !== "object") {
        return undefined;
    }

    return (state as Record<string, unknown>)[key];
}

export function formatCronTimestamp(value: unknown): string {
    if (typeof value !== "number") {
        return "—";
    }

    return formatDate(value);
}

export function formatCronLastStatus(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        return "UNKNOWN";
    }

    return value.toUpperCase();
}

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
