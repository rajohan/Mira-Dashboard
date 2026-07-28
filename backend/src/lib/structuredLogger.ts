import { currentLogContext } from "./logContext.ts";

export type LogLevel = "debug" | "error" | "info" | "warn";
export type StructuredLogFields = Record<string, unknown>;

const MAX_LOG_DEPTH = 5;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_OBJECT_KEYS = 100;
const MAX_LOG_STRING_LENGTH = 8192;
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
const nativeConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
};
const structuredConsoleState: {
    installed: boolean;
} = {
    installed: false,
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
        const code = Reflect.get(value, "code");
        const statusCode = Reflect.get(value, "statusCode");
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
    if (typeof value !== "object") return String(value);
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

/** Redacts structured fields without retaining caller-owned object references. */
export function redactLogFields(fields: StructuredLogFields): StructuredLogFields {
    return sanitizeLogValue(fields, 0, new WeakSet()) as StructuredLogFields;
}

function writeLine(level: LogLevel, line: string): void {
    if (!structuredConsoleState.installed) {
        switch (level) {
            case "debug": {
                console.debug(line);
                break;
            }
            case "error": {
                console.error(line);
                break;
            }
            case "warn": {
                console.warn(line);
                break;
            }
            default: {
                console.info(line);
            }
        }
        return;
    }
    switch (level) {
        case "debug": {
            nativeConsole.debug(line);
            break;
        }
        case "error": {
            nativeConsole.error(line);
            break;
        }
        case "warn": {
            nativeConsole.warn(line);
            break;
        }
        default: {
            nativeConsole.info(line);
        }
    }
}

/** Emits one newline-delimited JSON event with ambient correlation fields. */
export function structuredLog(
    level: LogLevel,
    event: string,
    fields: StructuredLogFields = {}
): void {
    if (process.env.NODE_ENV === "test" && (level === "debug" || level === "info")) {
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

function legacyConsoleEvent(arguments_: unknown[]): StructuredLogFields {
    const [first, ...rest] = arguments_;
    return typeof first === "string"
        ? { arguments: rest, message: first }
        : { arguments: arguments_ };
}

/**
 * Converts existing console calls to redacted JSON while routes and services
 * migrate to explicit event names. Tests retain native console spies.
 */
export function installStructuredConsole(
    environment: Record<string, string | undefined> = process.env
): () => void {
    if (structuredConsoleState.installed || environment.NODE_ENV === "test") {
        return () => {};
    }
    structuredConsoleState.installed = true;
    console.debug = (...arguments_: unknown[]) =>
        structuredLog("debug", "console.debug", legacyConsoleEvent(arguments_));
    console.error = (...arguments_: unknown[]) =>
        structuredLog("error", "console.error", legacyConsoleEvent(arguments_));
    console.info = (...arguments_: unknown[]) =>
        structuredLog("info", "console.info", legacyConsoleEvent(arguments_));
    console.log = (...arguments_: unknown[]) =>
        structuredLog("info", "console.log", legacyConsoleEvent(arguments_));
    console.warn = (...arguments_: unknown[]) =>
        structuredLog("warn", "console.warn", legacyConsoleEvent(arguments_));

    return () => {
        console.debug = nativeConsole.debug;
        console.error = nativeConsole.error;
        console.info = nativeConsole.info;
        console.log = nativeConsole.log;
        console.warn = nativeConsole.warn;
        structuredConsoleState.installed = false;
    };
}
