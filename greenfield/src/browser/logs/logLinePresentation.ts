import { TZDate } from "@date-fns/tz";
import { isValid, parse as parseDate, setYear } from "date-fns";

import { logLineMaximumCharacters, type LogLine } from "../../contracts/logs.ts";

const detailFieldMaximum = 8;
const dashboardHostTimeZone = "Europe/Oslo";
const maximumDateTimestamp = 8_640_000_000_000_000;
const nestedCollectionItemMaximum = 6;
const nestedDepthMaximum = 3;
const sourceMaximumCharacters = 80;
const structuredMessageMaximumCharacters = 1200;
const structuredValueMaximumCharacters = 240;

const syslogFacilityNames = [
    "kern",
    "user",
    "mail",
    "daemon",
    "auth",
    "syslog",
    "lpr",
    "news",
    "uucp",
    "cron",
    "authpriv",
    "ftp",
] as const;

const detailMetadataKeys = new Set([
    "0",
    "1",
    "2",
    "_meta",
    "component",
    "event",
    "level",
    "lvl",
    "message",
    "module",
    "msg",
    "name",
    "namespace",
    "pid",
    "service",
    "source",
    "subsystem",
    "time",
    "timestamp",
    "ts",
]);

type LogSeverity = LogLine["severity"];
type StructuredRecord = Record<string, unknown>;

interface BoundedText {
    readonly text: string;
    readonly truncated: boolean;
}

export interface StructuredLogDetail {
    readonly key: string;
    readonly value: string;
}

export interface RedactedLogLinePresentation {
    readonly details: readonly StructuredLogDetail[];
    readonly detailsTruncated: boolean;
    readonly facility?: string;
    readonly kind: "raw" | "structured";
    readonly level: LogSeverity;
    readonly message: string;
    readonly omittedFieldCount: number;
    readonly raw: string;
    readonly source?: string;
    readonly timestampMs?: number;
}

export interface RedactedLogLinePresentationContext {
    /** Snapshot time used to resolve year-less syslog timestamps. */
    readonly referenceTimestampMs?: number;
    /** Path-free contract source used only as a trustworthy source-label fallback. */
    readonly sourceId?: string;
}

interface TextLogEnvelope {
    readonly facility?: string;
    readonly level?: LogSeverity;
    readonly message: string;
    readonly source?: string;
    readonly timestampMs?: number;
}

function isRecord(value: unknown): value is StructuredRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: string, maximum: number): BoundedText {
    if (value.length <= maximum) return { text: value, truncated: false };
    return {
        text: `${value.slice(0, Math.max(0, maximum - 1))}…`,
        truncated: true,
    };
}

function replaceControlCharacters(
    value: string,
    replacement: string,
    preserveWhitespace: boolean
): string {
    let output = "";
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        const isControl =
            codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
        const isPreservedWhitespace =
            preserveWhitespace &&
            (codePoint === 9 || codePoint === 10 || codePoint === 13);
        output += isControl && !isPreservedWhitespace ? replacement : character;
    }
    return output;
}

function safeDisplayText(value: string): string {
    return replaceControlCharacters(value, "�", true);
}

function compactLabel(value: string): string {
    return replaceControlCharacters(value, " ", false).replaceAll(/\s+/gu, " ").trim();
}

function parseRecord(value: string): StructuredRecord | undefined {
    if (value.length > logLineMaximumCharacters) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function structuredRecordFromLine(line: string): StructuredRecord | undefined {
    const objectStart = line.indexOf("{");
    if (objectStart === -1) return undefined;
    return parseRecord(line.slice(objectStart).trim());
}

function embeddedRecord(value: unknown): StructuredRecord | undefined {
    if (isRecord(value)) return value;
    if (typeof value !== "string") return undefined;
    const candidate = value.trim();
    if (!(candidate.startsWith("{") && candidate.endsWith("}"))) return undefined;
    return parseRecord(candidate);
}

function normalizeSeverity(value: unknown): LogSeverity | undefined {
    if (typeof value !== "string") return undefined;
    switch (value.trim().toLowerCase()) {
        case "debug": {
            return "debug";
        }
        case "error": {
            return "error";
        }
        case "fatal": {
            return "fatal";
        }
        case "info": {
            return "info";
        }
        case "trace": {
            return "trace";
        }
        case "warn":
        case "warning": {
            return "warn";
        }
        default: {
            return undefined;
        }
    }
}

function timestampFromValue(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 && value <= maximumDateTimestamp
            ? value
            : undefined;
    }
    if (typeof value !== "string" || value.length > 80) return undefined;
    const timestamp = Date.parse(value);
    return Number.isSafeInteger(timestamp) &&
        timestamp >= 0 &&
        timestamp <= maximumDateTimestamp
        ? timestamp
        : undefined;
}

