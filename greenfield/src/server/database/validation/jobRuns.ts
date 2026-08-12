import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobActionKeySchema,
    jobAttemptCountSchema,
    jobAttemptLimitSchema,
    jobCancellationPolicySchema,
    jobDisplayNameSchema,
    jobIdempotencyKeySchema,
    isUnstartedRetiredScheduleFailure,
    jobPayloadMaximumBytes,
    jobPayloadSchema,
    jobPrioritySchema,
    jobResourceClassSchema,
    jobResourceKeysMaximumBytes,
    jobResourceKeysSchema,
    jobRunEventMaximum,
    jobRunOutputMaximumBytes,
    jobRunPayloadEventMaximum,
    jobRunResultMaximumBytes,
    jobRunResultSchema,
    jobRunStateSchema,
    jobRunTerminalCodeSchema,
    jobRunTerminalMessageSchema,
    jobTimeoutSchema,
    jobTriggerTypeSchema,
    jobVersionSchema,
    scheduleIdSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";
import { jobRuns } from "../schema/jobRuns.ts";
import { jobActorIdentityIsValid } from "./jobActors.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { sha256TextSchema } from "./securityScalars.ts";

const actorKindSchema = v.picklist(["automation", "system", "user"]);

function jsonObjectTextSchema(
    maximumBytes: number,
    objectSchema: typeof jobPayloadSchema | typeof jobRunResultSchema,
    message: string
) {
    return v.pipe(
        v.string(message),
        v.check((value) => utf8ByteLength(value) <= maximumBytes, message),
        v.check(
            (value) => v.safeParse(objectSchema, parseJsonText(value)).success,
            message
        )
    );
}

const payloadJsonSchema = jsonObjectTextSchema(
    jobPayloadMaximumBytes,
    jobPayloadSchema,
    "Stored job payload is invalid"
);
const resultJsonSchema = jsonObjectTextSchema(
    jobRunResultMaximumBytes,
    jobRunResultSchema,
    "Stored job result is invalid"
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
const eventCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Stored job event count is invalid"),
    v.maxValue(jobRunEventMaximum, "Stored job event count is invalid")
);
const payloadEventCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Stored job payload-event count is invalid"),
    v.maxValue(jobRunPayloadEventMaximum, "Stored job payload-event count is invalid")
);
const eventBytesSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Stored job event-byte count is invalid"),
    v.maxValue(jobRunOutputMaximumBytes, "Stored job event-byte count is invalid")
);

interface StoredJobRun {
    readonly attemptCount: number;
    readonly attemptLimit: number;
    readonly availableAt: Date;
    readonly cancellationPolicy: "cooperative" | "never" | "queued-only";
    readonly cancelRequestedAt: Date | null;
    readonly cancelRequestedById: string | null;
    readonly cancelRequestedByKind: "automation" | "system" | "user" | null;
    readonly eventBytes: number;
    readonly eventCount: number;
    readonly finishedAt: Date | null;
    readonly firstStartedAt: Date | null;
    readonly heartbeatAt: Date | null;
    readonly lastAttemptStartedAt: Date | null;
    readonly leaseExpiresAt: Date | null;
    readonly leaseOwnerId: string | null;
    readonly leaseToken: string | null;
    readonly payloadEventCount: number;
    readonly queuedAt: Date;
    readonly requestedById: string;
    readonly requestedByKind: "automation" | "system" | "user";
    readonly resultJson: string | null;
    readonly scheduledForAt: Date | null;
    readonly scheduledJobId: string | null;
    readonly scheduledJobVersion: number | null;
    readonly state:
        | "cancelled"
        | "failed"
        | "queued"
        | "running"
        | "succeeded"
        | "timed-out";
    readonly terminalCode: string | null;
    readonly terminalMessage: string | null;
    readonly triggerType: "manual" | "schedule" | "startup" | "system";
    readonly updatedAt: Date;
}

function scheduleProvenanceIsConsistent(run: StoredJobRun): boolean {
    const hasSchedule = run.scheduledJobId !== null;
    if (hasSchedule !== (run.scheduledJobVersion !== null)) return false;
    if (
        (run.triggerType === "schedule" && !hasSchedule) ||
        (["startup", "system"].includes(run.triggerType) && hasSchedule)
    ) {
        return false;
    }
    return (
        (run.triggerType === "schedule") === (run.scheduledForAt !== null) &&
        (run.scheduledForAt === null ||
            run.scheduledForAt.getTime() <= run.queuedAt.getTime())
    );
}

