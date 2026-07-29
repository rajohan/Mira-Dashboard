import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    ftruncateSync,
    openSync,
    writeSync,
} from "node:fs";
import path from "node:path";

import { currentLogContext } from "./logContext.ts";
import { hasLineBreakOrNullByte } from "./values.ts";

export type LogLevel = "debug" | "error" | "info" | "warn";
export type StructuredLogFields = Record<string, unknown>;
export type StructuredLogListener = (line: string) => void;

export interface StructuredLogger {
    debug: (event: string, fields?: StructuredLogFields) => void;
    error: (event: string, fields?: StructuredLogFields) => void;
    info: (event: string, fields?: StructuredLogFields) => void;
    warn: (event: string, fields?: StructuredLogFields) => void;
}

const MAX_LOG_DEPTH = 5;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_OBJECT_KEYS = 100;
const MAX_LOG_STRING_LENGTH = 8192;
const MAX_DEVELOPMENT_APP_LOG_BYTES = 16 * 1024 * 1024;
const REDACTED = "[REDACTED]";
const TRUNCATED_SUFFIX = "…[Truncated]";
const sensitiveKeys = new Set([
    "accesstoken",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "gatewaytoken",
    "idtoken",
    "passphrase",
    "password",
    "privatekey",
    "recoverycode",
    "refreshtoken",
    "secret",
    "sessioncookie",
    "totpsecret",
]);
const sensitiveKeyFragments = [
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "passphrase",
    "password",
    "privatekey",
    "recoverycode",
    "secret",
    "token",
    "totp",
];

interface AppLogFile {
    bytes: number;
    descriptor: number;
    path: string;
}

const appLogState: {
    disabledPath?: string;
    file?: AppLogFile;
} = {};
const structuredLogListeners = new Set<StructuredLogListener>();
const structuredLogTestState = {
    isTestRuntime: process.env.NODE_ENV === "test",
    outputSubscriptions: 0,
};

function normalizedKey(key: string): string {
    return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
    const normalized = normalizedKey(key);
    return (
        sensitiveKeys.has(normalized) ||
        sensitiveKeyFragments.some((fragment) => normalized.includes(fragment))
    );
}

function redactString(value: string): string {
    const redacted = value
        .replaceAll(
            /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu,
            (_match, scheme: string) => `${scheme} ${REDACTED}`
        )
        .replaceAll(
            /(\b(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|id[_-]?token|passphrase|password|private[_-]?key|recovery[_-]?code|refresh[_-]?token|secret|session[_-]?cookie|token|totp[_-]?secret)=)[^&\s]+/giu,
            (_match, prefix: string) => `${prefix}${REDACTED}`
        );
    return redacted.length <= MAX_LOG_STRING_LENGTH
        ? redacted
        : `${redacted.slice(
              0,
              MAX_LOG_STRING_LENGTH - TRUNCATED_SUFFIX.length
          )}${TRUNCATED_SUFFIX}`;
}

function sanitizeLogValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return redactString(value);
    if (
        value === undefined ||
        value === null ||
        typeof value === "boolean" ||
        typeof value === "number"
    ) {
        return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol" || typeof value === "function") {
        return String(value);
    }
    if (depth >= MAX_LOG_DEPTH) return "[Truncated]";
    if (value instanceof Error) {
        const code: unknown = Reflect.get(value, "code");
        const statusCode: unknown = Reflect.get(value, "statusCode");
        return {
            ...(typeof code === "string" && { code }),
            message: redactString(value.message),
            name: value.name,
            ...(typeof statusCode === "number" && { statusCode }),
        };
    }
    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_LOG_ARRAY_ITEMS)
            .map((entry) => sanitizeLogValue(entry, depth + 1, seen));
    }
    if (typeof value !== "object") return "[Unsupported]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, MAX_LOG_OBJECT_KEYS)
                .map(([key, entry]) => [
                    key,
                    isSensitiveKey(key)
                        ? REDACTED
                        : sanitizeLogValue(entry, depth + 1, seen),
                ])
        );
    } finally {
        seen.delete(value);
    }
}

/**
 * Redacts structured fields without retaining caller-owned object references.
 * @returns Redact log fields result.
 */
export function redactLogFields(fields: StructuredLogFields): StructuredLogFields {
    return sanitizeLogValue(fields, 0, new WeakSet()) as StructuredLogFields;
}

