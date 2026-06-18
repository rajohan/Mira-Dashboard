import { formatDistanceToNow, intlFormat } from "date-fns";
import { enUS } from "date-fns/locale";

const defaultLocale = enUS;
export const APP_TIME_ZONE = "Europe/Oslo";

const dateTimeFormatOptions: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: APP_TIME_ZONE,
    year: "numeric",
};
const osloClockFormatOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
};
const osloTimeFormatOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    timeZone: APP_TIME_ZONE,
};
const dateStampFormatOptions: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    timeZone: APP_TIME_ZONE,
    year: "numeric",
};
const weekdayFormatOptions: Intl.DateTimeFormatOptions = {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
};
const osloDateFormatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    timeZone: APP_TIME_ZONE,
    weekday: "long",
    year: "numeric",
});
const appTimeZonePartsFormatter = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: APP_TIME_ZONE,
    year: "numeric",
});

// Date & time formatting
/** Formats a date/time value with app timezone date and time fields. */
export function formatDate(date: Date | string | number): string {
    try {
        const d = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(d.getTime())) return String(date);
        return intlFormat(d, dateTimeFormatOptions, { locale: "nb-NO" });
    } catch {
        return String(date);
    }
}

/** Formats a date/time value as an Oslo clock time. */
export function formatOsloClock(date: Date | string | number): string {
    try {
        const d = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(d.getTime())) return "--:--";
        return intlFormat(d, osloClockFormatOptions, { locale: "en-GB" });
    } catch {
        return "--:--";
    }
}

/** Formats a date/time value as a compact app-timezone date stamp. */
export function formatDateStamp(date: Date = new Date()): string {
    try {
        if (Number.isNaN(date.getTime())) return "unknown-date";
        return intlFormat(date, dateStampFormatOptions, { locale: "en-CA" });
    } catch {
        return "unknown-date";
    }
}

/** Formats the provided Date with app-timezone time fields. */
export function formatOsloTime(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "--:--:--";
        return intlFormat(date, osloTimeFormatOptions, { locale: "en-GB" });
    } catch {
        return "--:--:--";
    }
}

/** Formats the provided Date with app-timezone date fields. */
export function formatOsloDate(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "Unknown date";
        const parts = osloDateFormatter.formatToParts(date);
        const values = Object.fromEntries(
            parts.map((part) => [part.type, part.value])
        ) as Record<Intl.DateTimeFormatPartTypes, string>;
        return `${values.weekday} ${Number(values.day)}. ${values.month} ${values.year}`;
    } catch {
        return "Unknown date";
    }
}

/** Formats a date/time value as a short app-timezone weekday label. */
export function formatWeekdayShort(date: Date): string {
    try {
        if (Number.isNaN(date.getTime())) return "---";
        return intlFormat(date, weekdayFormatOptions, { locale: "en-US" });
    } catch {
        return "---";
    }
}

function appTimeZoneParts(date: Date): {
    day: number;
    hour: number;
    minute: number;
    month: number;
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
        year: Number(values.year),
    };
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
            locale: defaultLocale,
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