function sourceHintFromId(sourceId: string | undefined): string | undefined {
    if (sourceId === undefined) return undefined;
    const fixedHints: Readonly<Record<string, string>> = {
        "host.alternatives": "alternatives",
        "host.apport": "apport",
        "host.auth": "auth",
        "host.dpkg": "dpkg",
        "host.kern": "kernel",
        "host.syslog": "system",
    };
    const fixed = fixedHints[sourceId];
    if (fixed !== undefined) return fixed;
    if (sourceId.startsWith("dashboard.web.")) return "web";
    if (sourceId.startsWith("dashboard.worker.")) return "worker";
    if (sourceId.startsWith("openclaw.")) return "openclaw";
    return undefined;
}

function normalizeSource(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const compact = compactLabel(value).replace(/^agent\//u, "");
    if (compact.length === 0) return undefined;
    return boundedText(compact, sourceMaximumCharacters).text;
}

function sourceFromRecord(
    record: StructuredRecord,
    metadata?: StructuredRecord
): string | undefined {
    const candidates = [
        record.component,
        record.subsystem,
        record.module,
        record.namespace,
        record.service,
        record.source,
        metadata?.component,
        metadata?.subsystem,
        metadata?.module,
        metadata?.namespace,
    ];
    for (const candidate of candidates) {
        const source = normalizeSource(candidate);
        if (source !== undefined) return source;
    }
    return undefined;
}

function boundedStructuredValue(value: unknown, depth = 0): BoundedText {
    if (typeof value === "string") {
        return boundedText(safeDisplayText(value), structuredValueMaximumCharacters);
    }
    if (value === null) return { text: "null", truncated: false };
    if (typeof value === "number" || typeof value === "boolean") {
        return { text: String(value), truncated: false };
    }
    if (depth >= nestedDepthMaximum) {
        return {
            text: Array.isArray(value) ? "[…]" : "{…}",
            truncated: true,
        };
    }
    if (Array.isArray(value)) {
        const visible = value
            .slice(0, nestedCollectionItemMaximum)
            .map((item) => boundedStructuredValue(item, depth + 1));
        const omitted = value.length - visible.length;
        const rendered = `[${visible.map(({ text }) => text).join(", ")}${
            omitted > 0 ? `, … +${omitted}` : ""
        }]`;
        const bounded = boundedText(rendered, structuredValueMaximumCharacters);
        return {
            text: bounded.text,
            truncated:
                bounded.truncated ||
                omitted > 0 ||
                visible.some(({ truncated }) => truncated),
        };
    }
    if (isRecord(value)) {
        const entries = Object.entries(value);
        const visible = entries
            .slice(0, nestedCollectionItemMaximum)
            .map(([key, child]) => {
                const rendered = boundedStructuredValue(child, depth + 1);
                return {
                    text: `${boundedText(compactLabel(key), 48).text}: ${rendered.text}`,
                    truncated: rendered.truncated,
                };
            });
        const omitted = entries.length - visible.length;
        const rendered = `{${visible.map(({ text }) => text).join(", ")}${
            omitted > 0 ? `, … +${omitted}` : ""
        }}`;
        const bounded = boundedText(rendered, structuredValueMaximumCharacters);
        return {
            text: bounded.text,
            truncated:
                bounded.truncated ||
                omitted > 0 ||
                visible.some(({ truncated }) => truncated),
        };
    }
    return { text: "[unsupported value]", truncated: true };
}

function messageCandidate(value: unknown): BoundedText | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") {
        const message = safeDisplayText(value).trim();
        return message.length === 0
            ? undefined
            : boundedText(message, structuredMessageMaximumCharacters);
    }
    const rendered = boundedStructuredValue(value);
    if (rendered.text.length === 0) return undefined;
    const bounded = boundedText(rendered.text, structuredMessageMaximumCharacters);
    return {
        text: bounded.text,
        truncated: rendered.truncated || bounded.truncated,
    };
}

