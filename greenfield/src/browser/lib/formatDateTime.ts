import { format } from "date-fns";

/**
 * Formats a contract-validated timestamp in the operator browser's local time.
 * @param timestampMs Unix epoch milliseconds.
 * @returns Stable human-readable local date and time.
 */
export function formatDashboardDateTime(timestampMs: number): string {
    return format(new Date(timestampMs), "yyyy-MM-dd HH:mm:ss");
}
