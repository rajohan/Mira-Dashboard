import * as v from "valibot";

import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import { taskIdSchema, taskTitleSchema } from "./taskModel.ts";

// Matches the reviewed `job_disable_intents.external_job_id` storage boundary.
export const openClawCronJobIdMaximumLength = 256;
export const openClawCronJobNameMaximumLength = 256;
export const openClawCronDescriptionMaximumLength = 4000;
export const openClawCronPayloadTextMaximumLength = 16_384;
export const openClawCronDeliveryChannelMaximumLength = 256;
export const openClawCronDeliveryTargetMaximumLength = 4096;
export const openClawCronDeliveryAccountIdMaximumLength = 256;
export const openClawCronDeliveryThreadIdMaximumLength = 512;
export const openClawCronPageDefault = 50;
export const openClawCronPageMaximum = 100;
export const openClawCronRunPageDefault = 50;
export const openClawCronRunPageMaximum = 100;

export const openClawCronJobIdSchema = boundedControlSafeTextSchema(
    openClawCronJobIdMaximumLength,
    "OpenClaw cron job id is invalid"
);
export const openClawCronJobNameSchema = boundedControlSafeTextSchema(
    openClawCronJobNameMaximumLength,
    "OpenClaw cron job name is invalid"
);
export const openClawCronDescriptionSchema = boundedNonBlankTextSchema(
    openClawCronDescriptionMaximumLength,
    "OpenClaw cron job description is invalid"
);
export const openClawCronConfigRevisionSchema = boundedControlSafeTextSchema(
    256,
    "OpenClaw cron configuration revision is invalid"
);
export const openClawCronTimestampSchema = nonnegativeSafeIntegerSchema(
    "OpenClaw cron timestamp is invalid"
);

const openClawCronBoundedOptionalTextSchema = (maximumLength: number, message: string) =>
    v.pipe(v.string(message), v.maxLength(maximumLength, message));

const openClawCronDeliveryChannelSchema = boundedControlSafeTextSchema(
    openClawCronDeliveryChannelMaximumLength,
    "OpenClaw cron delivery channel is invalid"
);
const openClawCronDeliveryTargetSchema = boundedNonBlankTextSchema(
    openClawCronDeliveryTargetMaximumLength,
    "OpenClaw cron delivery target is invalid"
);
const openClawCronDeliveryAccountIdSchema = boundedControlSafeTextSchema(
    openClawCronDeliveryAccountIdMaximumLength,
    "OpenClaw cron delivery account id is invalid"
);
const openClawCronDeliveryThreadIdSchema = v.union([
    boundedControlSafeTextSchema(
        openClawCronDeliveryThreadIdMaximumLength,
        "OpenClaw cron delivery thread id is invalid"
    ),
    v.pipe(
        v.number("OpenClaw cron delivery thread id is invalid"),
        v.safeInteger("OpenClaw cron delivery thread id is invalid")
    ),
]);
const openClawCronFailureDestinationSchema = v.strictObject({
    accountId: v.optional(openClawCronDeliveryAccountIdSchema),
    channel: v.optional(openClawCronDeliveryChannelSchema),
    mode: v.optional(
        v.picklist(
            ["announce", "webhook"],
            "OpenClaw cron failure destination mode is invalid"
        )
    ),
    to: v.optional(openClawCronDeliveryTargetSchema),
});
const openClawCronFailureDestinationPatchSchema = v.strictObject({
    accountId: v.optional(v.nullable(openClawCronDeliveryAccountIdSchema)),
    channel: v.optional(v.nullable(openClawCronDeliveryChannelSchema)),
    mode: v.optional(
        v.nullable(
            v.picklist(
                ["announce", "webhook"],
                "OpenClaw cron failure destination mode is invalid"
            )
        )
    ),
    to: v.optional(v.nullable(openClawCronDeliveryTargetSchema)),
});
const openClawCronCompletionDestinationSchema = v.strictObject({
    mode: v.literal("webhook"),
    to: openClawCronDeliveryTargetSchema,
});
const openClawCronDeliverySharedSchemas = {
    accountId: v.optional(openClawCronDeliveryAccountIdSchema),
    bestEffort: v.optional(v.boolean("OpenClaw cron best-effort state is invalid")),
    channel: v.optional(openClawCronDeliveryChannelSchema),
    failureDestination: v.optional(openClawCronFailureDestinationSchema),
    threadId: v.optional(openClawCronDeliveryThreadIdSchema),
};
const openClawCronNoneDeliverySchema = v.strictObject({
    mode: v.literal("none"),
    ...openClawCronDeliverySharedSchemas,
    to: v.optional(openClawCronDeliveryTargetSchema),
});
const openClawCronAnnounceDeliverySchema = v.strictObject({
    mode: v.literal("announce"),
    ...openClawCronDeliverySharedSchemas,
    completionDestination: v.optional(openClawCronCompletionDestinationSchema),
    to: v.optional(openClawCronDeliveryTargetSchema),
});
const openClawCronWebhookDeliverySchema = v.strictObject({
    mode: v.literal("webhook"),
    ...openClawCronDeliverySharedSchemas,
    to: openClawCronDeliveryTargetSchema,
});

