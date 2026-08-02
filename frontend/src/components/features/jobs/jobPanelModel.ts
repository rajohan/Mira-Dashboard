import type { ScheduledJob } from "../../../../../contracts/jobs/scheduled";

export type JobsView = "scheduled" | "openclaw";

/**
 * Reads the initially selected jobs view from the current URL.
 * @returns Initial jobs view.
 */
export function getInitialJobsView(): JobsView {
    const parameters = new URLSearchParams(location.search);
    return parameters.get("view") === "openclaw" ? "openclaw" : "scheduled";
}

/**
 * Reads the initially selected OpenClaw cron job from the current URL.
 * @returns Initial cron job identifier.
 */
export function getInitialCronJobId(): string {
    const parameters = new URLSearchParams(location.search);
    return parameters.get("job") || "";
}

/**
 * Returns scheduled jobs in stable name and identifier order.
 * @param jobs Jobs to order.
 * @returns Sorted copy of the scheduled jobs.
 */
export function sortScheduledJobs(jobs: ScheduledJob[]): ScheduledJob[] {
    return jobs.toSorted(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
}
