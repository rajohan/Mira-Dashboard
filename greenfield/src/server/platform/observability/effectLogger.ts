import { Layer, Logger, type LogLevel, References, type Cause } from "effect";

import type {
    StructuredLogEvent,
    StructuredLogFields,
    StructuredLogLevel,
    StructuredLogger,
} from "./structuredLogger.ts";

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function effectEventName(
    value: unknown
): "effect.log" | "realtime.runner.failed" | "runtime.logger.connected" {
    return value === "realtime.runner.failed" || value === "runtime.logger.connected"
        ? value
        : "effect.log";
}

function effectComponent(
    event: ReturnType<typeof effectEventName>
): "application-runtime" | "effect" | "realtime-event-pump" {
    if (event === "realtime.runner.failed") return "realtime-event-pump";
    if (event === "runtime.logger.connected") return "application-runtime";
    return "effect";
}

function effectLogLevel(level: LogLevel.LogLevel): StructuredLogLevel {
    switch (level) {
        case "Fatal": {
            return "fatal";
        }
        case "Error": {
            return "error";
        }
        case "Warn": {
            return "warn";
        }
        case "Info": {
            return "info";
        }
        case "All":
        case "Debug":
        case "None":
        case "Trace": {
            return "debug";
        }
    }
}

function effectFields(
    event: string,
    annotations: Readonly<Record<string, unknown>>
): StructuredLogFields | undefined {
    if (
        event === "realtime.runner.failed" &&
        annotations.failureKind === "unexpected-runner-defect"
    ) {
        return {
            failureKind: "unexpected-runner-defect",
            kind: "realtime-runner-failure",
        };
    }
    return undefined;
}

function eventFailure(cause: Cause.Cause<unknown>): Cause.Cause<unknown> | undefined {
    return cause.reasons.length === 0 ? undefined : cause;
}

/**
 * Bridges Effect log events into the process structured logger without rendering Cause values.
 * @param structuredLogger Process-scoped structured logger.
 * @returns An Effect logger suitable for one ManagedRuntime layer.
 */
export function createEffectStructuredLogger(
    structuredLogger: StructuredLogger
): Logger.Logger<unknown, void> {
    return Logger.make(({ cause, date, fiber, logLevel }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations);
        const failure = eventFailure(cause);
        const durationMs = annotations.durationMs;
        const eventName = effectEventName(annotations.event);
        const fields = effectFields(eventName, annotations);
        const event: StructuredLogEvent = {
            component: effectComponent(eventName),
            ...(typeof durationMs === "number" ? { durationMs } : {}),
            event: eventName,
            ...(failure === undefined ? {} : { failure }),
            ...(fields === undefined ? {} : { fields }),
            ...(optionalString(annotations.jobId) === undefined
                ? {}
                : { jobId: optionalString(annotations.jobId) }),
            ...(optionalString(annotations.outcome) === undefined
                ? {}
                : { outcome: optionalString(annotations.outcome) }),
            ...(optionalString(annotations.requestId) === undefined
                ? {}
                : { requestId: optionalString(annotations.requestId) }),
            timestamp: date,
        };
        structuredLogger.log(effectLogLevel(logLevel), event);
    });
}

/**
 * Replaces Effect's default logger and installs a process-wide minimum level.
 * @param structuredLogger Process-scoped structured logger.
 * @param minimumLevel Minimum Effect severity emitted by the runtime.
 * @returns A layer with exactly one active application logger.
 */
export function createEffectLoggerLayer(
    structuredLogger: StructuredLogger,
    minimumLevel: LogLevel.LogLevel = "Info"
): Layer.Layer<never> {
    return Layer.merge(
        Logger.layer([createEffectStructuredLogger(structuredLogger)]),
        Layer.succeed(References.MinimumLogLevel, minimumLevel)
    );
}