/** Server-side source-audited OpenClaw CronDelivery union before response redaction. */
export const openClawCronDeliverySchema = v.variant("mode", [
    openClawCronNoneDeliverySchema,
    openClawCronAnnounceDeliverySchema,
    openClawCronWebhookDeliverySchema,
]);

const openClawCronFailureDestinationProjectionSchema = v.strictObject({
    accountId: v.optional(openClawCronDeliveryAccountIdSchema),
    channel: v.optional(openClawCronDeliveryChannelSchema),
    mode: v.optional(
        v.picklist(
            ["announce", "webhook"],
            "OpenClaw cron failure destination mode is invalid"
        )
    ),
    targetConfigured: v.boolean(
        "OpenClaw cron failure target configuration state is invalid"
    ),
});

/** Browser-safe delivery projection; every possibly secret target is write-only. */
export const openClawCronDeliveryProjectionSchema = v.strictObject({
    accountId: v.optional(openClawCronDeliveryAccountIdSchema),
    bestEffort: v.optional(v.boolean("OpenClaw cron best-effort state is invalid")),
    channel: v.optional(openClawCronDeliveryChannelSchema),
    completionDestinationConfigured: v.boolean(
        "OpenClaw cron completion destination state is invalid"
    ),
    failureDestination: v.optional(openClawCronFailureDestinationProjectionSchema),
    metadataTruncated: v.boolean(
        "OpenClaw cron delivery metadata completeness is invalid"
    ),
    mode: v.picklist(
        ["announce", "none", "webhook"],
        "OpenClaw cron delivery mode is invalid"
    ),
    targetConfigured: v.boolean(
        "OpenClaw cron delivery target configuration state is invalid"
    ),
    threadId: v.optional(openClawCronDeliveryThreadIdSchema),
});

/** Exact nullable clear semantics from the source-audited CronDeliveryPatch. */
export const openClawCronDeliveryPatchSchema = v.strictObject({
    accountId: v.optional(v.nullable(openClawCronDeliveryAccountIdSchema)),
    bestEffort: v.optional(v.boolean("OpenClaw cron best-effort state is invalid")),
    channel: v.optional(v.nullable(openClawCronDeliveryChannelSchema)),
    completionDestination: v.optional(
        v.nullable(openClawCronCompletionDestinationSchema)
    ),
    failureDestination: v.optional(v.nullable(openClawCronFailureDestinationPatchSchema)),
    mode: v.optional(
        v.picklist(
            ["announce", "none", "webhook"],
            "OpenClaw cron delivery mode is invalid"
        )
    ),
    threadId: v.optional(v.nullable(openClawCronDeliveryThreadIdSchema)),
    to: v.optional(v.nullable(openClawCronDeliveryTargetSchema)),
});

/**
 * @param value Candidate ISO-compatible timestamp string.
 * @returns Whether one bounded at-schedule is a finite timestamp string.
 */
