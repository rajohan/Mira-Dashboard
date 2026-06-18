import { format, formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

import { appTimeZoneParts, appZonedDate } from "./date";

const appLocale = enUS;

export { APP_TIME_ZONE } from "./date";

function toDateValue(date: Date | string | number): Date {
    return date instanceof Date ? date : new Date(date);
}

// Date & time formatting
/** Formats a date/time value with app timezone date and time fields. */
export function formatDate(date: Date | string | number): string {
    try {
        const d = toDateValue(date);
        if (Number.isNaN(d.getTime())) return String(date);
        return format(appZonedDate(d), "dd.MM.yyyy, HH:mm", { locale: appLocale });
    } catch {
        return String(date);
    }
}

/** Formats a date/time value as an Oslo clock time. */
export function formatOsloClock(date: Date | string | number): string {
    try {
        const d = toDateValue(date);
        if (Number.isNaN(d.getTime())) return "--:--";
        return format(appZonedDate(d), "HH:mm", { locale: appLocale });
    } catch {
        return "--:--";
    }
}

/** Formats a date/time value as a compact app-timezone date stamp. */
export function formatDateStamp(date: Date = new Date()): string {
    try {
        if (Number.isNaN(date.getTime())) return "unknown-date";
        return format(appZonedDate(date), "yyyy-MM-dd", { locale: appLocale });
    } catch {
        return "unknown-date";
    }
}

/** Formats the provided Date with app-timezone time fields. */
export function formatOsloTime(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "--:--:--";
        return format(appZonedDate(date), "HH:mm:ss", { locale: appLocale });
    } catch {
        return "--:--:--";
    }
}

/** Formats the provided Date with app-timezone date fields. */
export function formatOsloDate(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "Unknown date";
        return format(appZonedDate(date), "EEEE dd. MMM yyyy", {
            locale: appLocale,
        });
    } catch {
        return "Unknown date";
    }
}

/** Formats a date/time value as a short app-timezone weekday label. */
export function formatWeekdayShort(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "---";
        return format(appZonedDate(date), "EEE", { locale: appLocale });
    } catch {
        return "---";
    }
}

function zonedDateTimeToUtcDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
): Date {
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let candidate = targetAsUtc;
    for (let index = 0; index < 3; index += 1) {
        const parts = appTimeZoneParts(new Date(candidate));
        const renderedAsUtc = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            0,
            0
        );
        candidate = targetAsUtc - (renderedAsUtc - candidate);
    }
    return new Date(candidate);
}

function referenceDateParts(referenceDate?: Date | string | number | null) {
    const reference = referenceDate ? new Date(referenceDate) : new Date();
    return appTimeZoneParts(Number.isNaN(reference.getTime()) ? new Date() : reference);
}

/** Converts a UTC HH:mm daily schedule value to app-timezone HH:mm. */
export function formatUtcTimeOfDayInAppTimeZone(
    timeOfDay: string | null | undefined,
    referenceDate?: Date | string | number | null
): string {
    if (!timeOfDay || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
        return "--:--";
    }
    const [hour = "0", minute = "0"] = timeOfDay.split(":", 2);
    const parts = referenceDateParts(referenceDate);
    const utcDate = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, Number(hour), Number(minute))
    );
    return formatOsloClock(utcDate);
}

/** Converts an app-timezone HH:mm daily schedule value to UTC HH:mm. */
export function appTimeOfDayToUtcTimeOfDay(
    timeOfDay: string,
    referenceDate?: Date | string | number | null
): string {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
        return timeOfDay;
    }
    const [hour = "0", minute = "0"] = timeOfDay.split(":", 2);
    const parts = referenceDateParts(referenceDate);
    const utcDate = zonedDateTimeToUtcDate(
        parts.year,
        parts.month,
        parts.day,
        Number(hour),
        Number(minute)
    );
    return `${String(utcDate.getUTCHours()).padStart(2, "0")}:${String(
        utcDate.getUTCMinutes()
    ).padStart(2, "0")}`;
}

/** Formats milliseconds as a compact duration string. */
export function formatDuration(updatedAt: number | null | undefined): string {
    if (updatedAt === null || updatedAt === undefined) return "Unknown";
    try {
        return formatDistanceToNow(new Date(updatedAt), {
            addSuffix: true,
            locale: appLocale,
        });
    } catch {
        return "Unknown";
    }
}

// System formatting
/** Formats uptime seconds as days, hours, or minutes. */
export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86_400);

    if (days > 0) {
        const hours = Math.floor((seconds % 86_400) / 3600);
        return days + "d " + hours + "h";
    }

    const mins = Math.floor((seconds % 3600) / 60);
    const hours = Math.floor((seconds % 86_400) / 3600);
    if (hours > 0) return hours + "h " + mins + "m";
    return mins + "m";
}

/** Formats bytes as a human-readable binary size. */
export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    if (unitIndex === 0) return size + " B";
    return size.toFixed(1) + " " + units[unitIndex];
}

/** Formats a numeric load value to two decimal places. */
export function formatLoad(load: number[]): string {
    return load.map((l) => l.toFixed(2)).join(", ");
}

// Token formatting
/** Formats token counts using compact notation. */
export function formatTokens(current: number, max: number): string {
    return (current / 1000).toFixed(1) + "k / " + (max / 1000).toFixed(0) + "k";
}

/** Formats nullable token counts with an em dash fallback. */
export function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + "M";
    if (tokens >= 1000) return (tokens / 1000).toFixed(1) + "K";
    return tokens.toString();
}

/** Calculates token usage percentage from used and limit values. */
export function getTokenPercent(current: number | undefined | null, max: number): number {
    if (current === undefined || current === null || max <= 0) return 0;
    return Math.min(Math.round((current / max) * 100), 100);
}
