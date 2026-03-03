import { format } from "date-fns";
import { enUS } from "date-fns/locale";

import type { LogEntry } from "../types/log";

export function parseLogLine(line: string): LogEntry | null {
    if (!line || !line.trim()) return null;

    let jsonStr = line;

    if (!line.startsWith("{")) {
        const braceIdx = line.indexOf("{");
        if (braceIdx !== -1) {
            jsonStr = line.slice(braceIdx);
        }
    }

    try {
        const parsed = JSON.parse(jsonStr);

        const level =
            parsed._meta?.logLevelName || parsed.level || parsed.lvl || "INFO";
        const ts = parsed._meta?.date || parsed.time || parsed.timestamp;

        let subsystem = "";
        let msg = "";

        if (parsed[0]) {
            if (typeof parsed[0] === "string" && parsed[0].startsWith("{")) {
                try {
                    const subParsed = JSON.parse(parsed[0]);
                    subsystem = subParsed.subsystem || subParsed.module || "";
                } catch {
                    msg = String(parsed[0]);
                }
            } else if (typeof parsed[0] === "string") {
                msg = parsed[0];
            }
        }

        if (parsed[1] && !msg) {
            if (typeof parsed[1] === "string") {
                msg = parsed[1];
            } else if (parsed[2] && typeof parsed[2] === "string") {
                msg = parsed[2];
            } else if (typeof parsed[1] === "object") {
                msg = JSON.stringify(parsed[1]);
            }
        }

        if (!msg) {
            msg = parsed.msg || parsed.message || line;
        }

        // Ensure msg is always a string
        if (typeof msg !== "string") {
            msg = JSON.stringify(msg);
        }

        if (!subsystem && msg) {
            const bracketMatch = msg.match(/^\[(\w+)\]\s*/);
            if (bracketMatch) {
                subsystem = bracketMatch[1];
                msg = msg.slice(bracketMatch[0].length);
            } else {
                const colonMatch = msg.match(/^(\w+):\s*/);
                if (colonMatch) {
                    subsystem = colonMatch[1];
                    msg = msg.slice(colonMatch[0].length);
                }
            }
        }

        return { ts, level: level.toLowerCase(), subsystem, msg, raw: line };
    } catch {
        return { msg: line, raw: line };
    }
}

export function formatLogTime(ts?: string): string {
    if (!ts) return "";
    try {
        return format(new Date(ts), "HH:mm:ss", { locale: enUS });
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
    const l = (level || "info").toLowerCase();
    switch (l) {
        case "fatal": {
            return "text-red-400 bg-red-500/20";
        }
        case "error": {
            return "text-red-400 bg-red-500/20";
        }
        case "warn": {
            return "text-yellow-400 bg-yellow-500/20";
        }
        case "info": {
            return "text-blue-400 bg-blue-500/20";
        }
        case "debug": {
            return "text-slate-400 bg-slate-500/20";
        }
        case "trace": {
            return "text-slate-500 bg-slate-500/10";
        }
        default: {
            return "text-slate-400 bg-slate-500/20";
        }
    }
}

export function getSubsystemColor(subsystem?: string): string {
    if (!subsystem) return "";
    const s = subsystem.toLowerCase();
    switch (s) {
        case "exec": {
            return "text-green-400";
        }
        case "tools": {
            return "text-orange-400";
        }
        case "agent": {
            return "text-purple-400";
        }
        case "gateway": {
            return "text-cyan-400";
        }
        case "cron": {
            return "text-pink-400";
        }
        case "session": {
            return "text-indigo-400";
        }
        case "http": {
            return "text-teal-400";
        }
        case "ws": {
            return "text-amber-400";
        }
        case "memory": {
            return "text-emerald-400";
        }
        default: {
            return "text-purple-400";
        }
    }
}