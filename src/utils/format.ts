import { format, formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

export function formatDate(dateStr: string): string {
    try {
        return format(new Date(dateStr), "dd.MM.yyyy, HH:mm", { locale: enUS });
    } catch {
        return dateStr;
    }
}

export function formatDuration(updatedAt: number | null | undefined): string {
    if (!updatedAt) return "Unknown";
    return formatDistanceToNow(new Date(updatedAt), { addSuffix: true, locale: enUS });
}

export function formatTokens(current: number, max: number): string {
    return (current / 1000).toFixed(1) + "k / " + (max / 1000).toFixed(0) + "k";
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function getTokenPercent(current: number, max: number): number {
    return Math.min(Math.round((current / max) * 100), 100);
}

export function getTokenColor(percent: number): string {
    if (percent < 50) return "text-green-400";
    if (percent < 75) return "text-yellow-400";
    if (percent < 90) return "text-orange-400";
    return "text-red-400";
}

export function getTokenBarColor(percent: number): string {
    if (percent < 50) return "bg-green-500";
    if (percent < 75) return "bg-yellow-500";
    if (percent < 90) return "bg-orange-500";
    return "bg-red-500";
}

export function getSessionTypeBadgeColor(type: string | null | undefined): string {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN": {
            return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        }
        case "HOOK": {
            return "bg-green-500/20 text-green-400 border-green-500/30";
        }
        case "CRON": {
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        }
        case "SUBAGENT": {
            return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        }
        default: {
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
        }
    }
}

export function getPriorityBadgeColor(priority: string): string {
    switch (priority) {
        case "high": {
            return "bg-red-500/20 text-red-400 border-red-500/30";
        }
        case "medium": {
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        }
        case "low": {
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
        }
        default: {
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
        }
    }
}

export function getLogLevelColor(level: string): string {
    switch (level.toLowerCase()) {
        case "trace":
        case "debug": {
            return "text-slate-400";
        }
        case "info": {
            return "text-blue-400";
        }
        case "warn":
        case "warning": {
            return "text-yellow-400";
        }
        case "error": {
            return "text-orange-400";
        }
        case "fatal": {
            return "text-red-400";
        }
        default: {
            return "text-slate-300";
        }
    }
}