function configuredAppLogPath(): string | undefined {
    const configured = process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH?.trim();
    if (!configured) return;
    if (
        !path.isAbsolute(configured) ||
        path.resolve(configured) === path.parse(path.resolve(configured)).root ||
        hasLineBreakOrNullByte(configured)
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_APPLICATION_LOG_PATH must be an absolute non-root path"
        );
    }
    return path.resolve(configured);
}

function closeAppLogFile(): void {
    if (!appLogState.file) return;
    closeSync(appLogState.file.descriptor);
    appLogState.file = undefined;
}

function appLogDescriptor(logPath: string): AppLogFile {
    if (appLogState.file?.path === logPath) return appLogState.file;
    closeAppLogFile();

    const descriptor = openSync(
        logPath,
        constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW,
        0o600
    );
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("Application log must be a single-link regular file");
        }
        fchmodSync(descriptor, 0o600);
        appLogState.file = {
            bytes: stat.size,
            descriptor,
            path: logPath,
        };
        return appLogState.file;
    } catch (error) {
        closeSync(descriptor);
        throw error;
    }
}

function writeAppLog(line: string): void {
    let logPath: string | undefined;
    try {
        logPath = configuredAppLogPath();
        if (!logPath || appLogState.disabledPath === logPath) return;
        const file = appLogDescriptor(logPath);
        const encodedLine = Buffer.from(`${line}\n`, "utf8");
        if (file.bytes + encodedLine.byteLength > MAX_DEVELOPMENT_APP_LOG_BYTES) {
            ftruncateSync(file.descriptor, 0);
            file.bytes = 0;
        }
        writeSync(file.descriptor, encodedLine);
        file.bytes += encodedLine.byteLength;
    } catch {
        closeAppLogFile();
        if (!logPath || appLogState.disabledPath === logPath) return;
        appLogState.disabledPath = logPath;
        process.stderr.write(
            `${JSON.stringify({
                event: "structured_log.application_file_disabled",
                level: "error",
                pid: process.pid,
                service: "mira-dashboard",
                timestamp: new Date().toISOString(),
            })}\n`
        );
    }
}

function writeLine(level: LogLevel, line: string): void {
    if (
        !structuredLogTestState.isTestRuntime ||
        structuredLogTestState.outputSubscriptions > 0
    ) {
        const stream =
            level === "error" || level === "warn" ? process.stderr : process.stdout;
        stream.write(`${line}\n`);
        writeAppLog(line);
    }
    for (const listener of structuredLogListeners) {
        try {
            listener(line);
        } catch {
            // Log listeners must never interrupt or recursively log the source event.
        }
    }
}

/**
 * Enables real structured-log sinks for a test that explicitly verifies
 * output behavior.
 *
 * @returns A function that restores the default silent test sink.
 */
export function enableStructuredLogOutputForTests(): () => void {
    if (!structuredLogTestState.isTestRuntime) {
        throw new Error("Structured test output can only be enabled in test mode");
    }
    structuredLogTestState.outputSubscriptions += 1;
    let isEnabled = true;
    return () => {
        if (!isEnabled) return;
        isEnabled = false;
        structuredLogTestState.outputSubscriptions -= 1;
    };
}

/**
 * Subscribes to complete structured output after it reaches the configured sinks.
 * @returns Subscribe to structured logs result.
 */
export function subscribeToStructuredLogs(listener: StructuredLogListener): () => void {
    structuredLogListeners.add(listener);
    return () => structuredLogListeners.delete(listener);
}

/** Emits one newline-delimited JSON event with ambient correlation fields. */
export function structuredLog(
    level: LogLevel,
    event: string,
    fields: StructuredLogFields = {}
): void {
    if (structuredLogTestState.isTestRuntime && (level === "debug" || level === "info")) {
        return;
    }
    const payload = {
        ...redactLogFields(fields),
        ...currentLogContext(),
        event,
        level,
        pid: process.pid,
        service: "mira-dashboard",
        timestamp: new Date().toISOString(),
    };
    writeLine(level, JSON.stringify(payload));
}

export function logError(event: string, fields: StructuredLogFields = {}): void {
    structuredLog("error", event, fields);
}

/**
 * Creates a component-scoped structured logger without mutating global output APIs.
 * @param component Component value.
 * @returns Created a component-scoped structured logger without mutating global output APIs.
 */
export function createStructuredLogger(component: string): StructuredLogger {
    const emit =
        (level: LogLevel) =>
        (event: string, fields: StructuredLogFields = {}): void => {
            structuredLog(level, event, { ...fields, component });
        };
    return {
        debug: emit("debug"),
        error: emit("error"),
        info: emit("info"),
        warn: emit("warn"),
    };
}
