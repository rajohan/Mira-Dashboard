import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import { jsonObjectSchema, type JsonObject } from "../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    fullCommitShaSchema,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { canonicalScheduleTimeZones } from "./scheduleTimeZones.ts";
import { isCanonicalWebAuthnBase64Url } from "./webauthn.ts";

/** Canonical durable job-run states. */
export const jobRunStates = [
    "cancelled",
    "failed",
    "queued",
    "running",
    "succeeded",
    "timed-out",
] as const;

/** Provenance recorded for every durable run. */
export const jobTriggerTypes = ["manual", "schedule", "startup", "system"] as const;

/** Reviewed worker resource classes, ordered canonically for transport output. */
export const jobResourceClasses = [
    "exclusive",
    "host-heavy",
    "interactive",
    "light",
    "network",
] as const;

/** Cancellation behavior captured in each immutable execution snapshot. */
export const jobCancellationPolicies = ["cooperative", "never", "queued-only"] as const;

/** Durable bounded event vocabulary for one job run. */
export const jobRunEventKinds = [
    "cancel-requested",
    "cancelled",
    "claimed",
    "failed",
    "lease-expired",
    "output-truncated",
    "progress",
    "queued",
    "retry-scheduled",
    "stderr",
    "stdout",
    "succeeded",
    "timed-out",
] as const;

/** Worker lifecycle states visible to queue readers. */
export const jobWorkerStates = ["draining", "online", "stopped"] as const;

/** Dashboard-local schedule variants implemented in Phase 3. */
export const scheduleKinds = ["cron", "daily", "interval"] as const;

export const jobActionKeyMaximumLength = 128;
export const jobDisplayNameMaximumLength = 160;
export const jobDescriptionMaximumLength = 1000;
export const jobPayloadMaximumBytes = 64 * 1024;
export const jobResourceKeyMaximumLength = 128;
export const jobResourceKeyMaximum = 32;
export const jobResourceKeysMaximumBytes = 4 * 1024;
export const jobRunResultMaximumBytes = 64 * 1024;
export const jobRunTerminalCodeMaximumLength = 128;
export const jobRunTerminalMessageMaximumLength = 2000;
export const jobRunAttemptMaximum = 10;
export const jobRunEventMaximum = 1000;
/** Payload slots left after reserving every worst-case structural lifecycle event. */
export const jobRunPayloadEventMaximum = 967;
export const jobRunOutputMaximumBytes = 1024 * 1024;
export const jobRunEventMessageMaximumLength = 4096;
export const jobRunEventMessageMaximumBytes = 4096;
/** Payload bytes left after reserving one bounded message for every attempt. */
export const jobRunPayloadEventMaximumBytes =
    jobRunOutputMaximumBytes - jobRunAttemptMaximum * jobRunEventMessageMaximumBytes;
export const jobRunEventProgressMaximumBytes = 16 * 1024;
export const jobWorkerCapacityMaximum = 16;
export const jobWorkerSummaryMaximum = 32;
export const jobIdempotencyKeyMinimumLength = 32;
export const jobIdempotencyKeyMaximumLength = 128;
export const scheduleIdMaximumLength = 80;
export const scheduleCronExpressionMaximumLength = 200;
export const scheduleTimeZoneMaximumLength = 64;
export const scheduleIntervalMinimumMilliseconds = 60_000;
export const scheduleIntervalMaximumMilliseconds = 31_536_000_000;
export const jobTimeoutMinimumMilliseconds = 1000;
export const jobTimeoutMaximumMilliseconds = 86_400_000;

export type JobCancellationPolicy = (typeof jobCancellationPolicies)[number];
export type JobResourceClass = (typeof jobResourceClasses)[number];
export type JobRunEventKind = (typeof jobRunEventKinds)[number];
export type JobRunState = (typeof jobRunStates)[number];
export type JobTriggerType = (typeof jobTriggerTypes)[number];
export type JobWorkerState = (typeof jobWorkerStates)[number];
export type ScheduleKind = (typeof scheduleKinds)[number];

