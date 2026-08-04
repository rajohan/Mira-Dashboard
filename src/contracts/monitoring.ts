import * as v from "valibot";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
    | JsonObject
    | readonly JsonValue[]
    | boolean
    | null
    | number
    | string;

const maximumJsonDepth = 12;
const maximumJsonObjectBytes = 64 * 1024;
const maximumReportBodyCharacters = 1_000_000;
const maximumTimestampMilliseconds = 8_640_000_000_000_000;
const uuidV7Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Qualified upper bound for one monitoring realtime payload. */
export const monitoringRealtimeMaximumPayloadBytes = 8 * 1024;

function isJsonValue(
    value: unknown,
    depth: number,
    ancestors: Set<object>
): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value !== "object" || depth > maximumJsonDepth || ancestors.has(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        return false;
    }

    ancestors.add(value);
    let isValid = true;
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value) || !isJsonValue(value[index], depth + 1, ancestors)) {
                isValid = false;
                break;
            }
        }
    } else {
        isValid = Object.values(value).every((child) =>
            isJsonValue(child, depth + 1, ancestors)
        );
    }
    ancestors.delete(value);
    return isValid;
}

function isJsonObject(value: unknown): value is JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    return isJsonValue(value, 0, new Set());
}

function encodedJsonBytes(value: JsonObject): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedNonBlankString(maximumLength: number) {
    return v.pipe(
        v.string(),
        v.maxLength(maximumLength),
        v.check((value) => value.trim().length > 0, "Expected a non-blank string.")
    );
}

/** JSON object accepted by monitoring report metadata and incident details. */
export const monitoringJsonObjectSchema = v.pipe(
    v.custom<JsonObject>(isJsonObject, "Expected a JSON object."),
    v.check(
        (value) => encodedJsonBytes(value) <= maximumJsonObjectBytes,
        `Expected JSON no larger than ${maximumJsonObjectBytes} encoded bytes.`
    )
);

const timestampMillisecondsSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.maxValue(maximumTimestampMilliseconds)
);

const monitoringRunIdSchema = v.pipe(
    v.string(),
    v.uuid(),
    v.regex(uuidV7Pattern, "Expected a lowercase UUIDv7 monitor run id.")
);

/** One observed problem in a complete monitor snapshot. */
export const monitoringProblemInputSchema = v.strictObject({
    condition: boundedNonBlankString(200),
    details: v.optional(monitoringJsonObjectSchema, {}),
    entityKey: boundedNonBlankString(200),
    kind: boundedNonBlankString(100),
    severity: v.picklist(["critical", "error", "info", "warning"]),
    title: boundedNonBlankString(1000),
});

/** Immutable report content stored for every monitor submission. */
export const monitoringReportInputSchema = v.strictObject({
    bodyMarkdown: v.pipe(
        v.string(),
        v.maxLength(maximumReportBodyCharacters),
        v.check((value) => value.trim().length > 0, "Expected a non-blank report body.")
    ),
    kind: boundedNonBlankString(100),
    metadata: v.optional(monitoringJsonObjectSchema, {}),
    source: boundedNonBlankString(200),
    sourceJobId: boundedNonBlankString(200),
    title: boundedNonBlankString(500),
});

const monitoringProblemsInputSchema = v.pipe(
    v.array(monitoringProblemInputSchema),
    v.maxLength(100)
);

/** Successful full-replacement snapshot accepted by the monitoring domain service. */
export const completeMonitoringSnapshotInputSchema = v.pipe(
    v.strictObject({
        completedAtMs: timestampMillisecondsSchema,
        monitorKey: boundedNonBlankString(200),
        problems: monitoringProblemsInputSchema,
        report: monitoringReportInputSchema,
        runId: monitoringRunIdSchema,
        startedAtMs: timestampMillisecondsSchema,
    }),
    v.check(
        (input) => input.completedAtMs >= input.startedAtMs,
        "Expected completedAtMs to be greater than or equal to startedAtMs."
    )
);

/** Compact durable outbox payload used to invalidate one changed entity. */
export const monitoringChangePayloadSchema = v.strictObject({
    id: boundedNonBlankString(200),
});

export type CompleteMonitoringSnapshotInput = v.InferOutput<
    typeof completeMonitoringSnapshotInputSchema
>;
export type MonitoringProblemInput = v.InferOutput<typeof monitoringProblemInputSchema>;
