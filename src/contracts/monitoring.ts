import { compareAsc } from "date-fns";
import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import { jsonObjectSchema, type JsonObject } from "../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankStringSchema,
    lowercaseUuidV7Schema,
} from "../shared/validation.ts";

export type { JsonObject, JsonValue } from "../shared/json.ts";

export const monitoringJsonObjectMaximumBytes = 64 * 1024;
/** Aggregate parsed-input budget retained below the 640 KiB monitoring transport ceiling. */
export const monitoringMutationInputMaximumBytes = 512 * 1024;
const maximumReportBodyCharacters = 1_000_000;

function encodedJsonBytes(value: JsonObject): number {
    return utf8ByteLength(JSON.stringify(value));
}

/** @returns Whether one monitoring JSON object fits its encoded field budget. */
export function monitoringJsonObjectFitsBudget(value: JsonObject): boolean {
    return encodedJsonBytes(value) <= monitoringJsonObjectMaximumBytes;
}

/**
 * @param value Parsed monitoring mutation input.
 * @returns Whether its canonical JSON representation fits the aggregate semantic budget.
 */
export function monitoringMutationInputFitsBudget(value: unknown): boolean {
    return utf8ByteLength(JSON.stringify(value)) <= monitoringMutationInputMaximumBytes;
}

/** JSON object accepted by monitoring report metadata and incident details. */
export const monitoringJsonObjectSchema = v.pipe(
    jsonObjectSchema,
    v.check(
        monitoringJsonObjectFitsBudget,
        `Expected JSON no larger than ${monitoringJsonObjectMaximumBytes} encoded bytes.`
    )
);

const monitoringTimestampMillisecondsSchema = timestampMillisecondsSchema();

/** Stable UUIDv7 identity shared by monitoring records. */
export const monitoringRecordIdSchema = lowercaseUuidV7Schema(
    "Expected a lowercase UUIDv7 monitoring record id."
);

const monitoringRunIdSchema = lowercaseUuidV7Schema(
    "Expected a lowercase UUIDv7 monitor run id."
);

export const monitoringSeverities = ["critical", "error", "info", "warning"] as const;

export const monitoringReportStatuses = ["error", "ok", "warning"] as const;

/** Shared incident and notification severity vocabulary. */
export const monitoringSeveritySchema = v.picklist(
    monitoringSeverities,
    "Monitoring severity is invalid"
);

