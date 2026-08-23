import { format, formatDistance } from "date-fns";

/**
 * Formats a contract-validated timestamp in the operator browser's local time.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Stable human-readable local date and time.
 */
export function formatDashboardDateTime(timestampMs: number): string {
    const [date, time] = formatDashboardDateTimeParts(timestampMs);
    return `${date} · ${time}`;
}

/**
 * Formats a timestamp into independently renderable local date and time parts.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Date and 24-hour time without a layout-specific separator.
 */
export function formatDashboardDateTimeParts(
    timestampMs: number
): readonly [date: string, time: string] {
    const date = new Date(timestampMs);
    return [format(date, "dd.MM.yyyy"), format(date, "HH:mm:ss")];
}

/**
 * Formats a timestamp as a weekday followed by the shared day-first Dashboard date.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Compact weekday and date such as `Sunday, 23.08.2026`.
 */
export function formatDashboardWeekdayDate(timestampMs: number): string {
    return format(new Date(timestampMs), "EEEE, dd.MM.yyyy");
}

/**
 * Formats a timestamp as human relative activity copy.
 * @param timestampMs Unix epoch milliseconds.
 * @param referenceTimestampMs Reference clock used for deterministic callers and tests.
 * @returns English relative time such as "13 minutes ago".
 */
export function formatDashboardRelativeTime(
    timestampMs: number,
    referenceTimestampMs = Date.now()
): string {
    return formatDistance(new Date(timestampMs), new Date(referenceTimestampMs), {
        addSuffix: true,
    });
}

/**
 * Formats a timestamp to minute precision for schedule configuration summaries.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Human-readable local date and 24-hour time without operational seconds.
 */
export function formatDashboardDateTimeToMinute(timestampMs: number): string {
    return format(new Date(timestampMs), "dd.MM.yyyy · HH:mm");
}
