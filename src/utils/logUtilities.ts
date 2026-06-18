import type { LogEntry } from "../types/log";
import { formatOsloTime } from "./format";

/** Defines line options. */
export const LINE_OPTIONS = [100, 500, 1000, 2000, 5000] as const;

/** Defines log levels. */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

let logIdCounter = 0;

/** Performs safe JSON parse. */
function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

/** Performs stringify compact. */
function stringifyCompact(value: unknown): string {
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === "string" ? serialized : String(value);
    } catch {
        return String(value);
    }
}

/** Normalizes subsystem candIDate. */
function normalizeSubsystemCandidate(value: string): string {
    return value.replace(/^agent\//, "");
}

/** Extracts subsystem and message. */
function extractSubsystemAndMessage(message: string): { subsystem: string; msg: string } {
    const bracketMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(bracketMatch[1]!),
            msg: message.slice(bracketMatch[0].length),
        };
    }

    const colonMatch = message.match(/^([a-zA-Z][\w/-]*):\s*/);
    if (colonMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(colonMatch[1]!),
            msg: message.slice(colonMatch[0].length),
        };
    }

    return { subsystem: "", msg: message };
}

/** Normalizes structured message. */
function normalizeStructuredMessage(parsed: Record<string, unknown>): {
    msg: string;
    subsystem: string;
} {
    const positionalZero = parsed[0] ?? parsed["0"];
    const positionalOne = parsed[1] ?? parsed["1"];
    const positionalTwo = parsed[2] ?? parsed["2"];

    let subsystem = "";
    let message = "";

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
                    message = nestedMessage;
                } else if (nestedMessage != undefined && String(nestedMessage).trim()) {
                    message = stringifyCompact(nestedMessage);
                } else if (!subsystem) {
                    message = positionalZero;
                }
            } else {
                message = positionalZero;
            }
        } else {
            message = positionalZero;
        }
    } else if (positionalZero != undefined && String(positionalZero) !== "") {
        message = stringifyCompact(positionalZero);
    }

    if (!message && typeof positionalOne === "string") {
        message = positionalOne;
    } else if (!message && positionalOne != undefined && String(positionalOne) !== "") {
        message = stringifyCompact(positionalOne);
    }

    if (!message && typeof positionalTwo === "string") {
        message = positionalTwo;
    }

    if (!message) {
        const fallback = parsed.msg ?? parsed.message;
        if (typeof fallback === "string") {
            message = fallback;
        } else if (fallback != undefined) {
            message = stringifyCompact(fallback);
        }
    }

    if (!message.trim()) {
        message = stringifyCompact(parsed);
    }

    if (!subsystem) {
        const extracted = extractSubsystemAndMessage(message);
        subsystem = extracted.subsystem;
        message = extracted.msg;
    }

    return { subsystem, msg: message };
}

/** Builds dedupe key. */
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

/** Parses log line. */
export function parseLogLine(line: string, index?: number): LogEntry | undefined {
    if (!line || !line.trim()) return undefined;

    let jsonString = line;

    if (!line.startsWith("{")) {
        const braceIndex = line.indexOf("{");
        if (braceIndex !== -1) {
            jsonString = line.slice(braceIndex);
        }
    }

    try {
        const parsed = JSON.parse(jsonString) as Record<string, unknown>;
        const meta = typeof parsed._meta === "object" ? parsed._meta : undefined;
        const levelSource =
            meta && "logLevelName" in meta
                ? (meta as Record<string, unknown>).logLevelName
                : parsed.level || parsed.lvl;
        const timestampSource =
            meta && "date" in meta
                ? (meta as Record<string, unknown>).date
                : parsed.time || parsed.timestamp;
        const level = String(levelSource || "INFO");
        const ts = String(timestampSource || "");

        const normalized = normalizeStructuredMessage(parsed);

        const dedupeKey = buildDedupeKey({
            ts,
            level,
            subsystem: normalized.subsystem,
            msg: normalized.msg,
        });
        const uniqueId = `${dedupeKey}-${index ?? logIdCounter++}`;

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
        const message = extracted.msg || line;
        const dedupeKey = buildDedupeKey({
            level: undefined,
            subsystem: extracted.subsystem,
            msg: message,
        });
        const errorId = `${dedupeKey}-${index ?? logIdCounter++}`;
        return {
            id: errorId,
            dedupeKey,
            subsystem: extracted.subsystem,
            msg: message,
            raw: line,
        };
    }
}

/** Formats log time for display. */
export function formatLogTime(ts?: string): string {
    if (!ts) return "";
    try {
        return formatOsloTime(new Date(ts));
    } catch {
        return ts;
    }
}

/** Returns level color. */
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

/** Returns subsystem color. */
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
