import { format } from "date-fns";

export const APP_TIME_ZONE = "Europe/Oslo";
export const APP_LOCALE_CODE = "en-US";

const appTimeZonePartsFormatter = new Intl.DateTimeFormat(APP_LOCALE_CODE, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: APP_TIME_ZONE,
    year: "numeric",
});

export function appTimeZoneParts(date: Date): {
    day: number;
    hour: number;
    minute: number;
    month: number;
    second: number;
    year: number;
} {
    const parts = appTimeZonePartsFormatter.formatToParts(date);
    const values = Object.fromEntries(
        parts.map((part) => [part.type, part.value])
    ) as Record<Intl.DateTimeFormatPartTypes, string>;
    return {
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        month: Number(values.month),
        second: Number(values.second),
        year: Number(values.year),
    };
}

export function appZonedDate(date: Date): Date {
    const parts = appTimeZoneParts(date);
    return new Date(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        date.getMilliseconds()
    );
}

/** Returns the current timestamp as an ISO string. */
export function currentIsoString(): string {
    const date = new Date();
    return date.toISOString();
}

/** Returns an ISO string for a timestamp-like value. */
export function isoStringFromDate(value: number | string | Date): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new RangeError("Invalid date value");
    }

    return date.toISOString();
}

/** Returns milliseconds for a date string, or null when invalid. */
export function timestampFromDateString(value: string): number | null {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

/** Returns the current calendar year. */
export function currentYear(): number {
    const year = format(appZonedDate(new Date()), "yyyy");
    return Number(year);
}