function attemptsAreConsistent(run: StoredJobRun): boolean {
    if (run.attemptCount > run.attemptLimit) return false;
    const hasStarted = run.firstStartedAt !== null;
    if (
        hasStarted !== (run.lastAttemptStartedAt !== null) ||
        hasStarted !== run.attemptCount > 0
    ) {
        return false;
    }
    return (
        !["failed", "running", "succeeded", "timed-out"].includes(run.state) ||
        run.attemptCount > 0 ||
        isUnstartedRetiredScheduleFailure(run)
    );
}

function leaseIsConsistent(run: StoredJobRun): boolean {
    const hasLease = run.leaseOwnerId !== null;
    if (
        hasLease !== (run.leaseToken !== null) ||
        hasLease !== (run.leaseExpiresAt !== null) ||
        hasLease !== (run.heartbeatAt !== null) ||
        hasLease !== (run.state === "running")
    ) {
        return false;
    }
    if (!hasLease) return true;
    return (
        run.lastAttemptStartedAt !== null &&
        run.heartbeatAt !== null &&
        run.leaseExpiresAt !== null &&
        run.heartbeatAt.getTime() >= run.lastAttemptStartedAt.getTime() &&
        run.leaseExpiresAt.getTime() > run.heartbeatAt.getTime()
    );
}

function cancellationIsConsistent(run: StoredJobRun): boolean {
    const requested = run.cancelRequestedAt !== null;
    if (
        requested !== (run.cancelRequestedById !== null) ||
        requested !== (run.cancelRequestedByKind !== null) ||
        (requested && run.cancellationPolicy === "never") ||
        (run.state === "cancelled" && !requested)
    ) {
        return false;
    }
    return (
        !requested ||
        (run.cancelRequestedById !== null &&
            run.cancelRequestedByKind !== null &&
            jobActorIdentityIsValid(run.cancelRequestedByKind, run.cancelRequestedById))
    );
}

function terminalStateIsConsistent(run: StoredJobRun): boolean {
    const hasFinished = run.finishedAt !== null;
    const hasResult = run.resultJson !== null;
    const hasTerminalCode = run.terminalCode !== null;
    const hasTerminalMessage = run.terminalMessage !== null;
    if (hasTerminalCode !== hasTerminalMessage) return false;
    if (run.state === "succeeded") {
        return hasFinished && hasResult && !hasTerminalCode;
    }
    if (["cancelled", "failed", "timed-out"].includes(run.state)) {
        return hasFinished && !hasResult && hasTerminalCode;
    }
    return !hasFinished && !hasResult && !hasTerminalCode;
}

function timestampsAreConsistent(run: StoredJobRun): boolean {
    const queuedAt = run.queuedAt.getTime();
    const updatedAt = run.updatedAt.getTime();
    if (run.availableAt.getTime() < queuedAt || updatedAt < queuedAt) return false;

    const durableTransitionTimes = [
        run.firstStartedAt,
        run.lastAttemptStartedAt,
        run.heartbeatAt,
        run.cancelRequestedAt,
        run.finishedAt,
    ].filter((date): date is Date => date !== null);
    if (
        durableTransitionTimes.some(
            (timestamp) =>
                timestamp.getTime() < queuedAt || timestamp.getTime() > updatedAt
        )
    ) {
        return false;
    }
    return (
        (run.firstStartedAt === null ||
            run.lastAttemptStartedAt === null ||
            run.lastAttemptStartedAt.getTime() >= run.firstStartedAt.getTime()) &&
        (run.finishedAt === null ||
            run.lastAttemptStartedAt === null ||
            run.finishedAt.getTime() >= run.lastAttemptStartedAt.getTime())
    );
}

function jobRunIsConsistent(run: StoredJobRun): boolean {
    return (
        jobActorIdentityIsValid(run.requestedByKind, run.requestedById) &&
        run.payloadEventCount <= run.eventCount &&
        scheduleProvenanceIsConsistent(run) &&
        attemptsAreConsistent(run) &&
        leaseIsConsistent(run) &&
        cancellationIsConsistent(run) &&
        terminalStateIsConsistent(run) &&
        timestampsAreConsistent(run)
    );
}