export function openClawCronAtScheduleIsValid(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

const openClawCronAtScheduleSchema = v.strictObject({
    at: v.pipe(
        boundedControlSafeTextSchema(128, "OpenClaw one-time schedule is invalid"),
        v.check(openClawCronAtScheduleIsValid, "OpenClaw one-time schedule is invalid")
    ),
    kind: v.literal("at"),
});
const openClawCronEveryScheduleSchema = v.strictObject({
    anchorMs: v.optional(openClawCronTimestampSchema),
    everyMs: positiveSafeIntegerSchema("OpenClaw interval schedule is invalid"),
    kind: v.literal("every"),
});
const openClawCronExpressionScheduleSchema = v.strictObject({
    expr: boundedControlSafeTextSchema(256, "OpenClaw cron expression is invalid"),
    kind: v.literal("cron"),
    staggerMs: v.optional(openClawCronTimestampSchema),
    tz: v.optional(
        boundedControlSafeTextSchema(128, "OpenClaw cron timezone is invalid")
    ),
});
const openClawCronAtScheduleProjectionSchema = v.strictObject({
    at: boundedControlSafeTextSchema(128, "OpenClaw one-time schedule is invalid"),
    kind: v.literal("at"),
    truncated: v.boolean("OpenClaw one-time schedule completeness is invalid"),
});
const openClawCronEveryScheduleProjectionSchema = v.strictObject({
    ...openClawCronEveryScheduleSchema.entries,
    truncated: v.literal(false),
});
const openClawCronExpressionScheduleProjectionSchema = v.strictObject({
    ...openClawCronExpressionScheduleSchema.entries,
    truncated: v.boolean("OpenClaw cron schedule completeness is invalid"),
});
const openClawCronOnExitScheduleSchema = v.strictObject({
    commandRedacted: v.literal(true),
    kind: v.literal("on-exit"),
    workingDirectoryConfigured: v.boolean("OpenClaw on-exit directory state is invalid"),
});
const openClawCronStreamScheduleSchema = v.strictObject({
    argumentCount: positiveSafeIntegerSchema(
        "OpenClaw stream command argument count is invalid"
    ),
    batchMs: v.optional(openClawCronTimestampSchema),
    commandRedacted: v.literal(true),
    kind: v.literal("stream"),
    matchConfigured: v.boolean("OpenClaw stream match configuration state is invalid"),
    maxBatchBytes: v.optional(
        positiveSafeIntegerSchema("OpenClaw stream byte budget is invalid")
    ),
    mode: v.optional(v.picklist(["line", "match"], "OpenClaw stream mode is invalid")),
    workingDirectoryConfigured: v.boolean("OpenClaw stream directory state is invalid"),
});

/** Bounded current-protocol schedule projection. */
export const openClawCronScheduleSchema = v.variant("kind", [
    openClawCronAtScheduleProjectionSchema,
    openClawCronEveryScheduleProjectionSchema,
    openClawCronExpressionScheduleProjectionSchema,
    openClawCronOnExitScheduleSchema,
    openClawCronStreamScheduleSchema,
]);

/** Reviewed schedule variants that Dashboard permits an operator to edit. */
export const openClawCronEditableScheduleSchema = v.variant("kind", [
    openClawCronAtScheduleSchema,
    openClawCronEveryScheduleSchema,
    openClawCronExpressionScheduleSchema,
]);

const openClawCronSystemEventPayloadSchema = v.strictObject({
    kind: v.literal("system-event"),
    text: openClawCronBoundedOptionalTextSchema(
        openClawCronPayloadTextMaximumLength,
        "OpenClaw system event text is invalid"
    ),
    truncated: v.boolean("OpenClaw system event truncation state is invalid"),
});
const openClawCronAgentTurnPayloadSchema = v.strictObject({
    kind: v.literal("agent-turn"),
    lightContext: v.optional(v.boolean("OpenClaw light-context state is invalid")),
    message: openClawCronBoundedOptionalTextSchema(
        openClawCronPayloadTextMaximumLength,
        "OpenClaw agent message is invalid"
    ),
    model: v.optional(
        boundedControlSafeTextSchema(256, "OpenClaw cron model is invalid")
    ),
    thinking: v.optional(
        boundedControlSafeTextSchema(128, "OpenClaw thinking level is invalid")
    ),
    timeoutSeconds: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw agent timeout is invalid")
    ),
    truncated: v.boolean("OpenClaw agent message truncation state is invalid"),
});
const openClawCronCommandPayloadSchema = v.strictObject({
    argumentCount: nonnegativeSafeIntegerSchema(
        "OpenClaw command argument count is invalid"
    ),
    contentRedacted: v.literal(true),
    kind: v.literal("command"),
});
const openClawCronScriptPayloadSchema = v.strictObject({
    contentRedacted: v.literal(true),
    kind: v.literal("script"),
});
const openClawCronHeartbeatPayloadSchema = v.strictObject({
    kind: v.literal("heartbeat"),
});

/** Bounded payload projection that redacts every privileged command/script value. */
export const openClawCronPayloadSchema = v.variant("kind", [
    openClawCronSystemEventPayloadSchema,
    openClawCronAgentTurnPayloadSchema,
    openClawCronCommandPayloadSchema,
    openClawCronScriptPayloadSchema,
    openClawCronHeartbeatPayloadSchema,
]);

const openClawCronEditableSystemEventPayloadSchema = v.strictObject({
    kind: v.literal("system-event"),
    text: boundedNonBlankTextSchema(
        openClawCronPayloadTextMaximumLength,
        "OpenClaw system event text is invalid"
    ),
});
const nullableOpenClawCronModelSchema = v.nullable(
    boundedControlSafeTextSchema(256, "OpenClaw cron model is invalid")
);
const nullableOpenClawCronThinkingSchema = v.nullable(
    boundedControlSafeTextSchema(128, "OpenClaw thinking level is invalid")
);
const openClawCronEditableAgentTurnPayloadSchema = v.strictObject({
    kind: v.literal("agent-turn"),
    lightContext: v.optional(v.boolean("OpenClaw light-context state is invalid")),
    message: boundedNonBlankTextSchema(
        openClawCronPayloadTextMaximumLength,
        "OpenClaw agent message is invalid"
    ),
    model: v.optional(nullableOpenClawCronModelSchema),
    thinking: v.optional(nullableOpenClawCronThinkingSchema),
    timeoutSeconds: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw agent timeout is invalid")
    ),
});

export const openClawCronRunStatuses = ["error", "ok", "skipped", "unknown"] as const;
export const openClawCronRunStatusSchema = v.picklist(
    openClawCronRunStatuses,
    "OpenClaw cron run status is invalid"
);
export const openClawCronDeliveryStatuses = [
    "delivered",
    "not-delivered",
    "not-requested",
    "unknown",
] as const;
export const openClawCronDeliveryStatusSchema = v.picklist(
    openClawCronDeliveryStatuses,
    "OpenClaw cron delivery status is invalid"
);
export const openClawCronFailureReasons = [
    "auth",
    "auth_permanent",
    "billing",
    "context_overflow",
    "empty_response",
    "format",
    "model_not_found",
    "no_error_details",
    "overloaded",
    "rate_limit",
    "server_error",
    "session_expired",
    "timeout",
    "unclassified",
    "unknown",
] as const;
export const openClawCronFailureReasonSchema = v.picklist(
    openClawCronFailureReasons,
    "OpenClaw cron failure reason is invalid"
);