function messageFromRecord(record: StructuredRecord): BoundedText | undefined {
    const candidates = [
        record["0"],
        record["1"],
        record["2"],
        record.msg,
        record.message,
        record.event,
    ];
    for (const candidate of candidates) {
        const message = messageCandidate(candidate);
        if (message !== undefined) return message;
    }
    return undefined;
}

function messageFromStructuredRecord(
    record: StructuredRecord,
    positionalRecord?: StructuredRecord
): BoundedText | undefined {
    if (positionalRecord === undefined) return messageFromRecord(record);
    const nestedMessage = messageFromRecord(positionalRecord);
    if (nestedMessage !== undefined) return nestedMessage;

    // OpenClaw commonly stores a JSON-encoded subsystem descriptor in position 0
    // and the human-readable summary in position 1. Do not present the descriptor
    // itself as the title when a later positional message exists.
    for (const candidate of [
        record["1"],
        record["2"],
        record.msg,
        record.message,
        record.event,
    ]) {
        const message = messageCandidate(candidate);
        if (message !== undefined) return message;
    }
    return undefined;
}

function sourcePrefixFromMessage(message: string): {
    readonly message: string;
    readonly source?: string;
} {
    const bracket = /^\[([A-Za-z][^\]\n]{0,79})\]\s*/u.exec(message);
    if (bracket !== null) {
        const source = normalizeSource(bracket[1]);
        return {
            message: message.slice(bracket[0].length),
            ...(source === undefined ? {} : { source }),
        };
    }
    const colon = /^([a-z][\w/-]{0,79}):\s*/iu.exec(message);
    if (colon !== null) {
        const source = normalizeSource(colon[1]);
        return {
            message: message.slice(colon[0].length),
            ...(source === undefined ? {} : { source }),
        };
    }
    return { message };
}

function severityFromPriority(priority: number | undefined): LogSeverity | undefined {
    if (priority === undefined || priority < 0 || priority > 191) return undefined;
    switch (priority % 8) {
        case 0:
        case 1: {
            return "fatal";
        }
        case 2:
        case 3: {
            return "error";
        }
        case 4: {
            return "warn";
        }
        case 5:
        case 6: {
            return "info";
        }
        case 7: {
            return "debug";
        }
        default: {
            return undefined;
        }
    }
}

function facilityFromPriority(priority: number | undefined): string | undefined {
    if (priority === undefined || priority < 0 || priority > 191) return undefined;
    const facility = Math.floor(priority / 8);
    return (
        syslogFacilityNames[facility] ??
        (facility >= 16 && facility <= 23 ? `local${facility - 16}` : undefined)
    );
}

function nearestYearTimestamp(
    value: string,
    referenceTimestampMs: number
): number | undefined {
    const reference = new Date(referenceTimestampMs);
    if (!isValid(reference)) return undefined;
    const fraction = /\.(\d{1,9})$/u.exec(value)?.[1];
    const normalized = value
        .replaceAll(/\s+/gu, " ")
        .replace(
            /\.\d{1,9}$/u,
            fraction === undefined ? "" : `.${fraction.slice(0, 3).padEnd(3, "0")}`
        );
    const parsed = parseDate(
        normalized,
        fraction === undefined ? "MMM d HH:mm:ss" : "MMM d HH:mm:ss.SSS",
        reference
    );
    if (!isValid(parsed)) return undefined;
    const referenceYear = reference.getFullYear();
    const candidates = [referenceYear - 1, referenceYear, referenceYear + 1]
        .map((year) => setYear(parsed, year).getTime())
        .filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0);
    return candidates.toSorted(
        (left, right) =>
            Math.abs(left - referenceTimestampMs) - Math.abs(right - referenceTimestampMs)
    )[0];
}

function textTimestamp(
    value: string,
    referenceTimestampMs: number | undefined
): number | undefined {
    if (/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/u.test(value)) {
        return nearestYearTimestamp(value, referenceTimestampMs ?? Date.now());
    }
    const normalized = value
        .replace(",", ".")
        .replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}|$)/u, "$1");
    const timestamp = Date.parse(normalized);
    return Number.isSafeInteger(timestamp) &&
        timestamp >= 0 &&
        timestamp <= maximumDateTimestamp
        ? timestamp
        : undefined;
}

