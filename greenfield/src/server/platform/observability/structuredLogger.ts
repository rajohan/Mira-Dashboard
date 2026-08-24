import type { SafeFailureDescriptor } from "../errors/safeFailure.ts";
import { describeSafeFailure } from "../errors/safeFailure.ts";

type StructuredLogValue =
    | boolean
    | null
    | number
    | string
    | readonly StructuredLogValue[]
    | { readonly [key: string]: StructuredLogValue };

/** Hard serialization limits applied after event-specific field selection. */
export interface StructuredLogLimits {
    readonly maximumSerializedBytes: number;
}

const defaultStructuredLogLimits: StructuredLogLimits = Object.freeze({
    maximumSerializedBytes: 16 * 1024,
});
const structuredLogEncoder = new TextEncoder();

export type StructuredLogLevel = "debug" | "error" | "fatal" | "info" | "warn";

export interface StructuredLogSink {
    flush?(): undefined;
    write(line: string, level: StructuredLogLevel): undefined;
}

export interface StructuredLoggerIdentity {
    readonly bun: string;
    readonly pid: number;
    readonly processRole: "web" | "worker";
    readonly release: string;
    readonly service: string;
}

export interface StructuredLogEvent {
    readonly component: string;
    readonly durationMs?: number;
    readonly event: string;
    readonly failure?: unknown;
    readonly fields?: StructuredLogFields;
    readonly jobId?: string;
    readonly outcome?: string;
    readonly requestId?: string;
    readonly timestamp?: Date;
}

export type StructuredLogFields =
    | {
          readonly kind: "http-request";
          readonly method: string;
      }
    | {
          readonly kind: "http-response";
          readonly method: string;
          readonly status: number;
      }
    | {
          readonly failureKind: "unexpected-runner-defect";
          readonly kind: "realtime-runner-failure";
      }
    | {
          readonly kind: "trpc-defect";
          readonly path?: string;
          readonly procedureType: "mutation" | "query" | "subscription" | "unknown";
      };

export interface StructuredLogRecord extends StructuredLoggerIdentity {
    readonly component: string;
    readonly durationMs?: number;
    readonly event: string;
    readonly failure?: SafeFailureDescriptor;
    readonly fields?: StructuredLogValue;
    readonly jobId?: string;
    readonly level: StructuredLogLevel;
    readonly outcome?: string;
    readonly requestId?: string;
    readonly timestamp: string;
}

/** Process-scoped structured logger shared by Effect and ordinary TypeScript boundaries. */
export interface StructuredLogger {
    debug(event: StructuredLogEvent): void;
    error(event: StructuredLogEvent): void;
    fatal(event: StructuredLogEvent): void;
    flush(): undefined;
    info(event: StructuredLogEvent): void;
    log(level: StructuredLogLevel, event: StructuredLogEvent): void;
    warn(event: StructuredLogEvent): void;
}

export interface StructuredLoggerOptions {
    readonly fallbackWrite?: (line: string) => void;
    readonly identity: StructuredLoggerIdentity;
    readonly limits?: StructuredLogLimits;
    readonly minimumLevel?: StructuredLogLevel;
    readonly now?: () => Date;
    readonly sink: StructuredLogSink;
}

const structuredNamePattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const requestIdentityPattern = /^[A-Za-z0-9._:+-]{1,128}$/u;
const correlationIdentityPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sinkFailureLine =
    '{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n';

const structuredEventComponents = Object.freeze({
    "effect.log": "effect",
    "http.request.cancelled": "http",
    "http.request.failed": "http",
    "http.response.created": "http",
    "realtime.runner.failed": "realtime-event-pump",
    "runtime.logger.connected": "application-runtime",
    "runtime.start_failed": "runtime",
    "runtime.started": "runtime",
    "runtime.stopped": "runtime",
    "trpc.request.defect": "trpc",
} as const);

type StructuredEventName = keyof typeof structuredEventComponents;

const structuredOutcomes = new Set(["cancelled", "rejected", "server-error", "success"]);
const structuredLogLevels = new Set<StructuredLogLevel>([
    "debug",
    "error",
    "fatal",
    "info",
    "warn",
]);
const structuredLogLevelPriorities: Readonly<Record<StructuredLogLevel, number>> =
    Object.freeze({ debug: 0, error: 3, fatal: 4, info: 1, warn: 2 });

