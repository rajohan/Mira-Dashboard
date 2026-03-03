import { type LogEntry } from "../types/log";

export function parseLogLine(line: string): LogEntry {
    // Try to parse JSON log line
    try {
        const parsed = JSON.parse(line);
        return {
            ts: parsed.ts || parsed.timestamp,
            level: parsed.level || "info",
            subsystem: parsed.subsystem || parsed.component || "",
            msg: parsed.msg || parsed.message || line,
            raw: line,
        };
    } catch {
        // Plain text log line
        const levelMatch = line.match(/\b(trace|debug|info|warn|warning|error|fatal)\b/i);
        return {
            level: levelMatch ? levelMatch[1].toLowerCase() : "info",
            msg: line,
            raw: line,
        };
    }
}

export function formatLogTime(ts?: string): string {
    if (!ts) return "";
    try {
        const date = new Date(ts);
        return date.toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            fractionalSecondDigits: 3,
        } as Intl.DateTimeFormatOptions);
    } catch {
        return ts;
    }
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function getLevelColor(level?: string): string {
    if (!level) return "text-slate-300";
    switch (level.toLowerCase()) {
        case "trace":
        case "debug":
            return "text-slate-400";
        case "info":
            return "text-blue-400";
        case "warn":
        case "warning":
            return "text-yellow-400";
        case "error":
            return "text-orange-400";
        case "fatal":
            return "text-red-400";
        default:
            return "text-slate-300";
    }
}

export function getSubsystemColor(subsystem?: string): string {
    if (!subsystem) return "text-slate-400";
    const colors = [
        "text-pink-400",
        "text-purple-400",
        "text-indigo-400",
        "text-cyan-400",
        "text-teal-400",
        "text-emerald-400",
        "text-lime-400",
        "text-amber-400",
    ];
    const hash = subsystem.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
}