const jobRunRefinements = {
    actionKey: () => jobActionKeySchema,
    attemptCount: () => jobAttemptCountSchema,
    attemptLimit: () => jobAttemptLimitSchema,
    availableAt: nonnegativeDateSchema,
    cancellationPolicy: () => jobCancellationPolicySchema,
    cancelRequestedAt: nonnegativeDateSchema,
    cancelRequestedById: () => v.nullable(v.string()),
    cancelRequestedByKind: () => v.nullable(actorKindSchema),
    displayName: () => jobDisplayNameSchema,
    enqueueSha256: sha256TextSchema,
    eventBytes: () => eventBytesSchema,
    eventCount: () => eventCountSchema,
    finishedAt: nonnegativeDateSchema,
    firstStartedAt: nonnegativeDateSchema,
    heartbeatAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    idempotencyKey: () => jobIdempotencyKeySchema,
    lastAttemptStartedAt: nonnegativeDateSchema,
    leaseExpiresAt: nonnegativeDateSchema,
    leaseOwnerId: uuidV7TextSchema,
    leaseToken: uuidV7TextSchema,
    payloadEventCount: () => payloadEventCountSchema,
    payloadJson: () => payloadJsonSchema,
    priority: () => jobPrioritySchema,
    queuedAt: nonnegativeDateSchema,
    requestedById: () => v.string(),
    requestedByKind: () => actorKindSchema,
    resourceClass: () => jobResourceClassSchema,
    resourceKeysJson: () => resourceKeysJsonSchema,
    resultJson: () => v.nullable(resultJsonSchema),
    scheduledForAt: nonnegativeDateSchema,
    scheduledJobId: () => v.nullable(scheduleIdSchema),
    scheduledJobVersion: () => v.nullable(jobVersionSchema),
    state: () => jobRunStateSchema,
    stateVersion: () => jobVersionSchema,
    terminalCode: () => v.nullable(jobRunTerminalCodeSchema),
    terminalMessage: () => v.nullable(jobRunTerminalMessageSchema),
    timeoutMs: () => jobTimeoutSchema,
    triggerType: () => jobTriggerTypeSchema,
    updatedAt: nonnegativeDateSchema,
};

const generatedJobRunSelectSchema = createSelectSchema(jobRuns, jobRunRefinements);
const jobRunSelectObjectSchema = v.strictObject(generatedJobRunSelectSchema.entries);

/** Validates one complete durable job-run row read from SQLite. */
export const jobRunSelectSchema = v.pipe(
    jobRunSelectObjectSchema,
    v.check((run) => jobRunIsConsistent(run), "Stored job run is inconsistent")
);

const generatedJobRunInsertSchema = v.omit(
    createInsertSchema(jobRuns, jobRunRefinements),
    ["attemptCount", "eventBytes", "eventCount", "payloadEventCount", "stateVersion"]
);
const jobRunInsertObjectSchema = v.strictObject(generatedJobRunInsertSchema.entries);

/** Validates the initial queued projection before inserting a durable run. */
export const jobRunInsertSchema = v.pipe(
    jobRunInsertObjectSchema,
    v.check(
        (run) =>
            run.state === "queued" &&
            run.cancelRequestedAt == null &&
            run.cancelRequestedById == null &&
            run.cancelRequestedByKind == null &&
            run.finishedAt == null &&
            run.firstStartedAt == null &&
            run.heartbeatAt == null &&
            run.lastAttemptStartedAt == null &&
            run.leaseExpiresAt == null &&
            run.leaseOwnerId == null &&
            run.leaseToken == null &&
            run.resultJson == null &&
            run.terminalCode == null &&
            run.terminalMessage == null &&
            jobActorIdentityIsValid(run.requestedByKind, run.requestedById) &&
            run.availableAt.getTime() >= run.queuedAt.getTime() &&
            run.updatedAt.getTime() >= run.queuedAt.getTime() &&
            scheduleProvenanceIsConsistent({
                ...run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 0,
                payloadEventCount: 0,
            }),
        "New job run must be an internally consistent queued row"
    )
);