const openClawCronStateSchema = v.strictObject({
    consecutiveErrors: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw consecutive error count is invalid")
    ),
    lastDeliveryStatus: v.optional(openClawCronDeliveryStatusSchema),
    lastDurationMs: v.optional(openClawCronTimestampSchema),
    lastErrorReason: v.optional(openClawCronFailureReasonSchema),
    lastRunAtMs: v.optional(openClawCronTimestampSchema),
    lastRunStatus: v.optional(openClawCronRunStatusSchema),
    nextRunAtMs: v.optional(openClawCronTimestampSchema),
    runningAtMs: v.optional(openClawCronTimestampSchema),
    streamStatus: v.optional(
        v.picklist(
            ["disabled", "error", "restarting", "running", "starting", "stopped"],
            "OpenClaw stream status is invalid"
        )
    ),
});

export const openClawCronDisableReasonSchema = boundedControlSafeTextSchema(
    1000,
    "OpenClaw cron disable reason is invalid"
);
export const openClawCronDisableIntentSchema = v.strictObject({
    expiresAtMs: v.optional(openClawCronTimestampSchema),
    reason: openClawCronDisableReasonSchema,
    recordedAtMs: openClawCronTimestampSchema,
    revision: boundedControlSafeTextSchema(
        256,
        "OpenClaw cron desired-state revision is invalid"
    ),
});

const openClawCronConfirmedSynchronizationSchema = v.strictObject({
    desiredEnabled: v.optional(v.boolean("OpenClaw desired state is invalid")),
    disableIntent: v.optional(openClawCronDisableIntentSchema),
    state: v.literal("confirmed"),
});
const openClawCronUnsettledSynchronizationSchema = v.strictObject({
    desiredEnabled: v.boolean("OpenClaw desired state is invalid"),
    disableIntent: v.optional(openClawCronDisableIntentSchema),
    state: v.picklist(
        ["conflict", "pending"],
        "OpenClaw synchronization state is invalid"
    ),
});
export const openClawCronSynchronizationSchema = v.variant("state", [
    openClawCronConfirmedSynchronizationSchema,
    openClawCronUnsettledSynchronizationSchema,
]);

/** Compact Dashboard-owned unfinished task linked to one Gateway cron identity. */
export const openClawCronLinkedTaskSchema = v.strictObject({
    id: taskIdSchema,
    status: v.picklist(["todo", "in-progress", "blocked"]),
    title: taskTitleSchema,
});

const openClawCronJobObjectSchema = v.strictObject({
    agentId: v.optional(
        boundedControlSafeTextSchema(128, "OpenClaw cron agent id is invalid")
    ),
    agentIdTruncated: v.boolean("OpenClaw cron agent id completeness is invalid"),
    configRevision: v.optional(openClawCronConfigRevisionSchema),
    createdAtMs: openClawCronTimestampSchema,
    dashboardOpenLinkedTask: v.optional(openClawCronLinkedTaskSchema),
    description: v.optional(openClawCronDescriptionSchema),
    delivery: v.optional(openClawCronDeliveryProjectionSchema),
    deliveryMode: v.picklist(
        ["announce", "none", "webhook", "unspecified"],
        "OpenClaw delivery mode is invalid"
    ),
    descriptionTruncated: v.boolean("OpenClaw cron description completeness is invalid"),
    enabled: v.boolean("OpenClaw cron enabled state is invalid"),
    id: openClawCronJobIdSchema,
    name: openClawCronJobNameSchema,
    nameTruncated: v.boolean("OpenClaw cron name completeness is invalid"),
    payload: openClawCronPayloadSchema,
    schedule: openClawCronScheduleSchema,
    scratch: v.optional(
        v.strictObject({
            content: openClawCronBoundedOptionalTextSchema(
                openClawCronPayloadTextMaximumLength,
                "OpenClaw cron scratch is invalid"
            ),
            revision: nonnegativeSafeIntegerSchema(
                "OpenClaw cron scratch revision is invalid"
            ),
            truncated: v.boolean("OpenClaw cron scratch completeness is invalid"),
        })
    ),
    sessionTarget: v.picklist(
        ["current", "isolated", "main", "named-session"],
        "OpenClaw session target is invalid"
    ),
    source: v.literal("openclaw"),
    state: openClawCronStateSchema,
    synchronization: openClawCronSynchronizationSchema,
    updatedAtMs: openClawCronTimestampSchema,
    wakeMode: v.picklist(["next-heartbeat", "now"], "OpenClaw cron wake mode is invalid"),
});
type OpenClawCronJobObjectValue = v.InferOutput<typeof openClawCronJobObjectSchema>;

/**
 * @param job Browser-safe Gateway job projection to validate.
 * @returns Whether duplicated delivery and desired-state fields agree with the job.
 */
export function openClawCronJobIsConsistent(job: OpenClawCronJobObjectValue): boolean {
    const deliveryIsConsistent =
        job.delivery === undefined
            ? job.deliveryMode === "unspecified"
            : job.deliveryMode === job.delivery.mode;
    const desiredEnabled = job.synchronization.desiredEnabled;
    let synchronizationIsConsistent: boolean;
    if (desiredEnabled === undefined) {
        synchronizationIsConsistent = job.synchronization.state === "confirmed";
    } else if (job.synchronization.state === "confirmed") {
        synchronizationIsConsistent = desiredEnabled === job.enabled;
    } else {
        synchronizationIsConsistent = desiredEnabled !== job.enabled;
    }
    return deliveryIsConsistent && synchronizationIsConsistent;
}