function validStructuredName(value: string): boolean {
    return value.length <= 128 && structuredNamePattern.test(value);
}

function validIdentity(value: string): boolean {
    return requestIdentityPattern.test(value);
}

function validateLoggerIdentity(identity: StructuredLoggerIdentity): void {
    if (
        !validStructuredName(identity.service) ||
        (identity.processRole !== "web" && identity.processRole !== "worker") ||
        !validIdentity(identity.release) ||
        !validIdentity(identity.bun) ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0
    ) {
        throw new TypeError("Structured logger identity is invalid");
    }
}

function validateLoggerLimits(limits: StructuredLogLimits): void {
    if (
        !Number.isSafeInteger(limits.maximumSerializedBytes) ||
        limits.maximumSerializedBytes <= 0
    ) {
        throw new TypeError("Structured logger limits are invalid");
    }
}

function optionalIdentity(value: string | undefined): string | undefined {
    return value !== undefined && correlationIdentityPattern.test(value)
        ? value
        : undefined;
}

function optionalOutcome(value: string | undefined): string | undefined {
    return value !== undefined && structuredOutcomes.has(value) ? value : undefined;
}

function optionalDuration(value: number | undefined): number | undefined {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function normalizedLogLevel(value: unknown): StructuredLogLevel {
    return structuredLogLevels.has(value as StructuredLogLevel)
        ? (value as StructuredLogLevel)
        : "error";
}

function assertSynchronousSinkResult(result: unknown): void {
    if (result === undefined) return;
    void Promise.resolve(result).catch(() => {});
    throw new TypeError("Structured log sink must be synchronous");
}

function safeHttpMethod(value: string): string | undefined {
    return /^[A-Z]{1,16}$/u.test(value) ? value : undefined;
}

function safeProcedurePath(value: string | undefined): string | undefined {
    return value !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)
        ? value
        : undefined;
}

function safeProcedureType(
    value: StructuredLogFields & { readonly kind: "trpc-defect" }
): "mutation" | "query" | "subscription" | "unknown" | undefined {
    return value.procedureType === "mutation" ||
        value.procedureType === "query" ||
        value.procedureType === "subscription" ||
        value.procedureType === "unknown"
        ? value.procedureType
        : undefined;
}

function safeEventFields(
    eventName: StructuredEventName,
    fields: StructuredLogFields | undefined
): StructuredLogValue | undefined {
    if (fields === undefined) return undefined;
    switch (fields.kind) {
        case "http-request": {
            if (
                eventName !== "http.request.cancelled" &&
                eventName !== "http.request.failed"
            ) {
                return undefined;
            }
            const method = safeHttpMethod(fields.method);
            return method === undefined ? undefined : { method };
        }
        case "http-response": {
            if (
                eventName !== "http.response.created" ||
                !Number.isSafeInteger(fields.status) ||
                fields.status < 100 ||
                fields.status > 599
            ) {
                return undefined;
            }
            const method = safeHttpMethod(fields.method);
            return method === undefined ? undefined : { method, status: fields.status };
        }
        case "realtime-runner-failure": {
            return eventName === "realtime.runner.failed" &&
                fields.failureKind === "unexpected-runner-defect"
                ? { failureKind: fields.failureKind }
                : undefined;
        }
        case "trpc-defect": {
            if (eventName !== "trpc.request.defect") return undefined;
            const path = safeProcedurePath(fields.path);
            const procedureType = safeProcedureType(fields);
            if (procedureType === undefined) return undefined;
            return {
                ...(path === undefined ? {} : { path }),
                procedureType,
            };
        }
    }
}

function normalizedEvent(event: StructuredLogEvent): {
    readonly component: string;
    readonly event: StructuredEventName;
} {
    const expectedComponent = Object.hasOwn(structuredEventComponents, event.event)
        ? structuredEventComponents[event.event as StructuredEventName]
        : undefined;
    return expectedComponent !== undefined && event.component === expectedComponent
        ? { component: expectedComponent, event: event.event as StructuredEventName }
        : { component: "effect", event: "effect.log" };
}

