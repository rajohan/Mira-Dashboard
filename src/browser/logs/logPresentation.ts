import type { LogLine, LogSource } from "../../contracts/logs.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";

type LogSeverity = LogLine["severity"];
type LogSourceGroup = LogSource["group"];

const groupLabels: Readonly<Record<LogSourceGroup, string>> = Object.freeze({
    dashboard: "Dashboard",
    host: "Host",
    openclaw: "OpenClaw",
});

/**
 * @param error Unknown protocol or transport failure.
 * @returns Stable operator-facing failure copy without adapter diagnostics.
 */
export function logFailureMessage(error: unknown): string {
    switch (classifyDashboardBrowserFailure(error)) {
        case "not-found": {
            return "The selected log source is no longer available. Refresh the source list.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}

/**
 * @param group Contract-owned path-free source group.
 * @returns Display label for a path-free source group.
 */
export function logSourceGroupLabel(group: LogSourceGroup): string {
    return groupLabels[group];
}

/**
 * @param severity Normalized server-owned severity.
 * @returns Badge treatment for a normalized server-owned severity.
 */
export function logSeverityVariant(
    severity: LogSeverity
): "danger" | "default" | "info" | "warning" {
    if (severity === "fatal" || severity === "error") return "danger";
    if (severity === "warn") return "warning";
    if (severity === "info") return "info";
    return "default";
}