/** Stable operator-facing report status vocabulary. */
export const monitoringReportStatusSchema = v.picklist(
    monitoringReportStatuses,
    "Monitoring report status is invalid"
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

/** Optional compact report summary shown in list surfaces. */
export const monitoringReportSummarySchema = boundedControlSafeTextSchema(
    2000,
    "Monitoring report summary is invalid"
);

/** Shared persisted report title policy. */
export const monitoringReportTitleSchema = boundedNonBlankStringSchema(500);

/** Safe same-origin route retained by one Dashboard notification. */
export const monitoringLinkPathSchema = v.pipe(
    boundedControlSafeTextSchema(2048, "Monitoring link is invalid"),
    v.regex(/^\/(?!\/)[^\s\\]*$/u, "Monitoring link is invalid")
);

/** One observed problem in a complete monitor snapshot. */
export const monitoringProblemInputSchema = v.strictObject({
    condition: boundedNonBlankStringSchema(200),
    details: v.optional(monitoringJsonObjectSchema, {}),
    entityKey: boundedNonBlankStringSchema(200),
    kind: monitoringKindSchema,
    severity: monitoringSeveritySchema,
    title: monitoringProblemTitleSchema,
});

/** Immutable report content stored for every monitor submission. */
export const monitoringReportInputSchema = v.strictObject({
    bodyMarkdown: monitoringReportBodyMarkdownSchema,
    kind: monitoringKindSchema,
    metadata: v.optional(monitoringJsonObjectSchema, {}),
    source: monitoringReportSourceSchema,
    sourceJobId: monitoringReportSourceJobIdSchema,
    summary: v.optional(monitoringReportSummarySchema),
    title: monitoringReportTitleSchema,
});

const monitoringProblemsInputSchema = v.pipe(
    v.array(monitoringProblemInputSchema),
    v.maxLength(100)
);

const completeMonitoringSnapshotInputObjectSchema = v.strictObject({
    completedAtMs: monitoringTimestampMillisecondsSchema,
    monitorKey: monitoringMonitorKeySchema,
    problems: monitoringProblemsInputSchema,
    report: monitoringReportInputSchema,
    runId: monitoringRunIdSchema,
    startedAtMs: monitoringTimestampMillisecondsSchema,
});

type CompleteMonitoringSnapshotInputValue = v.InferOutput<
    typeof completeMonitoringSnapshotInputObjectSchema
>;

/** @returns Whether one complete snapshot has monotonic run timestamps. */
export function completeMonitoringSnapshotTimesAreConsistent(
    input: CompleteMonitoringSnapshotInputValue
): boolean {
    return compareAsc(input.completedAtMs, input.startedAtMs) >= 0;
}

/** @returns Whether one complete snapshot fits its aggregate encoded budget. */
export function completeMonitoringSnapshotFitsBudget(
    input: CompleteMonitoringSnapshotInputValue
): boolean {
    return monitoringMutationInputFitsBudget(input);
}

/** Successful full-replacement snapshot accepted by the monitoring domain service. */
export const completeMonitoringSnapshotInputSchema = v.pipe(
    completeMonitoringSnapshotInputObjectSchema,
    v.check(
        completeMonitoringSnapshotTimesAreConsistent,
        "Expected completedAtMs to be greater than or equal to startedAtMs."
    ),
    v.check(
        completeMonitoringSnapshotFitsBudget,
        `Expected monitoring mutation input no larger than ${monitoringMutationInputMaximumBytes} encoded bytes.`
    )
);

/**
 * Compact durable outbox payload used to invalidate changed catalog state.
 * For `snapshot-required`, the id is causal correlation only; consumers refetch the
 * topic's complete snapshot instead of resolving it as one entity identity.
 */
export const monitoringChangePayloadSchema = v.strictObject({
    id: boundedNonBlankStringSchema(200),
});

const monitoringTransportTimestampSchema = timestampMillisecondsSchema(
    "Monitoring timestamp is invalid"
);

/** Bounded report row used by list surfaces without the potentially large body. */
export const reportSummarySchema = v.strictObject({
    id: monitoringRecordIdSchema,
    kind: monitoringKindSchema,
    occurredAtMs: monitoringTransportTimestampSchema,
    source: monitoringReportSourceSchema,
    sourceJobId: v.optional(monitoringReportSourceJobIdSchema),
    status: monitoringReportStatusSchema,
    summary: v.optional(monitoringReportSummarySchema),
    title: monitoringReportTitleSchema,
});

/** Complete immutable report document loaded by exact identity. */
export const reportDetailSchema = v.strictObject({
    ...reportSummarySchema.entries,
    bodyMarkdown: monitoringReportBodyMarkdownSchema,
    metadata: monitoringJsonObjectSchema,
});

const incidentSummaryBaseEntries = {
    fingerprint: v.pipe(
        v.string("Incident fingerprint is invalid"),
        v.regex(/^[0-9a-f]{64}$/u, "Incident fingerprint is invalid")
    ),
    firstSeenAtMs: monitoringTransportTimestampSchema,
    generation: v.pipe(
        v.number("Incident generation is invalid"),
        v.safeInteger("Incident generation is invalid"),
        v.minValue(1, "Incident generation is invalid")
    ),
    id: monitoringRecordIdSchema,
    kind: monitoringKindSchema,
    lastSeenAtMs: monitoringTransportTimestampSchema,
    monitorKey: monitoringMonitorKeySchema,
    occurrenceCount: v.pipe(
        v.number("Incident occurrence count is invalid"),
        v.safeInteger("Incident occurrence count is invalid"),
        v.minValue(1, "Incident occurrence count is invalid")
    ),
    severity: monitoringSeveritySchema,
    title: monitoringProblemTitleSchema,
};

const incidentBaseEntries = {
    details: monitoringJsonObjectSchema,
    ...incidentSummaryBaseEntries,
};

const activeIncidentSchema = v.strictObject({
    ...incidentBaseEntries,
    state: v.literal("active"),
});

const resolvedIncidentSchema = v.strictObject({
    ...incidentBaseEntries,
    resolvedAtMs: monitoringTransportTimestampSchema,
    state: v.literal("resolved"),
});

const activeIncidentSummarySchema = v.strictObject({
    ...incidentSummaryBaseEntries,
    state: v.literal("active"),
});

const resolvedIncidentSummarySchema = v.strictObject({
    ...incidentSummaryBaseEntries,
    resolvedAtMs: monitoringTransportTimestampSchema,
    state: v.literal("resolved"),
});

type ActiveIncident = v.InferOutput<typeof activeIncidentSchema>;
type ResolvedIncident = v.InferOutput<typeof resolvedIncidentSchema>;
type ActiveIncidentSummary = v.InferOutput<typeof activeIncidentSummarySchema>;
type ResolvedIncidentSummary = v.InferOutput<typeof resolvedIncidentSummarySchema>;

function activeIncidentLifecycleTimesAreConsistent(incident: {
    readonly firstSeenAtMs: number;
    readonly lastSeenAtMs: number;
}): boolean {
    return incident.lastSeenAtMs >= incident.firstSeenAtMs;
}

function resolvedIncidentLifecycleTimesAreConsistent(incident: {
    readonly firstSeenAtMs: number;
    readonly lastSeenAtMs: number;
    readonly resolvedAtMs: number;
}): boolean {
    return (
        activeIncidentLifecycleTimesAreConsistent(incident) &&
        incident.resolvedAtMs >= incident.lastSeenAtMs
    );
}

/** @returns Whether an active incident's observations are monotonic. */
export function activeIncidentTimesAreConsistent(incident: ActiveIncident): boolean {
    return activeIncidentLifecycleTimesAreConsistent(incident);
}

/** @returns Whether a resolved incident's lifecycle timestamps are monotonic. */
export function resolvedIncidentTimesAreConsistent(incident: ResolvedIncident): boolean {
    return resolvedIncidentLifecycleTimesAreConsistent(incident);
}

/** @returns Whether an active incident summary's observations are monotonic. */
export function activeIncidentSummaryTimesAreConsistent(
    incident: ActiveIncidentSummary
): boolean {
    return activeIncidentLifecycleTimesAreConsistent(incident);
}

/** @returns Whether a resolved incident summary's lifecycle is monotonic. */
export function resolvedIncidentSummaryTimesAreConsistent(
    incident: ResolvedIncidentSummary
): boolean {
    return resolvedIncidentLifecycleTimesAreConsistent(incident);
}

/** Complete public incident lifecycle record. */
export const incidentRecordSchema = v.variant("state", [
    v.pipe(
        activeIncidentSchema,
        v.check(activeIncidentTimesAreConsistent, "Incident timestamps are inconsistent")
    ),
    v.pipe(
        resolvedIncidentSchema,
        v.check(
            resolvedIncidentTimesAreConsistent,
            "Incident timestamps are inconsistent"
        )
    ),
]);

/** Bounded incident list row without the potentially large details document. */
export const incidentSummarySchema = v.variant("state", [
    v.pipe(
        activeIncidentSummarySchema,
        v.check(
            activeIncidentSummaryTimesAreConsistent,
            "Incident timestamps are inconsistent"
        )
    ),
    v.pipe(
        resolvedIncidentSummarySchema,
        v.check(
            resolvedIncidentSummaryTimesAreConsistent,
            "Incident timestamps are inconsistent"
        )
    ),
]);

const notificationRecordObjectSchema = v.strictObject({
    id: monitoringRecordIdSchema,
    incidentGeneration: v.optional(
        v.pipe(
            v.number("Notification incident generation is invalid"),
            v.safeInteger("Notification incident generation is invalid"),
            v.minValue(1, "Notification incident generation is invalid")
        )
    ),
    incidentId: v.optional(monitoringRecordIdSchema),
    kind: monitoringKindSchema,
    linkUrl: v.optional(monitoringLinkPathSchema),
    message: monitoringProblemTitleSchema,
    occurredAtMs: monitoringTransportTimestampSchema,
    readAtMs: v.optional(monitoringTransportTimestampSchema),
    reportId: v.optional(monitoringRecordIdSchema),
    severity: monitoringSeveritySchema,
    source: v.optional(monitoringReportSourceSchema),
    title: monitoringReportTitleSchema,
});

type NotificationRecordValue = v.InferOutput<typeof notificationRecordObjectSchema>;

/** @returns Whether optional incident identity and generation are present together. */
export function notificationIncidentReferenceIsConsistent(
    notification: NotificationRecordValue
): boolean {
    return (
        (notification.incidentId === undefined) ===
        (notification.incidentGeneration === undefined)
    );
}

/** @returns Whether read time is absent or no earlier than notification creation. */
export function notificationTimesAreConsistent(
    notification: NotificationRecordValue
): boolean {
    return (
        notification.readAtMs === undefined ||
        notification.readAtMs >= notification.occurredAtMs
    );
}

/** Complete public notification record. */
export const notificationRecordSchema = v.pipe(
    notificationRecordObjectSchema,
    v.check(
        notificationIncidentReferenceIsConsistent,
        "Notification incident reference is inconsistent"
    ),
    v.check(notificationTimesAreConsistent, "Notification timestamps are inconsistent")
);

/** Stable result returned by complete monitoring snapshot ingestion. */
export const monitoringSubmissionResultSchema = v.strictObject({
    createdIncidents: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    duplicateRunId: v.boolean(),
    observedIncidents: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    reopenedIncidents: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    reportId: v.nullable(monitoringRecordIdSchema),
    resolvedIncidents: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    realtimeEvents: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    runId: monitoringRunIdSchema,
    status: v.picklist(["accepted", "duplicate", "stale"]),
});

export type CompleteMonitoringSnapshotInput = v.InferOutput<
    typeof completeMonitoringSnapshotInputSchema
>;
export type MonitoringProblemInput = v.InferOutput<typeof monitoringProblemInputSchema>;
export type IncidentRecord = v.InferOutput<typeof incidentRecordSchema>;
export type IncidentSummary = v.InferOutput<typeof incidentSummarySchema>;
export type MonitoringSubmissionResult = v.InferOutput<
    typeof monitoringSubmissionResultSchema
>;
export type NotificationRecord = v.InferOutput<typeof notificationRecordSchema>;
export type ReportDetail = v.InferOutput<typeof reportDetailSchema>;
export type ReportSummary = v.InferOutput<typeof reportSummarySchema>;
