import { format } from "date-fns";

/**
 * Formats a contract-validated timestamp in the operator browser's local time.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Stable human-readable local date and time.
 */
export function formatDashboardDateTime(timestampMs: number): string {
    return format(new Date(timestampMs), "dd.MM.yyyy · HH:mm:ss");
}

/**
 * Formats a timestamp to minute precision for schedule configuration summaries.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Human-readable local date and 24-hour time without operational seconds.
 */
export function formatDashboardDateTimeToMinute(timestampMs: number): string {
    return format(new Date(timestampMs), "dd.MM.yyyy · HH:mm");
}