function makeRecord(
    identity: StructuredLoggerIdentity,
    now: () => Date,
    level: StructuredLogLevel,
    event: StructuredLogEvent
): StructuredLogRecord {
    const timestamp = event.timestamp ?? now();
    if (!Number.isFinite(Date.prototype.getTime.call(timestamp))) {
        throw new TypeError("Structured log event is invalid");
    }
    const normalized = normalizedEvent(event);
    const safeLevel = normalizedLogLevel(level);
    const durationMs = optionalDuration(event.durationMs);
    const jobId = optionalIdentity(event.jobId);
    const outcome = optionalOutcome(event.outcome);
    const requestId = optionalIdentity(event.requestId);
    const fields = safeEventFields(normalized.event, event.fields);
    return {
        ...identity,
        component: normalized.component,
        ...(durationMs === undefined ? {} : { durationMs }),
        event: normalized.event,
        ...(event.failure === undefined
            ? {}
            : { failure: describeSafeFailure(event.failure) }),
        ...(fields === undefined ? {} : { fields }),
        ...(jobId === undefined ? {} : { jobId }),
        level: safeLevel,
        ...(outcome === undefined ? {} : { outcome }),
        ...(requestId === undefined ? {} : { requestId }),
        timestamp: Date.prototype.toISOString.call(timestamp),
    };
}

function serializeRecord(
    record: StructuredLogRecord,
    limits: StructuredLogLimits
): string {
    const serialized = `${JSON.stringify(record)}\n`;
    if (
        structuredLogEncoder.encode(serialized).byteLength <=
        limits.maximumSerializedBytes
    ) {
        return serialized;
    }
    const boundedRecord: StructuredLogRecord = {
        ...record,
        fields: { truncated: true },
    };
    const bounded = `${JSON.stringify(boundedRecord)}\n`;
    if (
        structuredLogEncoder.encode(bounded).byteLength <= limits.maximumSerializedBytes
    ) {
        return bounded;
    }
    throw new RangeError("Structured log envelope exceeds its byte budget");
}

/**
 * Creates a non-throwing structured logger. Sink failures emit one constant fallback.
 * @param options Fixed identity, sink, clock, and redaction policy.
 * @returns A frozen process logger with idempotent flushing.
 */
export function createStructuredLogger(
    options: StructuredLoggerOptions
): StructuredLogger {
    validateLoggerIdentity(options.identity);
    const identity = Object.freeze({ ...options.identity });
    const limits = Object.freeze({
        maximumSerializedBytes:
            options.limits?.maximumSerializedBytes ??
            defaultStructuredLogLimits.maximumSerializedBytes,
    });
    validateLoggerLimits(limits);
    const now = options.now ?? (() => new Date());
    const minimumLevel = options.minimumLevel ?? "debug";
    if (!structuredLogLevels.has(minimumLevel)) {
        throw new TypeError("Structured logger minimum level is invalid");
    }
    const sinkWrite = options.sink.write.bind(options.sink);
    const sinkFlush = options.sink.flush?.bind(options.sink);
    let fallbackWritten = false;
    let flushed = false;

    const fallbackWrite =
        options.fallbackWrite ??
        ((line: string): void => void process.stderr.write(line));

    const writeFallback = (): void => {
        if (fallbackWritten) return;
        fallbackWritten = true;
        try {
            const result: unknown = fallbackWrite(sinkFailureLine);
            assertSynchronousSinkResult(result);
        } catch {
            // A logging double-fault must not recurse into logging or fail the process.
        }
    };
    const log = (level: StructuredLogLevel, event: StructuredLogEvent): void => {
        const safeLevel = normalizedLogLevel(level);
        if (
            structuredLogLevelPriorities[safeLevel] <
            structuredLogLevelPriorities[minimumLevel]
        ) {
            return;
        }
        try {
            const result: unknown = sinkWrite(
                serializeRecord(makeRecord(identity, now, safeLevel, event), limits),
                safeLevel
            );
            assertSynchronousSinkResult(result);
        } catch {
            writeFallback();
        }
    };
    const logger: StructuredLogger = {
        debug: (event) => log("debug", event),
        error: (event) => log("error", event),
        fatal: (event) => log("fatal", event),
        flush() {
            if (flushed) return;
            flushed = true;
            try {
                const result: unknown = sinkFlush?.();
                assertSynchronousSinkResult(result);
            } catch {
                writeFallback();
            }
        },
        info: (event) => log("info", event),
        log,
        warn: (event) => log("warn", event),
    };
    return Object.freeze(logger);
}
