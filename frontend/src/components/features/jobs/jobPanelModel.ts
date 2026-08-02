import type { CronJob } from "../../../../../contracts/cron";
import type {
    JobDisableIntent,
    ScheduledJob,
} from "../../../../../contracts/jobs/scheduled";

export type JobsView = "scheduled" | "openclaw";
export type DisableMode = JobDisableIntent["mode"];
export type DisableCandidate =
    | { kind: "cron"; job: CronJob }
    | { kind: "scheduled"; job: ScheduledJob };

export const disableModeOptions = [
    {
        value: "until",
        label: "Until a date",
        description: "Heartbeat warns again after this time",
    },
    {
        value: "indefinite",
        label: "Indefinitely",
        description:
            "Heartbeat stays quiet until this annotation changes or the job is enabled",
    },
];

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