function hostLocalTimestamp(value: string): number | undefined {
    const match =
        /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?$/u.exec(
            value
        );
    if (match === null) return undefined;
    const timestamp = TZDate.tz(
        dashboardHostTimeZone,
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
        Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"))
    ).getTime();
    return Number.isSafeInteger(timestamp) &&
        timestamp >= 0 &&
        timestamp <= maximumDateTimestamp
        ? timestamp
        : undefined;
}

function processPrefix(
    value: string,
    includesHost: boolean
): Readonly<{ message: string; source?: string }> {
    const hostAndSource = includesHost
        ? /^\S+\s+([A-Za-z0-9_.@/-]{1,80})(?:\[\d+\])?:\s*(.*)$/u.exec(value)
        : undefined;
    if (hostAndSource !== null && hostAndSource !== undefined) {
        return {
            message: hostAndSource[2] ?? "",
            source: normalizeSource(hostAndSource[1]),
        };
    }
    const source = /^([A-Za-z0-9_.@/-]{1,80})(?:\[\d+\])?:\s*(.*)$/u.exec(value);
    if (source !== null) {
        return {
            message: source[2] ?? "",
            source: normalizeSource(source[1]),
        };
    }
    return { message: value };
}

function severityPrefix(value: string): Readonly<{
    level?: LogSeverity;
    message: string;
}> {
    const match =
        /^(?:\[|\()?\s*(trace|debug|info|warn(?:ing)?|error|fatal)\s*(?:\]|\))?(?:\s*[:|-]\s*|\s+)/iu.exec(
            value
        );
    if (match === null) return { message: value };
    return {
        level: normalizeSeverity(match[1]),
        message: value.slice(match[0].length),
    };
}

function textPrefix(
    value: string,
    context: RedactedLogLinePresentationContext
): Pick<TextLogEnvelope, "level" | "message" | "source" | "timestampMs"> {
    if (context.sourceId === "host.apport") {
        const apport =
            /^(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL):\s+apport(?:\s+\(pid\s+\d+\))?\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?):\s*(.*)$/iu.exec(
                value
            );
        if (apport !== null) {
            return {
                level: normalizeSeverity(apport[1]),
                message: apport[3] ?? "",
                source: "apport",
                timestampMs: hostLocalTimestamp(apport[2]!),
            };
        }
    }

    const sourceThenIso =
        /^([A-Za-z0-9_.@/-]{1,80})\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?):\s*(.*)$/u.exec(
            value
        );
    if (sourceThenIso !== null) {
        return {
            message: sourceThenIso[3] ?? "",
            source: normalizeSource(sourceThenIso[1]),
            timestampMs: textTimestamp(sourceThenIso[2]!, context.referenceTimestampMs),
        };
    }

    const monthTimestamp =
        /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)\s+(.*)$/u.exec(
            value
        );
    if (monthTimestamp !== null) {
        const prefixed = processPrefix(monthTimestamp[2] ?? "", true);
        return {
            ...prefixed,
            timestampMs: textTimestamp(monthTimestamp[1]!, context.referenceTimestampMs),
        };
    }

    const isoTimestamp =
        /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/u.exec(
            value
        );
    if (isoTimestamp !== null) {
        const prefixed = processPrefix(isoTimestamp[2] ?? "", true);
        return {
            ...prefixed,
            timestampMs: textTimestamp(isoTimestamp[1]!, context.referenceTimestampMs),
        };
    }

    return processPrefix(value, false);
}

function presentTextEnvelope(
    raw: string,
    context: RedactedLogLinePresentationContext
): TextLogEnvelope {
    let value = raw;
    let priority: number | undefined;
    const priorityMatch = /^<(\d{1,3})>/u.exec(value);
    if (priorityMatch !== null) {
        const candidate = Number(priorityMatch[1]);
        if (Number.isSafeInteger(candidate) && candidate <= 191) {
            priority = candidate;
            value = value.slice(priorityMatch[0].length);
        }
    }

    const prefix = textPrefix(value, context);

    const severity = severityPrefix(prefix.message);
    const sourcePrefix = sourcePrefixFromMessage(severity.message);
    return {
        facility: facilityFromPriority(priority),
        level: prefix.level ?? severity.level ?? severityFromPriority(priority),
        message: sourcePrefix.message,
        source:
            prefix.source ?? sourcePrefix.source ?? sourceHintFromId(context.sourceId),
        timestampMs: prefix.timestampMs,
    };
}

