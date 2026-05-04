import type { LogEntry } from "../types/log";
import { formatOsloTime } from "./format";

export const LINE_OPTIONS = [100, 500, 1000, 2000, 5000] as const;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

let logIdCounter = 0;

function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function stringifyCompact(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeSubsystemCandidate(value: string): string {
    return value.replace(/^agent\//, "");
}

function extractSubsystemAndMessage(msg: string): { subsystem: string; msg: string } {
    const bracketMatch = msg.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(bracketMatch[1] || ""),
            msg: msg.slice(bracketMatch[0].length),
        };
    }

    const colonMatch = msg.match(/^([a-zA-Z][\w/-]*):\s*/);
    if (colonMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(colonMatch[1] || ""),
            msg: msg.slice(colonMatch[0].length),
        };
    }

    return { subsystem: "", msg };
}

function normalizeStructuredMessage(parsed: Record<string, unknown>): {
    msg: string;
    subsystem: string;
} | null {
    const positionalZero = parsed[0] ?? parsed["0"];
    const positionalOne = parsed[1] ?? parsed["1"];
    const positionalTwo = parsed[2] ?? parsed["2"];

    let subsystem = "";
    let msg = "";

    if (typeof positionalZero === "string") {
        const trimmed = positionalZero.trim();

        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            const nested = safeJsonParse(trimmed);
            if (nested && typeof nested === "object") {
                const nestedRecord = nested as Record<string, unknown>;
                subsystem =
                    typeof nestedRecord.subsystem === "string"
                        ? nestedRecord.subsystem
                        : typeof nestedRecord.module === "string"
                          ? nestedRecord.module
                          : "";

                const nestedMessage =
                    nestedRecord.msg ??
                    nestedRecord.message ??
                    nestedRecord[0] ??
                    nestedRecord["0"];
                if (typeof nestedMessage === "string" && nestedMessage.trim()) {
                    msg = nestedMessage;
                } else if (nestedMessage != null && String(nestedMessage).trim()) {
                    msg = stringifyCompact(nestedMessage);
                } else if (!subsystem) {
                    msg = positionalZero;
                }
            } else {
                msg = positionalZero;
            }
        } else {
            msg = positionalZero;
        }
    } else if (positionalZero != null && positionalZero !== "") {
        msg = stringifyCompact(positionalZero);
    }

    if (!msg && typeof positionalOne === "string") {
        msg = positionalOne;
    } else if (!msg && positionalOne != null) {
        msg = stringifyCompact(positionalOne);
    }

    if (!msg && typeof positionalTwo === "string") {
        msg = positionalTwo;
    }

    if (!msg) {
        const fallback = parsed.msg ?? parsed.message;
        if (typeof fallback === "string") {
            msg = fallback;
        } else if (fallback != null) {
            msg = stringifyCompact(fallback);
        }
    }

    if (!msg.trim()) {
        msg = stringifyCompact(parsed);
    }

    if (!subsystem) {
        const extracted = extractSubsystemAndMessage(msg);
        subsystem = extracted.subsystem;
        msg = extracted.msg;
    }

    return { subsystem, msg };
}

function buildDedupeKey(entry: {
    ts?: string;
    level?: string;
    subsystem?: string;
    msg: string;
}): string {
    return [
        entry.ts || "",
        (entry.level || "").toLowerCase(),
        entry.subsystem || "",
        entry.msg,
    ]
        .join("|")
        .trim();
}

export function parseLogLine(line: string, index?: number): LogEntry | null {
    if (!line || !line.trim()) return null;

    let jsonStr = line;

    if (!line.startsWith("{")) {
        const braceIdx = line.indexOf("{");
        if (braceIdx !== -1) {
            jsonStr = line.slice(braceIdx);
        }
    }

    try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const level =
            typeof parsed._meta === "object" &&
            parsed._meta &&
            "logLevelName" in parsed._meta
                ? String((parsed._meta as Record<string, unknown>).logLevelName || "INFO")
                : String(parsed.level || parsed.lvl || "INFO");
        const ts =
            typeof parsed._meta === "object" && parsed._meta && "date" in parsed._meta
                ? String((parsed._meta as Record<string, unknown>).date || "")
                : String(parsed.time || parsed.timestamp || "");

        const normalized = normalizeStructuredMessage(parsed);
        if (!normalized) {
            return null;
        }

        const dedupeKey = buildDedupeKey({
            ts,
            level,
            subsystem: normalized.subsystem,
            msg: normalized.msg,
        });
        const uniqueId = `${dedupeKey || ts || Date.now()}-${index ?? logIdCounter++}`;

        return {
            id: uniqueId,
            dedupeKey,
            ts,
            level: level.toLowerCase(),
            subsystem: normalized.subsystem,
            msg: normalized.msg,
            raw: line,
        };
    } catch {
        const extracted = extractSubsystemAndMessage(line);
        const msg = extracted.msg || line;
        const dedupeKey = buildDedupeKey({
            level: undefined,
            subsystem: extracted.subsystem,
            msg,
        });
        const errorId = `${dedupeKey || Date.now()}-${index ?? logIdCounter++}`;
        return {
            id: errorId,
            dedupeKey,
            subsystem: extracted.subsystem,
            msg,
            raw: line,
        };
    }
}

export function formatLogTime(ts?: string): string {
    if (!ts) return "";
    try {
        return formatOsloTime(new Date(ts));
    } catch {
        return ts;
    }
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
            return "text-primary-400 bg-primary-500/20";
        }
        case "trace": {
            return "text-primary-500 bg-primary-500/10";
        }
        default: {
            return "text-primary-400 bg-primary-500/20";
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
