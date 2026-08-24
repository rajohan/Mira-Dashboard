import { compareAsc } from "date-fns";
import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedNonBlankStringSchema,
    lowercaseUuidV7Schema,
} from "../shared/validation.ts";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
    | JsonObject
    | readonly JsonValue[]
    | boolean
    | null
    | number
    | string;

const maximumJsonDepth = 12;
export const monitoringJsonObjectMaximumBytes = 64 * 1024;
const maximumReportBodyCharacters = 1_000_000;

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
    return utf8ByteLength(JSON.stringify(value));
}

/** JSON object accepted by monitoring report metadata and incident details. */
export const monitoringJsonObjectSchema = v.pipe(
    v.custom<JsonObject>(isJsonObject, "Expected a JSON object."),
    v.check(
        (value) => encodedJsonBytes(value) <= monitoringJsonObjectMaximumBytes,
        `Expected JSON no larger than ${monitoringJsonObjectMaximumBytes} encoded bytes.`
    )
);

const monitoringTimestampMillisecondsSchema = timestampMillisecondsSchema();

const monitoringRunIdSchema = lowercaseUuidV7Schema(
    "Expected a lowercase UUIDv7 monitor run id."
);

/** Shared persisted monitoring kind policy. */
export const monitoringKindSchema = boundedNonBlankStringSchema(100);

/** Shared persisted monitor key policy. */
export const monitoringMonitorKeySchema = boundedNonBlankStringSchema(200);

/** Shared persisted monitoring problem title policy. */
export const monitoringProblemTitleSchema = boundedNonBlankStringSchema(1000);

/** Shared persisted report body policy. */
export const monitoringReportBodyMarkdownSchema = boundedNonBlankStringSchema(
    maximumReportBodyCharacters,
    "Expected a non-blank report body."
);

/** Shared persisted report source policy. */
export const monitoringReportSourceSchema = boundedNonBlankStringSchema(200);

/** Shared persisted report source-job policy. */
export const monitoringReportSourceJobIdSchema = boundedNonBlankStringSchema(200);

/** Shared persisted report title policy. */
export const monitoringReportTitleSchema = boundedNonBlankStringSchema(500);

/** One observed problem in a complete monitor snapshot. */
export const monitoringProblemInputSchema = v.strictObject({
    condition: boundedNonBlankStringSchema(200),
    details: v.optional(monitoringJsonObjectSchema, {}),
    entityKey: boundedNonBlankStringSchema(200),
    kind: monitoringKindSchema,
    severity: v.picklist(["critical", "error", "info", "warning"]),
    title: monitoringProblemTitleSchema,
});

/** Immutable report content stored for every monitor submission. */
export const monitoringReportInputSchema = v.strictObject({
    bodyMarkdown: monitoringReportBodyMarkdownSchema,
    kind: monitoringKindSchema,
    metadata: v.optional(monitoringJsonObjectSchema, {}),
    source: monitoringReportSourceSchema,
    sourceJobId: monitoringReportSourceJobIdSchema,
    title: monitoringReportTitleSchema,
});

const monitoringProblemsInputSchema = v.pipe(
    v.array(monitoringProblemInputSchema),
    v.maxLength(100)
);

/** Successful full-replacement snapshot accepted by the monitoring domain service. */
export const completeMonitoringSnapshotInputSchema = v.pipe(
    v.strictObject({
        completedAtMs: monitoringTimestampMillisecondsSchema,
        monitorKey: monitoringMonitorKeySchema,
        problems: monitoringProblemsInputSchema,
        report: monitoringReportInputSchema,
        runId: monitoringRunIdSchema,
        startedAtMs: monitoringTimestampMillisecondsSchema,
    }),
    v.check(
        (input) => compareAsc(input.completedAtMs, input.startedAtMs) >= 0,
        "Expected completedAtMs to be greater than or equal to startedAtMs."
    )
);

/** Compact durable outbox payload used to invalidate one changed entity. */
export const monitoringChangePayloadSchema = v.strictObject({
    id: boundedNonBlankStringSchema(200),
});

export type CompleteMonitoringSnapshotInput = v.InferOutput<
    typeof completeMonitoringSnapshotInputSchema
>;
export type MonitoringProblemInput = v.InferOutput<typeof monitoringProblemInputSchema>;