export const openClawCronJobSchema = v.pipe(
    openClawCronJobObjectSchema,
    v.check(openClawCronJobIsConsistent, "OpenClaw cron job projection is inconsistent")
);

const openClawCronFreshSourceSchema = v.strictObject({
    kind: v.literal("fresh"),
    observedAtMs: openClawCronTimestampSchema,
});
interface OpenClawCronLastKnownGoodTimes {
    readonly kind: "last-known-good";
    readonly observedAtMs: number;
    readonly staleSinceMs: number;
}

/**
 * @param source Last-known-good timestamps to compare.
 * @returns Whether last-known-good staleness begins after its observation.
 */
export function openClawCronLastKnownGoodTimesAreConsistent(
    source: OpenClawCronLastKnownGoodTimes & Record<string, unknown>
): boolean {
    return source.staleSinceMs >= source.observedAtMs;
}

const openClawCronLastKnownGoodSourceSchema = v.pipe(
    v.strictObject({
        kind: v.literal("last-known-good"),
        observedAtMs: openClawCronTimestampSchema,
        staleSinceMs: openClawCronTimestampSchema,
    }),
    v.check(
        openClawCronLastKnownGoodTimesAreConsistent,
        "OpenClaw last-known-good timestamps are inconsistent"
    )
);
export const openClawCronFreshnessSchema = v.variant("kind", [
    openClawCronFreshSourceSchema,
    openClawCronLastKnownGoodSourceSchema,
]);

const openClawCronLimitSchema = v.pipe(
    positiveSafeIntegerSchema("OpenClaw cron page limit is invalid"),
    v.maxValue(openClawCronPageMaximum, "OpenClaw cron page is outside its budget")
);
const openClawCronRunLimitSchema = v.pipe(
    positiveSafeIntegerSchema("OpenClaw cron run page limit is invalid"),
    v.maxValue(openClawCronRunPageMaximum, "OpenClaw cron run page is outside its budget")
);
const openClawCronOffsetSchema = nonnegativeSafeIntegerSchema(
    "OpenClaw cron page offset is invalid"
);

export const listOpenClawCronInputSchema = v.strictObject({
    enabled: v.optional(
        v.picklist(["all", "disabled", "enabled"], "OpenClaw enabled filter is invalid"),
        "all"
    ),
    lastRunStatus: v.optional(
        v.picklist(
            ["all", "error", "ok", "skipped", "unknown"],
            "OpenClaw run-status filter is invalid"
        ),
        "all"
    ),
    limit: v.optional(openClawCronLimitSchema, openClawCronPageDefault),
    offset: v.optional(openClawCronOffsetSchema, 0),
    query: v.optional(
        boundedControlSafeTextSchema(200, "OpenClaw cron search query is invalid")
    ),
    scheduleKind: v.optional(
        v.picklist(
            ["all", "at", "cron", "every", "on-exit", "stream"],
            "OpenClaw schedule-kind filter is invalid"
        ),
        "all"
    ),
    sortBy: v.optional(
        v.picklist(
            ["name", "nextRunAtMs", "updatedAtMs"],
            "OpenClaw cron sort field is invalid"
        ),
        "nextRunAtMs"
    ),
    sortDir: v.optional(
        v.picklist(["asc", "desc"], "OpenClaw cron sort direction is invalid"),
        "asc"
    ),
});

const openClawCronSnapshotRevisionSchema = v.pipe(
    v.string("OpenClaw cron snapshot revision is invalid"),
    v.regex(/^sha256:[A-Za-z0-9_-]{43}$/u, "OpenClaw cron snapshot revision is invalid")
);
const openClawCronJobPageSchema = v.pipe(
    v.array(openClawCronJobSchema, "OpenClaw cron page is invalid"),
    v.maxLength(openClawCronPageMaximum, "OpenClaw cron page is outside its budget")
);
const listOpenClawCronResultObjectSchema = v.strictObject({
    freshness: openClawCronFreshnessSchema,
    hasMore: v.boolean("OpenClaw cron page continuation state is invalid"),
    jobs: openClawCronJobPageSchema,
    limit: openClawCronLimitSchema,
    nextOffset: v.optional(openClawCronOffsetSchema),
    offset: openClawCronOffsetSchema,
    snapshotRevision: openClawCronSnapshotRevisionSchema,
    total: openClawCronOffsetSchema,
});

type ListOpenClawCronResultValue = v.InferOutput<
    typeof listOpenClawCronResultObjectSchema
>;

export function openClawCronPageIsConsistent(
    result: ListOpenClawCronResultValue
): boolean {
    if (result.jobs.length > result.limit || result.offset > result.total) return false;
    const nextOffset = result.offset + result.jobs.length;
    if (result.hasMore) {
        return result.nextOffset === nextOffset && nextOffset < result.total;
    }
    return result.nextOffset === undefined && nextOffset === result.total;
}

