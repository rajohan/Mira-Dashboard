import type { NotificationRecord } from "../../contracts/monitoring.ts";

type NotificationSeverity = NotificationRecord["severity"];

/**
 * Resolves the safest reviewed destination represented by one notification.
 * @param notification Validated notification record.
 * @returns Same-origin destination and operator-facing action label when available.
 */
export function notificationDestination(
    notification: NotificationRecord
): Readonly<{ href: string; label: string }> | undefined {
    if (notification.linkUrl !== undefined) {
        return { href: notification.linkUrl, label: "Open notification" };
    }
    if (notification.reportId !== undefined) {
        return {
            href: `/reports?reportId=${encodeURIComponent(notification.reportId)}`,
            label: "Open report",
        };
    }
    if (notification.incidentId !== undefined) {
        return {
            href: `/incidents?incidentId=${encodeURIComponent(notification.incidentId)}`,
            label: "Open incident",
        };
    }
    return undefined;
}

/** @returns Shared semantic severity treatment for notification surfaces. */
export function notificationSeverityBadgeVariant(
    severity: NotificationSeverity
): "danger" | "info" | "warning" {
    if (severity === "critical" || severity === "error") return "danger";
    return severity === "warning" ? "warning" : "info";
}