function structuredDetails(records: readonly StructuredRecord[]): Readonly<{
    details: readonly StructuredLogDetail[];
    omittedFieldCount: number;
    truncated: boolean;
}> {
    const candidates: Array<readonly [string, unknown]> = [];
    const seenKeys = new Set<string>();
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
            if (detailMetadataKeys.has(key) || seenKeys.has(key)) continue;
            seenKeys.add(key);
            candidates.push([key, value]);
        }
    }
    const details = candidates.slice(0, detailFieldMaximum).map(([key, value]) => {
        const rendered = boundedStructuredValue(value);
        return {
            detail: {
                key: boundedText(compactLabel(key), 64).text,
                value: rendered.text,
            },
            truncated: rendered.truncated,
        };
    });
    return {
        details: details.map(({ detail }) => detail),
        omittedFieldCount: candidates.length - details.length,
        truncated: details.some(({ truncated }) => truncated),
    };
}

/**
 * Projects one already-redacted, contract-bounded log line for inert browser display.
 * Structured values are deliberately shallow and capped; the raw redacted line remains
 * available to the renderer when presentation fields are shortened or omitted.
 * @param entry Server-redacted log line.
 * @returns Bounded structured metadata or a clear raw-text fallback.
 */
export function presentRedactedLogLine(
    entry: LogLine,
    context: RedactedLogLinePresentationContext = {}
): RedactedLogLinePresentation {
    const raw = boundedText(entry.line, logLineMaximumCharacters).text;
    const textEnvelope = presentTextEnvelope(raw, context);
    const record = structuredRecordFromLine(raw);
    if (record === undefined) {
        const timestampMs = entry.timestampMs ?? textEnvelope.timestampMs;
        return {
            details: [],
            detailsTruncated: false,
            ...(textEnvelope.facility === undefined
                ? {}
                : { facility: textEnvelope.facility }),
            kind: "raw",
            level: textEnvelope.level ?? entry.severity,
            message: textEnvelope.message,
            omittedFieldCount: 0,
            raw,
            ...(textEnvelope.source === undefined ? {} : { source: textEnvelope.source }),
            ...(timestampMs === undefined ? {} : { timestampMs }),
        };
    }

    const metadata = isRecord(record._meta) ? record._meta : undefined;
    const embedded = embeddedRecord(record["0"]);
    const metadataName = embeddedRecord(metadata?.name);
    const messageRecord = embedded ?? record;
    const messageValue = messageFromStructuredRecord(record, embedded);
    const prefixed = sourcePrefixFromMessage(
        messageValue?.text ?? "Structured log entry"
    );
    const source =
        sourceFromRecord(messageRecord, metadata) ??
        sourceFromRecord(record, metadata) ??
        (metadataName === undefined
            ? normalizeSource(metadata?.name)
            : sourceFromRecord(metadataName)) ??
        prefixed.source ??
        textEnvelope.source;
    const level =
        normalizeSeverity(metadata?.logLevelName) ??
        normalizeSeverity(record.level) ??
        normalizeSeverity(record.lvl) ??
        textEnvelope.level ??
        entry.severity;
    const timestampMs =
        entry.timestampMs ??
        timestampFromValue(metadata?.date) ??
        timestampFromValue(record.time) ??
        timestampFromValue(record.timestamp) ??
        timestampFromValue(record.ts) ??
        textEnvelope.timestampMs;
    const details = structuredDetails(
        embedded === undefined ? [record] : [record, embedded]
    );

    return {
        details: details.details,
        detailsTruncated: details.truncated || (messageValue?.truncated ?? false),
        ...(textEnvelope.facility === undefined
            ? {}
            : { facility: textEnvelope.facility }),
        kind: "structured",
        level,
        message: prefixed.message,
        omittedFieldCount: details.omittedFieldCount,
        raw,
        ...(source === undefined ? {} : { source }),
        ...(timestampMs === undefined ? {} : { timestampMs }),
    };
}
