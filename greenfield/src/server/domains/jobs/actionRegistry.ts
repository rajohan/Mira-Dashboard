import { Effect } from "effect";
import * as v from "valibot";

import {
    type JobCancellationPolicy,
    type JobResourceClass,
    type JobRunResult,
    type ScheduleConfiguration,
    jobActionKeySchema,
    jobAttemptLimitSchema,
    jobCancellationPolicySchema,
    jobDescriptionSchema,
    jobDisplayNameSchema,
    jobPayloadSchema,
    jobPrioritySchema,
    jobResourceClassSchema,
    jobResourceKeysSchema,
    jobRunEventProgressSchema,
    jobTimeoutSchema,
    scheduleConfigurationSchema,
    scheduleIdSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { boundedControlSafeTextSchema } from "../../../shared/validation.ts";

export type JobManualExposure = "jobs-write" | "none";
export type JobActionEventWriteResult = "appended" | "dropped" | "truncated";

const jobManualExposureSchema = v.picklist(
    ["jobs-write", "none"],
    "Job manual exposure is invalid"
);

/** Explicit action-owned classification for failures safe to retry from scratch. */
export class JobActionRetryableError extends Error {
    constructor(cause?: unknown) {
        super(
            "The job action reported a retryable failure",
            cause === undefined ? undefined : { cause }
        );
        this.name = "JobActionRetryableError";
    }
}

const jobActionOutputMessageSchema = v.pipe(
    boundedControlSafeTextSchema(4096, "Job action output is invalid"),
    v.check((message) => utf8ByteLength(message) <= 4096, "Job action output is invalid")
);

/** Safe execution context supplied by the worker without host or shell authority. */
export interface JobActionExecutionContext {
    readonly databaseReleaseId: string;
    readonly nowMs: () => number;
    readonly reportProgress: (
        progress: JsonObject
    ) => Effect.Effect<JobActionEventWriteResult, unknown>;
    readonly workerInstanceId: string;
    readonly writeOutput: (
        kind: "stderr" | "stdout",
        message: string
    ) => Effect.Effect<JobActionEventWriteResult, unknown>;
}

/** Code-owned action metadata reconciled into schedules and captured into each run. */
export interface JobActionRegistration {
    readonly actionKey: string;
    readonly actionPayload: JsonObject;
    readonly attemptLimit: number;
    readonly cancellationPolicy: JobCancellationPolicy;
    readonly defaultEnabled: boolean;
    readonly defaultSchedule: ScheduleConfiguration;
    readonly description: string;
    readonly displayName: string;
    readonly execute: (
        context: JobActionExecutionContext,
        payload: JsonObject
    ) => Effect.Effect<JobRunResult, unknown>;
    readonly manualExposure: JobManualExposure;
    readonly priority: number;
    readonly resourceClass: JobResourceClass;
    readonly resourceKeys: readonly string[];
    readonly retrySafe: boolean;
    readonly scheduleId: string;
    readonly timeoutMs: number;
}

const emptyPayloadSchema = v.strictObject({});
const smokeResultSchema = v.strictObject({
    checkedAtMs: v.pipe(
        v.number("Worker smoke timestamp is invalid"),
        v.safeInteger("Worker smoke timestamp is invalid"),
        v.minValue(0, "Worker smoke timestamp is invalid")
    ),
    databaseReleaseId: v.pipe(
        v.string("Worker smoke release is invalid"),
        v.length(40, "Worker smoke release is invalid"),
        v.regex(/^[0-9a-f]{40}$/u, "Worker smoke release is invalid")
    ),
    status: v.literal("ok"),
    workerInstanceId: v.pipe(
        v.string("Worker smoke identity is invalid"),
        v.uuid("Worker smoke identity is invalid")
    ),
});

/**
 * Validates one code-owned action and retains canonical schedule output.
 * @param registration Candidate release-owned action metadata.
 * @returns A frozen registration safe for reconciliation and execution.
 */
export function validateJobActionRegistration(
    registration: JobActionRegistration
): JobActionRegistration {
    v.parse(jobActionKeySchema, registration.actionKey);
    const actionPayload = v.parse(jobPayloadSchema, registration.actionPayload);
    v.parse(jobAttemptLimitSchema, registration.attemptLimit);
    v.parse(jobCancellationPolicySchema, registration.cancellationPolicy);
    v.parse(
        v.boolean("Job default-enabled flag is invalid"),
        registration.defaultEnabled
    );
    const defaultSchedule = v.parse(
        scheduleConfigurationSchema,
        registration.defaultSchedule
    );
    v.parse(jobDescriptionSchema, registration.description);
    v.parse(jobDisplayNameSchema, registration.displayName);
    v.parse(jobPrioritySchema, registration.priority);
    v.parse(jobResourceClassSchema, registration.resourceClass);
    const resourceKeys = v.parse(jobResourceKeysSchema, registration.resourceKeys);
    v.parse(jobManualExposureSchema, registration.manualExposure);
    v.parse(v.boolean("Job retry-safe flag is invalid"), registration.retrySafe);
    v.parse(scheduleIdSchema, registration.scheduleId);
    v.parse(jobTimeoutSchema, registration.timeoutMs);
    v.parse(v.function("Job action executor is invalid"), registration.execute);
    return Object.freeze({
        ...registration,
        actionPayload: Object.freeze({ ...actionPayload }),
        defaultSchedule: Object.freeze({ ...defaultSchedule }),
        resourceKeys: Object.freeze([...resourceKeys]),
    });
}

const workerSmokeRegistration = validateJobActionRegistration({
    actionKey: "system.worker-smoke",
    actionPayload: Object.freeze({}),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: false,
    defaultSchedule: Object.freeze({
        intervalMs: 86_400_000,
        kind: "interval",
    }),
    description:
        "Verifies the release, database, and durable worker without host mutation.",
    displayName: "Worker smoke",
    execute: (context, payload) =>
        Effect.sync(() => {
            v.parse(emptyPayloadSchema, payload);
            return v.parse(smokeResultSchema, {
                checkedAtMs: context.nowMs(),
                databaseReleaseId: context.databaseReleaseId,
                status: "ok",
                workerInstanceId: context.workerInstanceId,
            });
        }),
    manualExposure: "jobs-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["database"]),
    retrySafe: true,
    scheduleId: "system.worker-smoke",
    timeoutMs: 30_000,
});

/** Complete reviewed action registry for this slice. */
export const jobActionRegistrations = Object.freeze([workerSmokeRegistration]);

const registrationByKey = new Map(
    jobActionRegistrations.map((registration) => [registration.actionKey, registration])
);
if (registrationByKey.size !== jobActionRegistrations.length) {
    throw new Error("Job action registry contains duplicate action keys");
}
const registrationByScheduleId = new Map(
    jobActionRegistrations.map((registration) => [registration.scheduleId, registration])
);
if (registrationByScheduleId.size !== jobActionRegistrations.length) {
    throw new Error("Job action registry contains duplicate schedule IDs");
}

/**
 * Resolves one exact reviewed action.
 * @param actionKey Durable action identity.
 * @returns The action registration, when this release implements it.
 */
export function findJobActionRegistration(
    actionKey: string
): JobActionRegistration | undefined {
    return registrationByKey.get(actionKey);
}

/**
 * Checks that a durable schedule still belongs to the exact registered action.
 * @param scheduleId Durable schedule identity.
 * @param actionKey Durable action identity captured by the schedule.
 * @returns Whether this release owns the exact schedule/action pair.
 */
export function isRegisteredJobSchedule(scheduleId: string, actionKey: string): boolean {
    return registrationByScheduleId.get(scheduleId)?.actionKey === actionKey;
}

/**
 * Validates one action-owned progress payload before it reaches persistence.
 * @param progress Structured progress candidate.
 * @returns The bounded transport-safe payload.
 */
export function parseJobActionProgress(progress: JsonObject): JsonObject {
    return v.parse(jobRunEventProgressSchema, progress);
}

/**
 * Validates one action-owned output fragment before it reaches persistence.
 * @param message Human-readable output candidate.
 * @returns The bounded control-safe message.
 */
export function parseJobActionOutputMessage(message: string): string {
    return v.parse(jobActionOutputMessageSchema, message);
}
