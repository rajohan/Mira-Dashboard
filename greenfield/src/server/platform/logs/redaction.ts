import { logLineMaximumCharacters, type LogLine } from "../../../contracts/logs.ts";

const redacted = "[REDACTED]";
const redactionInputMaximumCharacters = logLineMaximumCharacters * 4;
const secretName =
    "(?:api[_-]?key|authorization|cookie|credential|passwd|password|secret|set-cookie|token)";
const assignmentPattern = new RegExp(
    String.raw`(${secretName}["']?\s*[:=]\s*["']?)([^\s"',;}]*)`,
    "giu"
);
const queryPattern = new RegExp(`([?&]${secretName}=)[^&#\\s]*`, "giu");
const bearerPattern = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const urlUserInfoPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const recognizedTokenPatterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;

const severityPattern =
    /(?:^|[\s[{,(])["']?(?:level["']?\s*[:=]\s*["']?)?(trace|debug|info|warn(?:ing)?|error|fatal)(?:["']|\b)/iu;
const isoTimestampPattern =
    /(?:^|["'](?:time|timestamp|ts)["']?\s*:\s*["'])(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)/u;

/**
 * Redacts recognized credential material before any log text crosses the server boundary.
 * @param value One untrusted physical log line.
 * @returns Bounded text with recognized credential material removed.
 */
export function redactLogLine(value: string): string {
    let output = value
        .slice(0, redactionInputMaximumCharacters)
        .replaceAll("\0", "�")
        .replace(urlUserInfoPattern, `$1${redacted}@`)
        .replace(queryPattern, `$1${redacted}`)
        .replace(bearerPattern, `$1 ${redacted}`)
        .replace(assignmentPattern, `$1${redacted}`);
    for (const pattern of recognizedTokenPatterns)
        output = output.replace(pattern, redacted);
    if (output.length > logLineMaximumCharacters) {
        return `${output.slice(0, logLineMaximumCharacters - 14)}… [truncated]`;
    }
    return output;
}

/**
 * Classifies only an allowlisted severity label from already-redacted text.
 * @param line One already-redacted line.
 * @returns An allowlisted severity or unknown.
 */
export function classifyLogSeverity(line: string): LogLine["severity"] {
    const match = severityPattern.exec(line)?.[1]?.toLowerCase();
    if (match === "warning") return "warn";
    if (
        match === "trace" ||
        match === "debug" ||
        match === "info" ||
        match === "warn" ||
        match === "error" ||
        match === "fatal"
    ) {
        return match;
    }
    return "unknown";
}

/**
 * Parses one explicit UTC timestamp without retaining arbitrary structured fields.
 * @param line One already-redacted line.
 * @returns UTC epoch milliseconds when an explicit timestamp is present.
 */
export function parseLogTimestamp(line: string): number | undefined {
    const text = isoTimestampPattern.exec(line)?.[1];
    if (text === undefined) return undefined;
    const timestamp = Date.parse(text);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}
