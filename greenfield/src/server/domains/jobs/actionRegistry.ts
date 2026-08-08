import type { Effect } from "effect";
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

export type JobInitialDuePolicy = "immediate" | "next-occurrence";
export type JobManualExposure = "cache-write" | "jobs-write" | "none";
export type JobActionEventWriteResult = "appended" | "dropped" | "truncated";
export type JobCacheAttemptWriteResult = "committed" | "lost-claim";

export type JobCacheAttemptCommit =
    | {
          readonly durationMs: number;
          readonly failureCode: string;
          readonly failureMessage: string;
          readonly key: string;
          readonly kind: "failed";
      }
    | {
          readonly durationMs: number;
          readonly entries: readonly {
              readonly key: string;
              readonly metadata: JsonObject;
              readonly payload: JsonObject;
              readonly schemaId: string;
              readonly source: string;
              readonly ttlMs: number;
          }[];
          readonly kind: "succeeded";
      };

const jobManualExposureSchema = v.picklist(
    ["cache-write", "jobs-write", "none"],
    "Job manual exposure is invalid"
);
const jobInitialDuePolicySchema = v.picklist(
    ["immediate", "next-occurrence"],
    "Job initial due policy is invalid"
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
    readonly commitCacheAttempt: (
        attempt: JobCacheAttemptCommit
    ) => Promise<JobCacheAttemptWriteResult>;
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
export interface JobActionDefinition {
    readonly actionKey: string;
    readonly actionPayload: JsonObject;
    readonly attemptLimit: number;
    readonly cancellationPolicy: JobCancellationPolicy;
    readonly defaultEnabled: boolean;
    readonly defaultSchedule: ScheduleConfiguration;
    readonly description: string;
    readonly displayName: string;
    readonly initialDue: JobInitialDuePolicy;
    readonly manualExposure: JobManualExposure;
    readonly priority: number;
    readonly resourceClass: JobResourceClass;
    readonly resourceKeys: readonly string[];
    readonly retrySafe: boolean;
    readonly scheduleId: string;
    readonly timeoutMs: number;
}

/** Worker-owned authority for one exact action definition. */
export type JobActionExecutor = (
    context: JobActionExecutionContext,
    payload: JsonObject
) => Effect.Effect<JobRunResult, unknown>;

/** Combined definition and executor accepted only at the worker composition boundary. */
export interface JobActionRegistration extends JobActionDefinition {
    readonly execute: JobActionExecutor;
}

/**
 * Validates one code-owned action and retains canonical schedule output.
 * @param registration Candidate release-owned action metadata.
 * @returns A frozen registration safe for reconciliation and execution.
 */
export function validateJobActionDefinition(
    definition: JobActionDefinition
): JobActionDefinition {
    v.parse(jobActionKeySchema, definition.actionKey);
    const actionPayload = v.parse(jobPayloadSchema, definition.actionPayload);
    v.parse(jobAttemptLimitSchema, definition.attemptLimit);
    v.parse(jobCancellationPolicySchema, definition.cancellationPolicy);
    v.parse(v.boolean("Job default-enabled flag is invalid"), definition.defaultEnabled);
    const defaultSchedule = v.parse(
        scheduleConfigurationSchema,
        definition.defaultSchedule
    );
    v.parse(jobDescriptionSchema, definition.description);
    v.parse(jobDisplayNameSchema, definition.displayName);
    v.parse(jobInitialDuePolicySchema, definition.initialDue);
    v.parse(jobPrioritySchema, definition.priority);
    v.parse(jobResourceClassSchema, definition.resourceClass);
    const resourceKeys = v.parse(jobResourceKeysSchema, definition.resourceKeys);
    v.parse(jobManualExposureSchema, definition.manualExposure);
    v.parse(v.boolean("Job retry-safe flag is invalid"), definition.retrySafe);
    v.parse(scheduleIdSchema, definition.scheduleId);
    v.parse(jobTimeoutSchema, definition.timeoutMs);
    return Object.freeze({
        ...definition,
        actionPayload: Object.freeze({ ...actionPayload }),
        defaultSchedule: Object.freeze({ ...defaultSchedule }),
        resourceKeys: Object.freeze([...resourceKeys]),
    });
}

/**
 * Validates a worker-only combined registration without publishing it to web code.
 * @param registration Candidate action definition and worker executor.
 * @returns A frozen, validated worker action registration.
 */
export function validateJobActionRegistration(
    registration: JobActionRegistration
): JobActionRegistration {
    const definition = validateJobActionDefinition(registration);
    v.parse(v.function("Job action executor is invalid"), registration.execute);
    return Object.freeze({ ...definition, execute: registration.execute });
}

const workerSmokeDefinition = validateJobActionDefinition({
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
    initialDue: "next-occurrence",
    manualExposure: "jobs-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["database"]),
    retrySafe: true,
    scheduleId: "system.worker-smoke",
    timeoutMs: 30_000,
});

const systemHostCacheDefinition = validateJobActionDefinition({
    actionKey: "cache.refresh.system-host",
    actionPayload: Object.freeze({ key: "system.host" }),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        intervalMs: 86_400_000,
        kind: "interval",
    }),
    description: "Projects bounded host, memory, and root-filesystem status.",
    displayName: "System host cache",
    initialDue: "immediate",
    manualExposure: "cache-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["cache.system.host"]),
    retrySafe: true,
    scheduleId: "cache.system-host",
    timeoutMs: 30_000,
});

/** Complete reviewed pure-definition registry for this slice. */
export const jobActionDefinitions = Object.freeze([
    systemHostCacheDefinition,
    workerSmokeDefinition,
]);

const definitionByKey = new Map(
    jobActionDefinitions.map((definition) => [definition.actionKey, definition])
);
if (definitionByKey.size !== jobActionDefinitions.length) {
    throw new Error("Job action definition registry contains duplicate action keys");
}
const definitionByScheduleId = new Map(
    jobActionDefinitions.map((definition) => [definition.scheduleId, definition])
);
if (definitionByScheduleId.size !== jobActionDefinitions.length) {
    throw new Error("Job action definition registry contains duplicate schedule IDs");
}

/**
 * Resolves one exact reviewed action.
 * @param actionKey Durable action identity.
 * @returns The action registration, when this release implements it.
 */
export function findJobActionDefinition(
    actionKey: string
): JobActionDefinition | undefined {
    return definitionByKey.get(actionKey);
}

/**
 * Checks that a durable schedule still belongs to the exact registered action.
 * @param scheduleId Durable schedule identity.
 * @param actionKey Durable action identity captured by the schedule.
 * @returns Whether this release owns the exact schedule/action pair.
 */
export function isRegisteredJobSchedule(scheduleId: string, actionKey: string): boolean {
    return definitionByScheduleId.get(scheduleId)?.actionKey === actionKey;
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
