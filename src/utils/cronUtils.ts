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

function cronFieldIsValid(field: string, minimum: number, maximum: number): boolean {
    return field.split(",").every((part) => {
        if (!part) return false;
        const stepPieces = part.split("/");
        if (stepPieces.length > 2) return false;
        const [rangePart = "", stepPart] = stepPieces;
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isSafeInteger(step) || step < 1) return false;
        const rangePieces = rangePart.split("-");
        if (rangePieces.length > 2) return false;
        const [start, end] =
            rangePart === "*"
                ? [minimum, maximum]
                : rangePart.includes("-")
                  ? rangePieces.map(Number)
                  : [
                        Number(rangePart),
                        stepPart === undefined ? Number(rangePart) : maximum,
                    ];
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
export function cronExpressionIsValid(expression: string): boolean {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) return false;
    const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
    return (
        cronFieldIsValid(minute, 0, 59) &&
        cronFieldIsValid(hour, 0, 23) &&
        cronFieldIsValid(dayOfMonth, 1, 31) &&
        cronFieldIsValid(month, 1, 12) &&
        cronFieldIsValid(dayOfWeek, 0, 7)
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
    if (["ok", "success", "succeeded", "completed"].includes(normalized)) {
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
