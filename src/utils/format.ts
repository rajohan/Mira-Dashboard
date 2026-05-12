import { format, formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

const defaultLocale = enUS;

// Date & time formatting
export function formatDate(date: Date | string | number): string {
    try {
        const d = date instanceof Date ? date : new Date(date);
        return format(d, "dd.MM.yyyy, HH:mm", { locale: defaultLocale });
    } catch {
        return String(date);
    }
}

export function formatDateStamp(date: Date = new Date()): string {
    try {
        return format(date, "yyyy-MM-dd", { locale: defaultLocale });
    } catch {
        return "unknown-date";
    }
}

export function formatOsloTime(date: Date): string {
    try {
        return format(date, "HH:mm:ss", { locale: defaultLocale });
    } catch {
        return "--:--:--";
    }
}

export function formatOsloDate(date: Date): string {
    try {
        return format(date, "EEEE dd. MMM yyyy", { locale: defaultLocale });
    } catch {
        return "Unknown date";
    }
}

export function formatWeekdayShort(date: Date): string {
    try {
        return format(date, "EEE", { locale: defaultLocale });
    } catch {
        return "---";
    }
}

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
export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + mins + "m";
    return mins + "m";
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function formatLoad(load: number[]): string {
    return load.map((l) => l.toFixed(2)).join(", ");
}

// Token formatting
export function formatTokens(current: number, max: number): string {
    return (current / 1000).toFixed(1) + "k / " + (max / 1000).toFixed(0) + "k";
}

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + "M";
    if (tokens >= 1000) return (tokens / 1000).toFixed(1) + "K";
    return tokens.toString();
}

export function getTokenPercent(current: number | undefined | null, max: number): number {
    if (current === undefined || current === null || max <= 0) return 0;
    return Math.min(Math.round((current / max) * 100), 100);
}
