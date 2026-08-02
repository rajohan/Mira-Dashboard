import type { CronJob } from "../../../../../contracts/cron";
import type {
    JobDisableIntent,
    ScheduledJob,
} from "../../../../../contracts/jobs/scheduled";
import { appTimeZoneParts } from "../../../utils/date";
import { appDateTimeToTimestamp } from "../../../utils/format";
import type { DateTimePickerValue } from "../../ui/DateTimePicker";

const DEFAULT_DISABLE_FALLBACK_MS = 60 * 60 * 1000;
const MINIMUM_DEFAULT_DISABLE_WINDOW_MS = 5 * 60 * 1000;

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

export function toDisableUntilDraft(timestamp: number): DateTimePickerValue {
    const parts = appTimeZoneParts(new Date(timestamp));
    return {
        day: parts.day,
        hour: String(parts.hour).padStart(2, "0"),
        minute: String(parts.minute).padStart(2, "0"),
        month: parts.month,
        year: parts.year,
    };
}

export function parseDisableUntilDraft(draft: DateTimePickerValue): number | undefined {
    return appDateTimeToTimestamp(
        draft.year,
        draft.month,
        draft.day,
        Number(draft.hour),
        Number(draft.minute)
    );
}

// Starts a temporary disable at the end of today's application-time-zone date.
export function defaultDisableUntilDraft(now = Date.now()): DateTimePickerValue {
    const today = appTimeZoneParts(new Date(now));
    const endOfToday = {
        day: today.day,
        hour: "23",
        minute: "59",
        month: today.month,
        year: today.year,
    };
    const endOfTodayTimestamp = parseDisableUntilDraft(endOfToday);
    return endOfTodayTimestamp !== undefined &&
        endOfTodayTimestamp - now >= MINIMUM_DEFAULT_DISABLE_WINDOW_MS
        ? endOfToday
        : toDisableUntilDraft(now + DEFAULT_DISABLE_FALLBACK_MS);
}

// Resolves the initial date/time draft for an existing disable annotation.
export function disableUntilDraftForCandidate(
    candidate: DisableCandidate
): DateTimePickerValue {
    const existingIntent = candidate.job.disableIntent;
    if (existingIntent?.mode === "until" && existingIntent.until) {
        const timestamp = Date.parse(existingIntent.until);
        if (Number.isFinite(timestamp)) return toDisableUntilDraft(timestamp);
    }
    return defaultDisableUntilDraft();
}