export const listOpenClawCronResultSchema = v.pipe(
    listOpenClawCronResultObjectSchema,
    v.check(openClawCronPageIsConsistent, "OpenClaw cron page is inconsistent")
);

export const getOpenClawCronInputSchema = v.strictObject({ id: openClawCronJobIdSchema });
export const getOpenClawCronResultSchema = v.strictObject({
    freshness: openClawCronFreshnessSchema,
    job: openClawCronJobSchema,
});

const openClawCronRunUsageSchema = v.strictObject({
    cacheReadTokens: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw cached input token count is invalid")
    ),
    cacheWriteTokens: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw cached output token count is invalid")
    ),
    inputTokens: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw input token count is invalid")
    ),
    outputTokens: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw output token count is invalid")
    ),
    totalTokens: v.optional(
        nonnegativeSafeIntegerSchema("OpenClaw total token count is invalid")
    ),
});
export const openClawCronRunSchema = v.strictObject({
    completedAtMs: openClawCronTimestampSchema,
    deliveryStatus: openClawCronDeliveryStatusSchema,
    durationMs: v.optional(openClawCronTimestampSchema),
    errorReason: v.optional(openClawCronFailureReasonSchema),
    jobId: openClawCronJobIdSchema,
    model: v.optional(boundedControlSafeTextSchema(256, "OpenClaw run model is invalid")),
    modelTruncated: v.boolean("OpenClaw run model completeness is invalid"),
    provider: v.optional(
        boundedControlSafeTextSchema(128, "OpenClaw run provider is invalid")
    ),
    providerTruncated: v.boolean("OpenClaw run provider completeness is invalid"),
    runAtMs: v.optional(openClawCronTimestampSchema),
    runId: v.optional(
        boundedControlSafeTextSchema(256, "OpenClaw cron run id is invalid")
    ),
    status: openClawCronRunStatusSchema,
    summary: v.optional(
        openClawCronBoundedOptionalTextSchema(4000, "OpenClaw run summary is invalid")
    ),
    summaryTruncated: v.boolean("OpenClaw run summary completeness is invalid"),
    usage: v.optional(openClawCronRunUsageSchema),
});

export const listOpenClawCronRunsInputSchema = v.strictObject({
    deliveryStatuses: v.optional(
        v.pipe(
            v.array(openClawCronDeliveryStatusSchema),
            v.minLength(1, "OpenClaw delivery-status filter is invalid"),
            v.maxLength(4, "OpenClaw delivery-status filter is invalid")
        )
    ),
    id: openClawCronJobIdSchema,
    limit: v.optional(openClawCronRunLimitSchema, openClawCronRunPageDefault),
    offset: v.optional(openClawCronOffsetSchema, 0),
    sortDir: v.optional(
        v.picklist(["asc", "desc"], "OpenClaw run sort direction is invalid"),
        "desc"
    ),
    statuses: v.optional(
        v.pipe(
            v.array(v.picklist(["error", "ok", "skipped"])),
            v.minLength(1, "OpenClaw run-status filter is invalid"),
            v.maxLength(3, "OpenClaw run-status filter is invalid")
        )
    ),
});

const openClawCronRunPageSchema = v.pipe(
    v.array(openClawCronRunSchema),
    v.maxLength(
        openClawCronRunPageMaximum,
        "OpenClaw cron run page is outside its budget"
    )
);
const listOpenClawCronRunsResultObjectSchema = v.strictObject({
    freshness: openClawCronFreshnessSchema,
    hasMore: v.boolean("OpenClaw cron run continuation state is invalid"),
    limit: openClawCronRunLimitSchema,
    nextOffset: v.optional(openClawCronOffsetSchema),
    offset: openClawCronOffsetSchema,
    runs: openClawCronRunPageSchema,
    total: openClawCronOffsetSchema,
});
type ListOpenClawCronRunsResultValue = v.InferOutput<
    typeof listOpenClawCronRunsResultObjectSchema
>;
export function openClawCronRunPageIsConsistent(
    result: ListOpenClawCronRunsResultValue
): boolean {
    if (result.runs.length > result.limit || result.offset > result.total) return false;
    const nextOffset = result.offset + result.runs.length;
    if (result.hasMore) {
        return result.nextOffset === nextOffset && nextOffset < result.total;
    }
    return result.nextOffset === undefined && nextOffset === result.total;
}
export const listOpenClawCronRunsResultSchema = v.pipe(
    listOpenClawCronRunsResultObjectSchema,
    v.check(openClawCronRunPageIsConsistent, "OpenClaw cron run page is inconsistent")
);

export const runOpenClawCronInputSchema = v.strictObject({ id: openClawCronJobIdSchema });
const runOpenClawCronResultObjectSchema = v.strictObject({
    job: openClawCronJobSchema,
    outcome: v.picklist(["accepted", "not-run"], "OpenClaw run outcome is invalid"),
    reason: v.optional(
        v.picklist(
            ["already-running", "invalid-spec", "not-due"],
            "OpenClaw run outcome reason is invalid"
        )
    ),
});
type RunOpenClawCronResultValue = v.InferOutput<typeof runOpenClawCronResultObjectSchema>;
export function openClawCronRunOutcomeIsConsistent(
    result: RunOpenClawCronResultValue
): boolean {
    return result.outcome === "accepted"
        ? result.reason === undefined
        : result.reason !== undefined;
}
export const runOpenClawCronResultSchema = v.pipe(
    runOpenClawCronResultObjectSchema,
    v.check(openClawCronRunOutcomeIsConsistent, "OpenClaw run outcome is inconsistent")
);

