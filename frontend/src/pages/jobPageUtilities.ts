import type { DateTimePickerValue } from "../components/ui/DateTimePicker";
import { appTimeZoneParts } from "../utils/date";
import { appDateTimeToTimestamp } from "../utils/format";

const DEFAULT_DISABLE_FALLBACK_MS = 60 * 60 * 1000;
const MINIMUM_DEFAULT_DISABLE_WINDOW_MS = 5 * 60 * 1000;

function toDisableUntilDraft(timestamp: number): DateTimePickerValue {
    const parts = appTimeZoneParts(new Date(timestamp));
    return {
        day: parts.day,
        hour: String(parts.hour).padStart(2, "0"),
        minute: String(parts.minute).padStart(2, "0"),
        month: parts.month,
        year: parts.year,
    };
}

function parseDisableUntilDraft(draft: DateTimePickerValue): number | undefined {
    return appDateTimeToTimestamp(
        draft.year,
        draft.month,
        draft.day,
        Number(draft.hour),
        Number(draft.minute)
    );
}

/**
 * Starts a temporary disable at the end of today's application-time-zone date.
 * @param now Now value.
 * @returns Default disable until draft result.
 */
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

export { parseDisableUntilDraft, toDisableUntilDraft };