export const jobRunStateSchema = v.picklist(jobRunStates, "Job run state is invalid");
export const jobTriggerTypeSchema = v.picklist(
    jobTriggerTypes,
    "Job trigger type is invalid"
);
export const jobResourceClassSchema = v.picklist(
    jobResourceClasses,
    "Job resource class is invalid"
);
export const jobCancellationPolicySchema = v.picklist(
    jobCancellationPolicies,
    "Job cancellation policy is invalid"
);
export const jobRunEventKindSchema = v.picklist(
    jobRunEventKinds,
    "Job run event kind is invalid"
);
export const jobWorkerStateSchema = v.picklist(
    jobWorkerStates,
    "Job worker state is invalid"
);
export const scheduleKindSchema = v.picklist(scheduleKinds, "Schedule kind is invalid");

export const jobTimestampSchema = timestampMillisecondsSchema("Job timestamp is invalid");
export const jobRunIdSchema = lowercaseUuidV7Schema("Job run id is invalid");
export const jobRunEventSequenceSchema = v.pipe(
    positiveSafeIntegerSchema("Job run event sequence is invalid"),
    v.maxValue(jobRunEventMaximum, "Job run event sequence is outside its budget")
);
export const jobWorkerInstanceIdSchema = lowercaseUuidV7Schema(
    "Job worker instance id is invalid"
);
export const jobVersionSchema = positiveSafeIntegerSchema("Job version is invalid");

/** Canonical Dashboard-owned schedule identity. */
export const scheduleIdSchema = v.pipe(
    v.string("Schedule id is invalid"),
    v.minLength(1, "Schedule id is invalid"),
    v.maxLength(scheduleIdMaximumLength, "Schedule id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Schedule id is invalid")
);

/** Canonical action-registry identity captured by schedules and runs. */
export const jobActionKeySchema = v.pipe(
    v.string("Job action key is invalid"),
    v.minLength(1, "Job action key is invalid"),
    v.maxLength(jobActionKeyMaximumLength, "Job action key is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Job action key is invalid")
);

/** Canonical resource key used for cross-worker exclusivity. */
export const jobResourceKeySchema = v.pipe(
    v.string("Job resource key is invalid"),
    v.minLength(1, "Job resource key is invalid"),
    v.maxLength(jobResourceKeyMaximumLength, "Job resource key is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Job resource key is invalid")
);

/** Client-generated lost-response-safe key, scoped to the authenticated caller. */
export const jobIdempotencyKeySchema = v.pipe(
    v.string("Job idempotency key is invalid"),
    v.minLength(jobIdempotencyKeyMinimumLength, "Job idempotency key is invalid"),
    v.maxLength(jobIdempotencyKeyMaximumLength, "Job idempotency key is invalid"),
    v.regex(/^[A-Za-z0-9_-]+$/u, "Job idempotency key is invalid"),
    v.check(isCanonicalWebAuthnBase64Url, "Job idempotency key is invalid")
);