const openClawCronDisableIntentInputSchema = v.strictObject({
    expiresAtMs: v.optional(openClawCronTimestampSchema),
    reason: openClawCronDisableReasonSchema,
});
const setOpenClawCronEnabledObjectSchema = v.strictObject({
    disableIntent: v.optional(v.nullable(openClawCronDisableIntentInputSchema)),
    enabled: v.boolean("OpenClaw desired enabled state is invalid"),
    expectedConfigRevision: openClawCronConfigRevisionSchema,
    id: openClawCronJobIdSchema,
});
type SetOpenClawCronEnabledValue = v.InferOutput<
    typeof setOpenClawCronEnabledObjectSchema
>;
export function openClawCronEnabledTransitionIsConsistent(
    input: SetOpenClawCronEnabledValue
): boolean {
    return input.enabled
        ? input.disableIntent === null
        : input.disableIntent !== undefined && input.disableIntent !== null;
}
export const setOpenClawCronEnabledInputSchema = v.pipe(
    setOpenClawCronEnabledObjectSchema,
    v.check(
        openClawCronEnabledTransitionIsConsistent,
        "OpenClaw desired enabled transition is inconsistent"
    )
);

export const updateOpenClawCronPatchObjectSchema = v.strictObject({
    delivery: v.optional(openClawCronDeliveryPatchSchema),
    description: v.optional(v.nullable(openClawCronDescriptionSchema)),
    name: v.optional(openClawCronJobNameSchema),
    payload: v.optional(
        v.variant("kind", [
            openClawCronEditableSystemEventPayloadSchema,
            openClawCronEditableAgentTurnPayloadSchema,
        ])
    ),
    schedule: v.optional(openClawCronEditableScheduleSchema),
    scratch: v.optional(
        openClawCronBoundedOptionalTextSchema(
            openClawCronPayloadTextMaximumLength,
            "OpenClaw cron scratch is invalid"
        )
    ),
    wakeMode: v.optional(
        v.picklist(["next-heartbeat", "now"], "OpenClaw cron wake mode is invalid")
    ),
});
export type UpdateOpenClawCronPatch = v.InferOutput<
    typeof updateOpenClawCronPatchObjectSchema
>;
export function openClawCronUpdatePatchIsNonempty(
    patch: UpdateOpenClawCronPatch
): boolean {
    return Object.values(patch).some((value) => value !== undefined);
}
export const updateOpenClawCronPatchSchema = v.pipe(
    updateOpenClawCronPatchObjectSchema,
    v.check(openClawCronUpdatePatchIsNonempty, "OpenClaw cron update is empty"),
    v.check(
        (patch) =>
            patch.scratch === undefined ||
            Object.keys(patch).every((field) => field === "scratch"),
        "OpenClaw scratch must be updated separately"
    )
);
export const updateOpenClawCronInputSchema = v.pipe(
    v.strictObject({
        expectedConfigRevision: openClawCronConfigRevisionSchema,
        expectedScratchRevision: v.optional(
            nonnegativeSafeIntegerSchema("OpenClaw cron scratch revision is invalid")
        ),
        id: openClawCronJobIdSchema,
        patch: updateOpenClawCronPatchSchema,
    }),
    v.check(
        ({ expectedScratchRevision, patch }) =>
            (patch.scratch === undefined) === (expectedScratchRevision === undefined),
        "OpenClaw cron scratch revision is required"
    )
);

export const deleteOpenClawCronInputSchema = v.strictObject({
    expectedConfigRevision: openClawCronConfigRevisionSchema,
    id: openClawCronJobIdSchema,
});
export const deleteOpenClawCronResultSchema = v.strictObject({
    deleted: v.literal(true),
    id: openClawCronJobIdSchema,
    observedAtMs: openClawCronTimestampSchema,
});

