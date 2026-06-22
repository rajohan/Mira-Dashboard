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
    return [...jobs].toSorted((a, b) => {
        const enabledA = a.enabled === false ? 1 : 0;
        const enabledB = b.enabled === false ? 1 : 0;
        if (enabledA !== enabledB) {
            return enabledA - enabledB;
        }

        return getCronJobName(a).localeCompare(getCronJobName(b));
    });
}

function parseCronNumber(value: string): number | undefined {
    if (!/^\d+$/u.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

function isCronFieldValid(field: string, minimum: number, maximum: number): boolean {
    return field.split(",").every((part) => {
        if (!part) return false;
        const stepPieces = part.split("/");
        if (stepPieces.length > 2) return false;
        const [rangePart = "", stepPart] = stepPieces;
        const step = stepPart === undefined ? 1 : parseCronNumber(stepPart);
        if (step === undefined) return false;
        if (!Number.isSafeInteger(step) || step < 1) return false;
        const rangePieces = rangePart.split("-");
        if (rangePieces.length > 2) return false;
        let start = minimum;
        let end = maximum;
        if (rangePart !== "*") {
            if (rangePart.includes("-")) {
                const [parsedStart, parsedEnd] = rangePieces.map((value) =>
                    parseCronNumber(value)
                );
                if (parsedStart === undefined || parsedEnd === undefined) return false;
                start = parsedStart;
                end = parsedEnd;
            } else {
                const parsedValue = parseCronNumber(rangePart);
                if (parsedValue === undefined) return false;
                start = parsedValue;
                end = stepPart === undefined ? parsedValue : maximum;
            }
        }
        return (
            Number.isSafeInteger(start) &&
            Number.isSafeInteger(end) &&
            start >= minimum &&
            end <= maximum &&
            start <= end
        );
    });
}

/** Returns whether an expression matches the supported five-field cron syntax. */
export function isCronExpressionValid(expression: string): boolean {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) return false;
    const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
    return (
        isCronFieldValid(minute, 0, 59) &&
        isCronFieldValid(hour, 0, 23) &&
        isCronFieldValid(dayOfMonth, 1, 31) &&
        isCronFieldValid(month, 1, 12) &&
        isCronFieldValid(dayOfWeek, 0, 7)
    );
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
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "—";
    }

    return formatDate(value);
}

/** Formats cron last status for display. */
export function formatCronLastStatus(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        return "UNKNOWN";
    }

    return normalized.toUpperCase();
}

/** Returns cron status variant. */
export function getCronStatusVariant(
    value: string
): "success" | "warning" | "error" | "default" {
    const normalized = value.trim().toLowerCase();
    if (["isok", "ok", "success", "succeeded", "completed"].includes(normalized)) {
        return "success";
    }

    if (
        ["running", "pending", "queued", "in_progress", "in-progress"].includes(
            normalized
        )
    ) {
        return "warning";
    }

    if (["error", "failed", "failure"].includes(normalized)) {
        return "error";
    }

    return "default";
}