export const jobDisplayNameSchema = boundedControlSafeTextSchema(
    jobDisplayNameMaximumLength,
    "Job display name is invalid"
);
export const jobDescriptionSchema = boundedControlSafeTextSchema(
    jobDescriptionMaximumLength,
    "Job description is invalid"
);
export const jobRunTerminalCodeSchema = v.pipe(
    v.string("Job terminal code is invalid"),
    v.minLength(1, "Job terminal code is invalid"),
    v.maxLength(jobRunTerminalCodeMaximumLength, "Job terminal code is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._/-]*$/u, "Job terminal code is invalid")
);
export const jobRunTerminalMessageSchema = boundedControlSafeTextSchema(
    jobRunTerminalMessageMaximumLength,
    "Job terminal message is invalid"
);

function encodedJsonBytes(value: unknown): number {
    return utf8ByteLength(JSON.stringify(value));
}

function jsonObjectFitsBudget(value: JsonObject, maximumBytes: number): boolean {
    return encodedJsonBytes(value) <= maximumBytes;
}

/**
 * @param value Candidate action payload.
 * @returns Whether it fits its byte budget.
 */
export function jobPayloadFitsBudget(value: JsonObject): boolean {
    return jsonObjectFitsBudget(value, jobPayloadMaximumBytes);
}

/**
 * @param value Candidate public result.
 * @returns Whether it fits its byte budget.
 */
export function jobRunResultFitsBudget(value: JsonObject): boolean {
    return jsonObjectFitsBudget(value, jobRunResultMaximumBytes);
}

/**
 * @param value Candidate event progress.
 * @returns Whether it fits its byte budget.
 */
export function jobRunEventProgressFitsBudget(value: JsonObject): boolean {
    return jsonObjectFitsBudget(value, jobRunEventProgressMaximumBytes);
}

/** Immutable action input retained server-side but never exposed by read models. */
export const jobPayloadSchema = v.pipe(
    jsonObjectSchema,
    v.check(
        jobPayloadFitsBudget,
        `Job payload exceeds ${jobPayloadMaximumBytes} encoded bytes`
    )
);

/** Redacted structured action result that is safe to expose to job readers. */
export const jobRunResultSchema = v.pipe(
    jsonObjectSchema,
    v.check(
        jobRunResultFitsBudget,
        `Job result exceeds ${jobRunResultMaximumBytes} encoded bytes`
    )
);

/** Bounded structured progress attached to one durable event. */
export const jobRunEventProgressSchema = v.pipe(
    jsonObjectSchema,
    v.check(
        jobRunEventProgressFitsBudget,
        `Job event progress exceeds ${jobRunEventProgressMaximumBytes} encoded bytes`
    )
);

/**
 * @param keys Resource keys to inspect.
 * @returns Whether resource keys are unique and in canonical code-unit order.
 */
export function jobResourceKeysAreCanonical(keys: string[]): boolean {
    return (
        hasUniqueArrayItems(keys) &&
        keys.every((key, index) => {
            const previous = keys[index - 1];
            return previous === undefined || compareStrings(previous, key) < 0;
        }) &&
        encodedJsonBytes(keys) <= jobResourceKeysMaximumBytes
    );
}

/** Canonical sorted resource set captured in schedules and immutable run snapshots. */
export const jobResourceKeysSchema = v.pipe(
    v.array(jobResourceKeySchema, "Job resource keys are invalid"),
    v.maxLength(jobResourceKeyMaximum, "Job resource keys are outside their budget"),
    v.check(jobResourceKeysAreCanonical, "Job resource keys are not canonical")
);

export const jobPrioritySchema = v.pipe(
    v.number("Job priority is invalid"),
    v.safeInteger("Job priority is invalid"),
    v.minValue(-100, "Job priority is invalid"),
    v.maxValue(100, "Job priority is invalid")
);
export const jobTimeoutSchema = v.pipe(
    positiveSafeIntegerSchema("Job timeout is invalid"),
    v.minValue(jobTimeoutMinimumMilliseconds, "Job timeout is invalid"),
    v.maxValue(jobTimeoutMaximumMilliseconds, "Job timeout is invalid")
);
export const jobAttemptLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Job attempt limit is invalid"),
    v.maxValue(jobRunAttemptMaximum, "Job attempt limit is invalid")
);
export const jobAttemptCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Job attempt count is invalid"),
    v.maxValue(jobRunAttemptMaximum, "Job attempt count is invalid")
);

const cronMonthAliases: Readonly<Record<string, string>> = Object.freeze({
    apr: "4",
    aug: "8",
    dec: "12",
    feb: "2",
    jan: "1",
    jul: "7",
    jun: "6",
    mar: "3",
    may: "5",
    nov: "11",
    oct: "10",
    sep: "9",
});
const cronWeekdayAliases: Readonly<Record<string, string>> = Object.freeze({
    fri: "5",
    mon: "1",
    sat: "6",
    sun: "0",
    thu: "4",
    tue: "2",
    wed: "3",
});

function collapseScheduleCronAsciiWhitespace(value: string): string {
    let collapsed = "";
    let pendingSpace = false;
    for (const character of value) {
        const isAsciiWhitespace =
            character === " " ||
            character === "\t" ||
            character === "\n" ||
            character === "\v" ||
            character === "\f" ||
            character === "\r";
        if (isAsciiWhitespace) {
            pendingSpace = collapsed.length > 0;
            continue;
        }
        if (pendingSpace) collapsed += " ";
        collapsed += character;
        pendingSpace = false;
    }
    return collapsed;
}

/**
 * Normalizes permitted ASCII whitespace and month/weekday aliases before storage.
 * @param value Candidate five-field cron expression.
 * @returns Canonically spaced expression with numeric aliases.
 */