const openClawCronReadAccess = {
    capabilities: ["jobs:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const openClawCronControlAccess = {
    capabilities: ["jobs:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const openClawCronQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const openClawCronMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const openClawCronControlErrors = [
    "BAD_REQUEST",
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "PRECONDITION_FAILED",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;
const openClawCronControlErrorReasons = [
    "mfa_enrollment_required",
    "operation_outcome_unknown",
    "step_up_required",
] as const;

/** Isolated contracts ready for registration when the Gateway runtime is composed. */
export const openClawCronProcedureContracts = [
    {
        access: openClawCronReadAccess,
        domain: "openclaw-cron",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: listOpenClawCronInputSchema,
        inputSchemaId: "openClawCron.list.input",
        kind: "query",
        name: "openClawCron.list",
        output: listOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.list.output",
        summary: "Lists a bounded Gateway-owned OpenClaw cron inventory page.",
        transport: openClawCronQueryTransport,
    },
    {
        access: openClawCronReadAccess,
        domain: "openclaw-cron",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getOpenClawCronInputSchema,
        inputSchemaId: "openClawCron.get.input",
        kind: "query",
        name: "openClawCron.get",
        output: getOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.get.output",
        summary: "Loads one bounded Gateway-owned OpenClaw cron definition.",
        transport: openClawCronQueryTransport,
    },
    {
        access: openClawCronReadAccess,
        domain: "openclaw-cron",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: listOpenClawCronRunsInputSchema,
        inputSchemaId: "openClawCron.listRuns.input",
        kind: "query",
        name: "openClawCron.listRuns",
        output: listOpenClawCronRunsResultSchema,
        outputSchemaId: "openClawCron.listRuns.output",
        summary: "Lists bounded Gateway-owned run history for one OpenClaw cron job.",
        transport: openClawCronQueryTransport,
    },
    {
        access: openClawCronControlAccess,
        domain: "openclaw-cron",
        errorReasons: openClawCronControlErrorReasons,
        errors: openClawCronControlErrors,
        input: runOpenClawCronInputSchema,
        inputSchemaId: "openClawCron.run.input",
        kind: "mutation",
        name: "openClawCron.run",
        output: runOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.run.output",
        summary: "Requests one process-fenced immediate OpenClaw cron run.",
        transport: openClawCronMutationTransport,
    },
    {
        access: openClawCronControlAccess,
        domain: "openclaw-cron",
        errorReasons: openClawCronControlErrorReasons,
        errors: openClawCronControlErrors,
        input: setOpenClawCronEnabledInputSchema,
        inputSchemaId: "openClawCron.setEnabled.input",
        kind: "mutation",
        name: "openClawCron.setEnabled",
        output: getOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.setEnabled.output",
        summary:
            "Records desired enabled state and reconciles it through Gateway readback.",
        transport: openClawCronMutationTransport,
    },
    {
        access: openClawCronControlAccess,
        domain: "openclaw-cron",
        errorReasons: openClawCronControlErrorReasons,
        errors: openClawCronControlErrors,
        input: updateOpenClawCronInputSchema,
        inputSchemaId: "openClawCron.update.input",
        kind: "mutation",
        name: "openClawCron.update",
        output: getOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.update.output",
        summary: "Updates only the reviewed safe OpenClaw cron definition fields.",
        transport: openClawCronMutationTransport,
    },
    {
        access: openClawCronControlAccess,
        domain: "openclaw-cron",
        errorReasons: openClawCronControlErrorReasons,
        errors: openClawCronControlErrors,
        input: deleteOpenClawCronInputSchema,
        inputSchemaId: "openClawCron.delete.input",
        kind: "mutation",
        name: "openClawCron.delete",
        output: deleteOpenClawCronResultSchema,
        outputSchemaId: "openClawCron.delete.output",
        summary:
            "Deletes one OpenClaw cron job only after authoritative absence readback.",
        transport: openClawCronMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type DeleteOpenClawCronInput = v.InferOutput<typeof deleteOpenClawCronInputSchema>;
export type DeleteOpenClawCronResult = v.InferOutput<
    typeof deleteOpenClawCronResultSchema
>;
export type GetOpenClawCronInput = v.InferOutput<typeof getOpenClawCronInputSchema>;
export type GetOpenClawCronResult = v.InferOutput<typeof getOpenClawCronResultSchema>;
export type ListOpenClawCronInput = v.InferOutput<typeof listOpenClawCronInputSchema>;
export type ListOpenClawCronResult = v.InferOutput<typeof listOpenClawCronResultSchema>;
export type ListOpenClawCronRunsInput = v.InferOutput<
    typeof listOpenClawCronRunsInputSchema
>;
export type ListOpenClawCronRunsResult = v.InferOutput<
    typeof listOpenClawCronRunsResultSchema
>;
export type OpenClawCronDisableIntent = v.InferOutput<
    typeof openClawCronDisableIntentSchema
>;
export type OpenClawCronDelivery = v.InferOutput<typeof openClawCronDeliverySchema>;
export type OpenClawCronDeliveryProjection = v.InferOutput<
    typeof openClawCronDeliveryProjectionSchema
>;
export type OpenClawCronDeliveryPatch = v.InferOutput<
    typeof openClawCronDeliveryPatchSchema
>;
export type OpenClawCronFreshness = v.InferOutput<typeof openClawCronFreshnessSchema>;
export type OpenClawCronJob = v.InferOutput<typeof openClawCronJobSchema>;
export type OpenClawCronLinkedTask = v.InferOutput<typeof openClawCronLinkedTaskSchema>;
export type OpenClawCronRun = v.InferOutput<typeof openClawCronRunSchema>;
export type RunOpenClawCronInput = v.InferOutput<typeof runOpenClawCronInputSchema>;
export type RunOpenClawCronResult = v.InferOutput<typeof runOpenClawCronResultSchema>;
export type SetOpenClawCronEnabledInput = v.InferOutput<
    typeof setOpenClawCronEnabledInputSchema
>;
export type UpdateOpenClawCronInput = v.InferOutput<typeof updateOpenClawCronInputSchema>;
