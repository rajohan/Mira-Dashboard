import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobActionKeySchema,
    jobAttemptLimitSchema,
    jobCancellationPolicySchema,
    jobDescriptionSchema,
    jobDisplayNameSchema,
    jobPayloadMaximumBytes,
    jobPayloadSchema,
    jobPrioritySchema,
    jobResourceClassSchema,
    jobResourceKeysMaximumBytes,
    jobResourceKeysSchema,
    jobTimeoutSchema,
    jobVersionSchema,
    scheduleCronExpressionSchema,
    scheduleIdSchema,
    scheduleIntervalMaximumMilliseconds,
    scheduleIntervalMinimumMilliseconds,
    scheduleKindSchema,
    scheduleTimeOfDaySchema,
    scheduleTimeZoneSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { scheduledJobs } from "../schema/scheduledJobs.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const scheduleIntervalSchema = v.pipe(
    positiveSafeIntegerSchema("Schedule interval is invalid"),
    v.minValue(scheduleIntervalMinimumMilliseconds, "Schedule interval is invalid"),
    v.maxValue(scheduleIntervalMaximumMilliseconds, "Schedule interval is invalid")
);

const storedCronExpressionSchema = v.pipe(
    v.string("Stored schedule cron expression is invalid"),
    v.check((value) => {
        const parsed = v.safeParse(scheduleCronExpressionSchema, value);
        return parsed.success && parsed.output === value;
    }, "Stored schedule cron expression is not canonical")
);

const actionPayloadJsonSchema = v.pipe(
    v.string("Stored job payload is invalid"),
    v.check(
        (value) => utf8ByteLength(value) <= jobPayloadMaximumBytes,
        "Stored job payload is outside its byte budget"
    ),
    v.check(
        (value) => v.safeParse(jobPayloadSchema, parseJsonText(value)).success,
        "Stored job payload must contain a JSON object"
    )
);

const resourceKeysJsonSchema = v.pipe(
    v.string("Stored job resource keys are invalid"),
    v.check(
        (value) => utf8ByteLength(value) <= jobResourceKeysMaximumBytes,
        "Stored job resource keys are outside their byte budget"
    ),
    v.check(
        (value) => v.safeParse(jobResourceKeysSchema, parseJsonText(value)).success,
        "Stored job resource keys are not canonical"
    )
);

interface StoredScheduleShape {
    readonly cronExpression?: string | null;
    readonly enabled: boolean;
    readonly intervalMs?: number | null;
    readonly nextRunAt?: Date | null;
    readonly scheduleKind: "cron" | "daily" | "interval";
    readonly timeOfDay?: string | null;
    readonly timeZone?: string | null;
}

function scheduleShapeIsConsistent(schedule: StoredScheduleShape): boolean {
    const cronExpression = schedule.cronExpression ?? null;
    const intervalMs = schedule.intervalMs ?? null;
    const nextRunAt = schedule.nextRunAt ?? null;
    const timeOfDay = schedule.timeOfDay ?? null;
    const timeZone = schedule.timeZone ?? null;

    if (schedule.enabled && !(nextRunAt instanceof Date)) return false;
    if (schedule.scheduleKind === "interval") {
        return (
            intervalMs !== null &&
            cronExpression === null &&
            timeOfDay === null &&
            timeZone === null
        );
    }
    if (schedule.scheduleKind === "daily") {
        return (
            intervalMs === null &&
            cronExpression === null &&
            timeOfDay !== null &&
            timeZone !== null
        );
    }
    return (
        intervalMs === null &&
        cronExpression !== null &&
        timeOfDay === null &&
        timeZone !== null
    );
}

function scheduleTimesAreConsistent(schedule: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
}): boolean {
    return schedule.updatedAt.getTime() >= schedule.createdAt.getTime();
}

const scheduleRefinements = {
    actionKey: () => jobActionKeySchema,
    actionPayloadJson: () => actionPayloadJsonSchema,
    attemptLimit: () => jobAttemptLimitSchema,
    cancellationPolicy: () => jobCancellationPolicySchema,
    createdAt: nonnegativeDateSchema,
    cronExpression: () => v.nullable(storedCronExpressionSchema),
    description: () => jobDescriptionSchema,
    id: () => scheduleIdSchema,
    intervalMs: () => v.nullable(scheduleIntervalSchema),
    name: () => jobDisplayNameSchema,
    nextRunAt: nonnegativeDateSchema,
    priority: () => jobPrioritySchema,
    resourceClass: () => jobResourceClassSchema,
    resourceKeysJson: () => resourceKeysJsonSchema,
    scheduleKind: () => scheduleKindSchema,
    timeOfDay: () => v.nullable(scheduleTimeOfDaySchema),
    timeZone: () => v.nullable(scheduleTimeZoneSchema),
    timeoutMs: () => jobTimeoutSchema,
    updatedAt: nonnegativeDateSchema,
    version: () => jobVersionSchema,
};

const generatedScheduledJobSelectSchema = createSelectSchema(
    scheduledJobs,
    scheduleRefinements
);
const scheduledJobSelectObjectSchema = v.strictObject(
    generatedScheduledJobSelectSchema.entries
);

/** Validates one complete schedule row read from SQLite. */
export const scheduledJobSelectSchema = v.pipe(
    scheduledJobSelectObjectSchema,
    v.check(
        (schedule) => scheduleShapeIsConsistent(schedule),
        "Stored schedule shape is inconsistent"
    ),
    v.check(
        (schedule) => scheduleTimesAreConsistent(schedule),
        "Stored schedule timestamps are inconsistent"
    )
);

const generatedScheduledJobInsertSchema = createInsertSchema(
    scheduledJobs,
    scheduleRefinements
);
const scheduledJobInsertObjectSchema = v.strictObject(
    generatedScheduledJobInsertSchema.entries
);

/** Validates one complete code-owned schedule before insertion. */
export const scheduledJobInsertSchema = v.pipe(
    scheduledJobInsertObjectSchema,
    v.check(
        (schedule) => scheduleShapeIsConsistent(schedule),
        "Stored schedule shape is inconsistent"
    ),
    v.check(
        (schedule) => scheduleTimesAreConsistent(schedule),
        "Stored schedule timestamps are inconsistent"
    )
);