export function normalizeScheduleCronExpression(value: string): string {
    const collapsed = collapseScheduleCronAsciiWhitespace(value).toLowerCase();
    return collapsed
        .split(" ")
        .map((field, index) => {
            if (index === 3) {
                return field.replaceAll(
                    /\b(?:apr|aug|dec|feb|jan|jul|jun|mar|may|nov|oct|sep)\b/gu,
                    (alias) => cronMonthAliases[alias] ?? alias
                );
            }
            if (index === 4) {
                return field.replaceAll(
                    /\b(?:fri|mon|sat|sun|thu|tue|wed)\b/gu,
                    (alias) => cronWeekdayAliases[alias] ?? alias
                );
            }
            return field;
        })
        .join(" ");
}

/**
 * @param value Normalized cron expression to inspect.
 * @returns Whether it is a valid five-field minute cron with a future occurrence.
 */
export function scheduleCronExpressionIsValid(value: string): boolean {
    if (!/^[-0-9*,/ ]+$/u.test(value) || value.split(" ").length !== 5) {
        return false;
    }
    const parsed = Cron.parse(value, "UTC");
    if (Result.isFailure(parsed)) return false;
    try {
        const origin = new Date(0);
        const next = Cron.next(parsed.success, origin);
        return next.getTime() - origin.getTime() >= scheduleIntervalMinimumMilliseconds;
    } catch {
        return false;
    }
}

/** Canonical five-field Dashboard-local cron expression. */
export const scheduleCronExpressionSchema = v.pipe(
    v.string("Schedule cron expression is invalid"),
    v.maxLength(
        scheduleCronExpressionMaximumLength * 2,
        "Schedule cron expression is invalid"
    ),
    v.description(
        "Five-field minute cron; live validation accepts JAN-DEC month and SUN-SAT weekday aliases, normalizes aliases and ASCII whitespace, and requires a future occurrence."
    ),
    v.transform(normalizeScheduleCronExpression),
    v.minLength(9, "Schedule cron expression is invalid"),
    v.maxLength(
        scheduleCronExpressionMaximumLength,
        "Schedule cron expression is invalid"
    ),
    v.check(scheduleCronExpressionIsValid, "Schedule cron expression is invalid")
);

const canonicalScheduleTimeZoneSet = new Set(canonicalScheduleTimeZones);

/**
 * @param value Candidate time-zone identifier.
 * @returns Whether it is an explicit canonical IANA identifier or `UTC`.
 */
export function scheduleTimeZoneIsCanonical(value: string): boolean {
    return canonicalScheduleTimeZoneSet.has(value);
}

export const scheduleTimeZoneSchema = v.pipe(
    v.string("Schedule time zone is invalid"),
    v.minLength(1, "Schedule time zone is invalid"),
    v.maxLength(scheduleTimeZoneMaximumLength, "Schedule time zone is invalid"),
    v.check(scheduleTimeZoneIsCanonical, "Schedule time zone is invalid")
);

export const scheduleTimeOfDaySchema = v.pipe(
    v.string("Schedule time of day is invalid"),
    v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Schedule time of day is invalid")
);

const cronScheduleSchema = v.strictObject({
    expression: scheduleCronExpressionSchema,
    kind: v.literal("cron"),
    timeZone: scheduleTimeZoneSchema,
});
const dailyScheduleSchema = v.strictObject({
    kind: v.literal("daily"),
    timeOfDay: scheduleTimeOfDaySchema,
    timeZone: scheduleTimeZoneSchema,
});
const intervalScheduleSchema = v.strictObject({
    intervalMs: v.pipe(
        positiveSafeIntegerSchema("Schedule interval is invalid"),
        v.minValue(scheduleIntervalMinimumMilliseconds, "Schedule interval is invalid"),
        v.maxValue(scheduleIntervalMaximumMilliseconds, "Schedule interval is invalid")
    ),
    kind: v.literal("interval"),
});

/** Complete mutually exclusive Dashboard-local schedule configuration. */
export const scheduleConfigurationSchema = v.variant("kind", [
    cronScheduleSchema,
    dailyScheduleSchema,
    intervalScheduleSchema,
]);

