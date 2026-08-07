import { compareAsc } from "date-fns";
import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import { jsonObjectSchema, type JsonObject } from "../shared/json.ts";
import {
    boundedNonBlankStringSchema,
    lowercaseUuidV7Schema,
} from "../shared/validation.ts";

export type { JsonObject, JsonValue } from "../shared/json.ts";

export const monitoringJsonObjectMaximumBytes = 64 * 1024;
const maximumReportBodyCharacters = 1_000_000;

function encodedJsonBytes(value: JsonObject): number {
    return utf8ByteLength(JSON.stringify(value));
}

/** JSON object accepted by monitoring report metadata and incident details. */
export const monitoringJsonObjectSchema = v.pipe(
    jsonObjectSchema,
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
