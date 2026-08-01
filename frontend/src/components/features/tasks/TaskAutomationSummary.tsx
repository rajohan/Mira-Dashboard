import type { ComponentProps } from "react";

import type { Task } from "../../../../../contracts/tasks";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronStatusVariant,
} from "../../../utils/cronUtilities";
import { Badge } from "../../ui/Badge";

/**
 * Formats elapsed milliseconds into a short human-readable duration.
 * @param value Value to process.
 * @returns Formatted elapsed milliseconds into a short human-readable duration.
 */
function formatElapsedMs(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
        return "—";
    }

    const seconds = Math.round(value / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Renders live or stored OpenClaw cron metadata for a task.
 * @returns Task automation summary.
 */
export function TaskAutomationSummary({
    automation,
}: {
    automation: NonNullable<Task["automation"]>;
}) {
    let automationStatus: string;
    let automationStatusVariant: ComponentProps<typeof Badge>["variant"];
    if (automation.runningAtMs) {
        automationStatus = "RUNNING";
        automationStatusVariant = "warning";
    } else if (automation.enabled === false) {
        automationStatus = "DISABLED";
        automationStatusVariant = "default";
    } else if (automation.lastRunStatus) {
        automationStatus = formatCronLastStatus(automation.lastRunStatus);
        automationStatusVariant = getCronStatusVariant(automation.lastRunStatus);
    } else {
        automationStatus = "SCHEDULED";
        automationStatusVariant = getCronStatusVariant("");
    }

    return (
        <div className="rounded-lg border border-primary-700 bg-primary-800/50 p-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 className="text-sm font-semibold text-primary-300">
                        Backed by OpenClaw cron
                    </h3>
                    <p className="mt-1 text-xs text-primary-500">
                        This task tracks a recurring automation job.
                    </p>
                </div>
                {automationStatus && (
                    <Badge variant={automationStatusVariant}>{automationStatus}</Badge>
                )}
            </div>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Cron job
                    </dt>
                    <dd className="break-all text-primary-200">
                        <a
                            href={`/jobs?view=openclaw&job=${encodeURIComponent(automation.cronJobId)}`}
                            className="hover:text-primary-100"
                        >
                            {automation.jobName || automation.cronJobId}
                        </a>
                    </dd>
                </div>
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Schedule
                    </dt>
                    <dd className="text-primary-200">
                        {automation.scheduleSummary || "—"}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Next run
                    </dt>
                    <dd className="text-primary-200">
                        {formatCronTimestamp(automation.nextRunAtMs)}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Last run
                    </dt>
                    <dd className="text-primary-200">
                        {formatCronTimestamp(automation.lastRunAtMs)}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Session
                    </dt>
                    <dd className="break-all text-primary-200">
                        {automation.sessionTarget || "—"}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Runtime
                    </dt>
                    <dd className="text-primary-200">
                        {[automation.model, automation.thinking]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                    </dd>
                </div>
                {automation.lastDurationMs !== undefined && (
                    <div>
                        <dt className="text-xs tracking-wide text-primary-500 uppercase">
                            Last duration
                        </dt>
                        <dd className="text-primary-200">
                            {formatElapsedMs(automation.lastDurationMs)}
                        </dd>
                    </div>
                )}
                <div>
                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                        Source
                    </dt>
                    <dd className="text-primary-200">
                        {automation.source === "cron"
                            ? "Live cron state"
                            : "Stored metadata"}
                    </dd>
                </div>
            </dl>
        </div>
    );
}