const jobRunSummaryObjectSchema = v.strictObject({
    actionKey: jobActionKeySchema,
    attemptCount: jobAttemptCountSchema,
    attemptLimit: jobAttemptLimitSchema,
    availableAtMs: jobTimestampSchema,
    cancellationPolicy: jobCancellationPolicySchema,
    cancelRequestedAtMs: v.optional(jobTimestampSchema),
    displayName: jobDisplayNameSchema,
    eventCount: v.pipe(
        nonnegativeSafeIntegerSchema("Job event count is invalid"),
        v.maxValue(jobRunEventMaximum, "Job event count is outside its budget")
    ),
    finishedAtMs: v.optional(jobTimestampSchema),
    firstStartedAtMs: v.optional(jobTimestampSchema),
    id: jobRunIdSchema,
    lastAttemptStartedAtMs: v.optional(jobTimestampSchema),
    priority: jobPrioritySchema,
    queuedAtMs: jobTimestampSchema,
    resourceClass: jobResourceClassSchema,
    resourceKeys: jobResourceKeysSchema,
    retrySafe: v.boolean("Job retry-safe policy is invalid"),
    scheduledForAtMs: v.optional(jobTimestampSchema),
    scheduledJobId: v.optional(scheduleIdSchema),
    scheduledJobVersion: v.optional(jobVersionSchema),
    state: jobRunStateSchema,
    stateVersion: jobVersionSchema,
    terminalCode: v.optional(jobRunTerminalCodeSchema),
    terminalMessage: v.optional(jobRunTerminalMessageSchema),
    timeoutMs: jobTimeoutSchema,
    triggerType: jobTriggerTypeSchema,
    updatedAtMs: jobTimestampSchema,
});

export type JobRunSummary = v.InferOutput<typeof jobRunSummaryObjectSchema>;

/**
 * @param run Public run projection to inspect.
 * @returns Whether it preserves lifecycle and timestamp invariants.
 */
export function jobRunSummaryIsConsistent(run: JobRunSummary): boolean {
    const hasScheduleIdentity = run.scheduledJobId !== undefined;
    if (hasScheduleIdentity !== (run.scheduledJobVersion !== undefined)) return false;
    if (["manual", "schedule"].includes(run.triggerType) !== hasScheduleIdentity) {
        return false;
    }
    if (
        (run.triggerType === "schedule") !== (run.scheduledForAtMs !== undefined) ||
        (run.triggerType === "schedule" && !hasScheduleIdentity)
    ) {
        return false;
    }
    if (run.attemptCount > run.attemptLimit) return false;
    const hasStarted = run.firstStartedAtMs !== undefined;
    if (
        hasStarted !== (run.lastAttemptStartedAtMs !== undefined) ||
        hasStarted !== run.attemptCount > 0
    ) {
        return false;
    }

    const terminal = ["cancelled", "failed", "succeeded", "timed-out"].includes(
        run.state
    );
    const hasTerminalError = run.terminalCode !== undefined;
    if (
        terminal !== (run.finishedAtMs !== undefined) ||
        hasTerminalError !== (run.terminalMessage !== undefined) ||
        (run.state === "succeeded" && hasTerminalError) ||
        (["cancelled", "failed", "timed-out"].includes(run.state) && !hasTerminalError) ||
        (["queued", "running"].includes(run.state) && hasTerminalError)
    ) {
        return false;
    }
    if (
        ["failed", "running", "succeeded", "timed-out"].includes(run.state) &&
        run.attemptCount === 0
    ) {
        return false;
    }
    if (run.cancellationPolicy === "never" && run.cancelRequestedAtMs !== undefined) {
        return false;
    }

    const orderedTimestamps = [
        run.firstStartedAtMs,
        run.lastAttemptStartedAtMs,
        run.cancelRequestedAtMs,
        run.finishedAtMs,
    ].filter((timestamp): timestamp is number => timestamp !== undefined);
    return (
        run.availableAtMs >= run.queuedAtMs &&
        run.updatedAtMs >= run.queuedAtMs &&
        orderedTimestamps.every(
            (timestamp) => timestamp >= run.queuedAtMs && timestamp <= run.updatedAtMs
        ) &&
        (run.firstStartedAtMs === undefined ||
            run.lastAttemptStartedAtMs === undefined ||
            run.lastAttemptStartedAtMs >= run.firstStartedAtMs) &&
        (run.finishedAtMs === undefined ||
            run.lastAttemptStartedAtMs === undefined ||
            run.finishedAtMs >= run.lastAttemptStartedAtMs)
    );
}

