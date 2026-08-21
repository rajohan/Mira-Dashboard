import { dockerContainerLogLineMaximumCharacters } from "../../contracts/docker.ts";

const redacted = "[REDACTED]";
const redactionInputMaximumCharacters = dockerContainerLogLineMaximumCharacters * 4;
const secretName =
    "(?:api[_-]?key|authorization|credentials?|passwd|password|secret|set-cookie|cookie|token)";
const assignmentPrefixPattern = new RegExp(
    String.raw`(?:["']?)(${secretName})(?:["']?)\s*[:=]\s*`,
    "giu"
);
const sensitiveHeaderPattern =
    /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu;
const queryPattern = new RegExp(`([?&]${secretName}=)[^&#\\s]*`, "giu");
const bearerPattern = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu;
const urlUserInfoPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu;
const recognizedTokenPatterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
    /\bglpat-[A-Za-z0-9_-]{12,}\b/gu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;

function quotedValueEnd(value: string, start: number, quote: string): number {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
        const character = value[index]!;
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character === quote) return index + 1;
    }
    return value.length;
}

function structuredValueEnd(value: string, start: number): number {
    const opening = value[start];
    const stack = [opening === "[" ? "]" : "}"];
    let quote: string | undefined;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
        const character = value[index]!;
        if (quote !== undefined) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "[") stack.push("]");
        else if (character === "{") stack.push("}");
        else if (character === stack.at(-1)) {
            stack.pop();
            if (stack.length === 0) return index + 1;
        }
    }
    return value.length;
}

function isSafeValueDelimiter(character: string): boolean {
    return /[\r\n,;}&\]]/u.test(character);
}

function malformedValueSuffixEnd(value: string, start: number): number {
    const stack: string[] = [];
    let quote: string | undefined;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index]!;
        if (quote !== undefined) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "[") stack.push("]");
        else if (character === "{") stack.push("}");
        else if (character === stack.at(-1)) stack.pop();
        else if (stack.length === 0 && isSafeValueDelimiter(character)) return index;
    }
    return value.length;
}

function failClosedValueEnd(value: string, end: number): number {
    let next = end;
    while (next < value.length && /[\t ]/u.test(value[next]!)) next += 1;
    if (next === value.length || isSafeValueDelimiter(value[next]!)) return end;
    return malformedValueSuffixEnd(value, end);
}

function consumesCompleteUnquotedValue(secret: string): boolean {
    const normalized = secret.toLowerCase().replaceAll(/[_-]/gu, "");
    return (
        normalized === "authorization" ||
        normalized === "proxyauthorization" ||
        normalized === "cookie" ||
        normalized === "setcookie"
    );
}

function sensitiveValueEnd(value: string, start: number, secret: string): number {
    const opening = value[start];
    if (opening === '"' || opening === "'") {
        return failClosedValueEnd(value, quotedValueEnd(value, start, opening));
    }
    if (opening === "[" || opening === "{") {
        return failClosedValueEnd(value, structuredValueEnd(value, start));
    }
    if (consumesCompleteUnquotedValue(secret)) return value.length;
    let index = start;
    while (index < value.length && !isSafeValueDelimiter(value[index]!)) index += 1;
    return index;
}

function redactAssignments(value: string): string {
    assignmentPrefixPattern.lastIndex = 0;
    let cursor = 0;
    let output = "";
    let match: RegExpExecArray | null;
    while ((match = assignmentPrefixPattern.exec(value)) !== null) {
        if (match.index < cursor) continue;
        const valueStart = assignmentPrefixPattern.lastIndex;
        output += value.slice(cursor, valueStart);
        output += redacted;
        cursor = sensitiveValueEnd(value, valueStart, match[1]!);
        assignmentPrefixPattern.lastIndex = cursor;
    }
    return `${output}${value.slice(cursor)}`;
}

function normalizeControlCharacters(value: string): string {
    return value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
        character === "\t" ? "\t" : "�"
    );
}

/**
 * Redacts recognized credentials and terminal control text from one untrusted
 * container-log line before it crosses the worker boundary.
 * @param value One physical Docker log line.
 * @returns One bounded display-safe line.
 */
export function redactDockerLogLine(value: string): string {
    let output = redactAssignments(
        normalizeControlCharacters(value.slice(0, redactionInputMaximumCharacters))
            .replace(urlUserInfoPattern, `$1${redacted}@`)
            .replace(queryPattern, `$1${redacted}`)
            .replace(bearerPattern, `$1 ${redacted}`)
            .replace(sensitiveHeaderPattern, `$1${redacted}`)
    );
    for (const pattern of recognizedTokenPatterns) {
        output = output.replace(pattern, redacted);
    }
    if (output.length > dockerContainerLogLineMaximumCharacters) {
        return `${output.slice(0, dockerContainerLogLineMaximumCharacters - 14)}… [truncated]`;
    }
    return output;
}
