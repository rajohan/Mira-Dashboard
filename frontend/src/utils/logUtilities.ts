import { serializeForDisplay } from "../lib/displayValue";
import { formatOsloTime } from "./format";

/** Frontend projection of one parsed Dashboard or OpenClaw log line. */
export interface LogEntry {
    dedupeKey?: string;
    id: string;
    level?: string;
    lineId?: string;
    msg: string;
    raw: string;
    subsystem?: string;
    ts?: string;
}

/** Defines line options. */
export const LINE_OPTIONS = [100, 500, 1000, 2000, 5000] as const;

/** Defines log levels. */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const logParseState = { logIdCounter: 0 };

/**
 * Performs safe JSON parse.
 * @param value Value to process.
 * @returns Safe JSON parse result.
 */
function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function primitiveLogText(value: unknown, fallback: string): string {
    if (typeof value === "string") {
        return value;
    }
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }
    return fallback;
}

function serializedNonEmptyValue(value: unknown): string | undefined {
    const serialized = serializeForDisplay(value).trim();
    return serialized || undefined;
}

/**
 * Normalizes subsystem candIDate.
 * @param value Value to process.
 * @returns Normalized subsystem candIDate.
 */
function normalizeSubsystemCandidate(value: string): string {
    return value.replace(/^agent\//, "");
}

/**
 * Extracts subsystem and message.
 * @param message Message to process.
 * @returns Extract subsystem and message result.
 */
function extractSubsystemAndMessage(message: string): { subsystem: string; msg: string } {
    const bracketMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(bracketMatch[1]!),
            msg: message.slice(bracketMatch[0].length),
        };
    }

    const colonMatch = message.match(/^([a-z][\w/-]*):\s*/i);
    if (colonMatch) {
        return {
            subsystem: normalizeSubsystemCandidate(colonMatch[1]!),
            msg: message.slice(colonMatch[0].length),
        };
    }

    return { subsystem: "", msg: message };
}

/**
 * Normalizes structured message.
 * @returns Normalized structured message.
 */
function normalizeStructuredMessage(parsed: Record<string, unknown>): {
    msg: string;
    subsystem: string;
} {
    const positionalZero = parsed[0] ?? parsed["0"];
    const positionalOne = parsed[1] ?? parsed["1"];
    const positionalTwo = parsed[2] ?? parsed["2"];

    let subsystem = "";
    for (const candidate of [parsed.component, parsed.subsystem, parsed.module]) {
        if (typeof candidate === "string") {
            subsystem = candidate;
            break;
        }
    }
    let message = "";

    if (typeof positionalZero === "string") {
        const trimmed = positionalZero.trim();

        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            const nested = safeJsonParse(trimmed);
            if (isRecord(nested)) {
                const nestedRecord = nested;
                if (typeof nestedRecord.subsystem === "string") {
                    subsystem = nestedRecord.subsystem;
                } else if (typeof nestedRecord.module === "string") {
                    subsystem = nestedRecord.module;
                } else {
                    subsystem = "";
                }

                const nestedMessage =
                    nestedRecord.msg ??
                    nestedRecord.message ??
                    nestedRecord[0] ??
                    nestedRecord["0"];
                if (typeof nestedMessage === "string" && nestedMessage.trim()) {
                    message = nestedMessage;
                } else if (nestedMessage !== undefined) {
                    message = serializedNonEmptyValue(nestedMessage) ?? "";
                } else if (!subsystem) {
                    message = positionalZero;
                }
            } else {
                message = positionalZero;
            }
        } else {
            message = positionalZero;
        }
    } else if (positionalZero !== undefined) {
        message = serializedNonEmptyValue(positionalZero) ?? "";
    }

    if (!message && typeof positionalOne === "string") {
        message = positionalOne;
    } else if (!message && positionalOne !== undefined) {
        message = serializedNonEmptyValue(positionalOne) ?? "";
    }

    if (!message && typeof positionalTwo === "string") {
        message = positionalTwo;
    }

    if (!message) {
        const fallback = parsed.msg ?? parsed.message;
        if (typeof fallback === "string") {
            message = fallback;
        } else if (fallback !== undefined) {
            message = serializeForDisplay(fallback);
        }
    }

    if (!message && typeof parsed.event === "string" && parsed.event.trim()) {
        const details = Object.fromEntries(
            Object.entries(parsed).filter(
                ([key]) =>
                    ![
                        "component",
                        "event",
                        "level",
                        "lvl",
                        "pid",
                        "service",
                        "time",
                        "timestamp",
                    ].includes(key)
            )
        );
        message =
            Object.keys(details).length === 0
                ? parsed.event
                : `${parsed.event} ${serializeForDisplay(details)}`;
    }

    if (!message.trim()) {
        message = serializeForDisplay(parsed);
    }

    if (!subsystem) {
        const extracted = extractSubsystemAndMessage(message);
        subsystem = extracted.subsystem;
        message = extracted.msg;
    }

    return { subsystem, msg: message };
}

/**
 * Builds dedupe key.
 * @param entry Entry value.
 * @returns Built dedupe key.
 */
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

/**
 * Parses log line.
 * @param line Line value.
 * @param lineId Line identifier.
 * @returns Parsed log line.
 */
export function parseLogLine(
    line: string,
    lineId?: number | string
): LogEntry | undefined {
    if (!line || !line.trim()) return undefined;
    const stableLineId = lineId ?? `fallback:${logParseState.logIdCounter++}`;

    let jsonString = line;

    if (!line.startsWith("{")) {
        const braceIndex = line.indexOf("{");
        if (braceIndex !== -1) {
            jsonString = line.slice(braceIndex);
        }
    }

    try {
        const parsedValue: unknown = JSON.parse(jsonString);
        if (!isRecord(parsedValue)) {
            throw new TypeError("Structured log payload must be an object");
        }
        const parsed = parsedValue;
        const meta = isRecord(parsed._meta) ? parsed._meta : undefined;
        const levelSource =
            meta && "logLevelName" in meta
                ? meta.logLevelName
                : parsed.level || parsed.lvl;
        const timestampSource =
            meta && "date" in meta ? meta.date : parsed.time || parsed.timestamp;
        const level = primitiveLogText(levelSource, "INFO");
        const ts = primitiveLogText(timestampSource, "");

        const normalized = normalizeStructuredMessage(parsed);

        const dedupeKey = buildDedupeKey({
            ts,
            level,
            subsystem: normalized.subsystem,
            msg: normalized.msg,
        });
        const uniqueId = `${dedupeKey}-${stableLineId}`;

        return {
            id: uniqueId,
            dedupeKey,
            lineId: String(stableLineId),
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
        const errorId = `${dedupeKey}-${stableLineId}`;
        return {
            id: errorId,
            dedupeKey,
            lineId: String(stableLineId),
            subsystem: extracted.subsystem,
            msg: message,
            raw: line,
        };
    }
}

/**
 * Formats log time for display.
 * @param ts Ts value.
 * @returns Formatted log time for display.
 */
export function formatLogTime(ts?: string): string {
    if (!ts) return "";
    try {
        return formatOsloTime(new Date(ts));
    } catch {
        return ts;
    }
}

/**
 * Returns level color.
 * @param level Level value.
 * @returns level color.
 */
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

/**
 * Returns subsystem color.
 * @param subsystem Subsystem value.
 * @returns subsystem color.
 */
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