/** Public run projection without raw payload, worker lease, or fencing data. */
export const jobRunSummarySchema = v.pipe(
    jobRunSummaryObjectSchema,
    v.check(jobRunSummaryIsConsistent, "Job run summary is inconsistent")
);

const jobRunEventMessageSchema = v.pipe(
    boundedControlSafeTextSchema(
        jobRunEventMessageMaximumLength,
        "Job run event message is invalid"
    ),
    v.check(
        jobRunEventMessageFitsBudget,
        "Job run event message is outside its byte budget"
    )
);

/**
 * @param message Candidate event message.
 * @returns Whether it fits its byte budget.
 */
export function jobRunEventMessageFitsBudget(message: string): boolean {
    return utf8ByteLength(message) <= jobRunEventMessageMaximumBytes;
}

const jobRunEventObjectSchema = v.strictObject({
    attempt: jobAttemptCountSchema,
    kind: jobRunEventKindSchema,
    message: v.optional(jobRunEventMessageSchema),
    occurredAtMs: jobTimestampSchema,
    progress: v.optional(jobRunEventProgressSchema),
    sequence: jobRunEventSequenceSchema,
    workerInstanceId: v.optional(jobWorkerInstanceIdSchema),
});

export type JobRunEvent = v.InferOutput<typeof jobRunEventObjectSchema>;

/**
 * @param event Durable run event to inspect.
 * @returns Whether its kind agrees with required bounded payload fields.
 */
export function jobRunEventIsConsistent(event: JobRunEvent): boolean {
    if (event.kind === "progress") return event.progress !== undefined;
    if (event.kind === "stderr" || event.kind === "stdout") {
        return event.message !== undefined && event.progress === undefined;
    }
    return event.progress === undefined;
}

/** One durable bounded progress or lifecycle event. */
export const jobRunEventSchema = v.pipe(
    jobRunEventObjectSchema,
    v.check(jobRunEventIsConsistent, "Job run event payload is inconsistent")
);

const jobWorkerSummaryObjectSchema = v.strictObject({
    activeRunCount: v.pipe(
        nonnegativeSafeIntegerSchema("Worker active-run count is invalid"),
        v.maxValue(jobWorkerCapacityMaximum, "Worker active-run count is invalid")
    ),
    capacity: v.pipe(
        positiveSafeIntegerSchema("Worker capacity is invalid"),
        v.maxValue(jobWorkerCapacityMaximum, "Worker capacity is invalid")
    ),
    drainingAtMs: v.optional(jobTimestampSchema),
    heartbeatAtMs: jobTimestampSchema,
    id: jobWorkerInstanceIdSchema,
    releaseId: fullCommitShaSchema("Worker release id is invalid"),
    startedAtMs: jobTimestampSchema,
    state: jobWorkerStateSchema,
    stoppedAtMs: v.optional(jobTimestampSchema),
});

type JobWorkerSummaryValue = v.InferOutput<typeof jobWorkerSummaryObjectSchema>;

/**
 * @param worker Public worker summary to inspect.
 * @returns Whether worker state and lifecycle timestamps agree.
 */
export function jobWorkerSummaryIsConsistent(worker: JobWorkerSummaryValue): boolean {
    if (worker.activeRunCount > worker.capacity) return false;
    if (worker.state === "stopped" && worker.activeRunCount !== 0) return false;
    if (worker.heartbeatAtMs < worker.startedAtMs) return false;
    if (
        (worker.state === "online" &&
            (worker.drainingAtMs !== undefined || worker.stoppedAtMs !== undefined)) ||
        (worker.state === "draining" &&
            (worker.drainingAtMs === undefined || worker.stoppedAtMs !== undefined)) ||
        (worker.state === "stopped" &&
            (worker.drainingAtMs === undefined || worker.stoppedAtMs === undefined))
    ) {
        return false;
    }
    return (
        (worker.drainingAtMs === undefined ||
            worker.drainingAtMs >= worker.startedAtMs) &&
        (worker.stoppedAtMs === undefined ||
            worker.stoppedAtMs >= (worker.drainingAtMs ?? worker.startedAtMs))
    );
}

export const jobWorkerSummarySchema = v.pipe(
    jobWorkerSummaryObjectSchema,
    v.check(jobWorkerSummaryIsConsistent, "Worker summary is inconsistent")
);

