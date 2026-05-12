import { format, formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

const defaultLocale = enUS;

// Date & time formatting
/** Handles format date. */
export function formatDate(date: Date | string | number): string {
    try {
        const d = date instanceof Date ? date : new Date(date);
        return format(d, "dd.MM.yyyy, HH:mm", { locale: defaultLocale });
    } catch {
        return String(date);
    }
}

/** Handles format date stamp. */
export function formatDateStamp(date: Date = new Date()): string {
    try {
        return format(date, "yyyy-MM-dd", { locale: defaultLocale });
    } catch {
        return "unknown-date";
    }
}

/** Handles format oslo time. */
export function formatOsloTime(date: Date): string {
    try {
        return format(date, "HH:mm:ss", { locale: defaultLocale });
    } catch {
        return "--:--:--";
    }
}

/** Handles format oslo date. */
export function formatOsloDate(date: Date): string {
    try {
        return format(date, "EEEE dd. MMM yyyy", { locale: defaultLocale });
    } catch {
        return "Unknown date";
    }
}

/** Handles format weekday short. */
export function formatWeekdayShort(date: Date): string {
    try {
        return format(date, "EEE", { locale: defaultLocale });
    } catch {
        return "---";
    }
}

/** Handles format duration. */
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
/** Handles format uptime. */
export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + mins + "m";
    return mins + "m";
}

/** Handles format size. */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Handles format load. */
export function formatLoad(load: number[]): string {
    return load.map((l) => l.toFixed(2)).join(", ");
}

// Token formatting
/** Handles format tokens. */
export function formatTokens(current: number, max: number): string {
    return (current / 1000).toFixed(1) + "k / " + (max / 1000).toFixed(0) + "k";
}

/** Handles format token count. */
export function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + "M";
    if (tokens >= 1000) return (tokens / 1000).toFixed(1) + "K";
    return tokens.toString();
}

/** Handles get token percent. */
export function getTokenPercent(current: number | undefined | null, max: number): number {
    if (current === undefined || current === null || max <= 0) return 0;
    return Math.min(Math.round((current / max) * 100), 100);
}