/** Versioned singleton state controlling cross-process claims. */
export const jobWorkerControlSchema = v.strictObject({
    claimingPaused: v.boolean("Worker claiming state is invalid"),
    updatedAtMs: jobTimestampSchema,
    version: jobVersionSchema,
});

/** Active operator disable intent attached to one schedule. */
const activeJobDisableIntentObjectSchema = v.strictObject({
    createdAtMs: jobTimestampSchema,
    expiresAtMs: v.optional(jobTimestampSchema),
    id: lowercaseUuidV7Schema("Job disable intent id is invalid"),
    reason: boundedControlSafeTextSchema(
        jobDescriptionMaximumLength,
        "Job disable reason is invalid"
    ),
});

type ActiveJobDisableIntentValue = v.InferOutput<
    typeof activeJobDisableIntentObjectSchema
>;

/**
 * @param intent Active disable intent to inspect.
 * @returns Whether an optional expiry is strictly after creation.
 */
export function activeJobDisableIntentTimesAreConsistent(
    intent: ActiveJobDisableIntentValue
): boolean {
    return intent.expiresAtMs === undefined || intent.expiresAtMs > intent.createdAtMs;
}

export const activeJobDisableIntentSchema = v.pipe(
    activeJobDisableIntentObjectSchema,
    v.check(
        activeJobDisableIntentTimesAreConsistent,
        "Job disable intent timestamps are inconsistent"
    )
);

const scheduleSummaryObjectSchema = v.strictObject({
    actionKey: jobActionKeySchema,
    activeDisableIntent: v.optional(activeJobDisableIntentSchema),
    activeRun: v.optional(jobRunSummarySchema),
    attemptLimit: jobAttemptLimitSchema,
    cancellationPolicy: jobCancellationPolicySchema,
    createdAtMs: jobTimestampSchema,
    description: jobDescriptionSchema,
    enabled: v.boolean("Schedule enabled state is invalid"),
    id: scheduleIdSchema,
    latestRun: v.optional(jobRunSummarySchema),
    name: jobDisplayNameSchema,
    nextRunAtMs: v.optional(jobTimestampSchema),
    priority: jobPrioritySchema,
    resourceClass: jobResourceClassSchema,
    resourceKeys: jobResourceKeysSchema,
    retrySafe: v.boolean("Schedule retry-safe policy is invalid"),
    schedule: scheduleConfigurationSchema,
    timeoutMs: jobTimeoutSchema,
    updatedAtMs: jobTimestampSchema,
    version: jobVersionSchema,
});

export type ScheduleSummary = v.InferOutput<typeof scheduleSummaryObjectSchema>;

/**
 * @param schedule Public schedule summary to inspect.
 * @returns Whether state, timestamps, and embedded run references agree.
 */
export function scheduleSummaryIsConsistent(schedule: ScheduleSummary): boolean {
    if (schedule.enabled !== (schedule.nextRunAtMs !== undefined)) return false;
    if (schedule.enabled && schedule.activeDisableIntent !== undefined) return false;
    if (schedule.updatedAtMs < schedule.createdAtMs) return false;
    for (const run of [schedule.activeRun, schedule.latestRun]) {
        if (run !== undefined && run.scheduledJobId !== schedule.id) return false;
    }
    if (
        schedule.activeRun !== undefined &&
        !["queued", "running"].includes(schedule.activeRun.state)
    ) {
        return false;
    }
    return (
        schedule.activeRun === undefined ||
        schedule.latestRun === undefined ||
        schedule.activeRun.id === schedule.latestRun.id
    );
}

/** Public schedule projection without its raw action payload. */
export const scheduleSummarySchema = v.pipe(
    scheduleSummaryObjectSchema,
    v.check(scheduleSummaryIsConsistent, "Schedule summary is inconsistent")
);

export type ActiveJobDisableIntent = v.InferOutput<typeof activeJobDisableIntentSchema>;
export type JobRunResult = v.InferOutput<typeof jobRunResultSchema>;
export type JobWorkerControl = v.InferOutput<typeof jobWorkerControlSchema>;
export type JobWorkerSummary = v.InferOutput<typeof jobWorkerSummarySchema>;
export type ScheduleConfiguration = v.InferOutput<typeof scheduleConfigurationSchema>;
