import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const SCHEDULE_TYPES = ["interval", "daily", "cron"] as const;
export const JOB_EXECUTION_STATUSES = [
    "queued",
    "running",
    "success",
    "failed",
    "cancelled",
] as const;
export const JOB_EXECUTION_TRIGGER_TYPES = [
    "manual",
    "schedule",
    "startup",
    "system",
] as const;
export const JOB_RESOURCE_CLASSES = [
    "interactive",
    "light",
    "network",
    "host-heavy",
    "exclusive",
] as const;

export const jobResourceClassSchema = v.picklist(JOB_RESOURCE_CLASSES);
export const jobExecutionStatusSchema = v.picklist(JOB_EXECUTION_STATUSES);
export const jobExecutionTriggerTypeSchema = v.picklist(JOB_EXECUTION_TRIGGER_TYPES);
export const scheduledJobScheduleTypeSchema = v.picklist(SCHEDULE_TYPES);

const requestCommentSchema = v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(1000)
);
const normalizedTimestampSchema = v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.check((value) => !Number.isNaN(Date.parse(value)), "must be a valid timestamp"),
    v.transform((value) => new Date(value).toISOString())
);

export const jobDisableIntentSchema = v.variant("mode", [
    v.strictObject({
        comment: v.string(),
        mode: v.literal("indefinite"),
    }),
    v.strictObject({
        comment: v.string(),
        mode: v.literal("until"),
        until: v.string(),
    }),
]);

export const jobDisableIntentRequestSchema = v.variant("mode", [
    v.strictObject({
        comment: requestCommentSchema,
        mode: v.literal("indefinite"),
    }),
    v.strictObject({
        comment: requestCommentSchema,
        mode: v.literal("until"),
        until: normalizedTimestampSchema,
    }),
]);

export const jobExecutionSchema = v.strictObject({
    actionKey: v.string(),
    attempt: finiteNumberSchema,
    availableAt: v.string(),
    cancelRequestedAt: v.optional(v.string()),
    cancellable: v.boolean(),
    displayName: v.string(),
    finishedAt: v.optional(v.string()),
    heartbeatAt: v.optional(v.string()),
    id: v.string(),
    message: v.optional(v.string()),
    output: v.optional(jsonObjectSchema),
    queuedAt: v.string(),
    resourceClass: jobResourceClassSchema,
    scheduledJobId: v.optional(v.string()),
    scheduledRunId: v.optional(finiteNumberSchema),
    startedAt: v.optional(v.string()),
    status: jobExecutionStatusSchema,
    triggerType: jobExecutionTriggerTypeSchema,
});

export const jobExecutionSummarySchema = v.strictObject({
    activeResourceClasses: v.array(jobResourceClassSchema),
    claimsPaused: v.optional(v.boolean()),
    claimsPausedAt: v.optional(v.string()),
    oldestQueuedAgeMs: v.optional(finiteNumberSchema),
    oldestQueuedAt: v.optional(v.string()),
    queued: finiteNumberSchema,
    running: finiteNumberSchema,
    workerCapacity: finiteNumberSchema,
    workerCount: finiteNumberSchema,
    workerLastHeartbeatAt: v.optional(v.string()),
    workerOnline: v.boolean(),
});

export const jobExecutionsResponseSchema = v.strictObject({
    executions: v.array(jobExecutionSchema),
    summary: jobExecutionSummarySchema,
});

export const jobExecutionResponseSchema = v.strictObject({
    execution: jobExecutionSchema,
});

export const jobExecutionCancelResponseSchema = v.strictObject({
    execution: jobExecutionSchema,
    isOk: successLiteralSchema,
});

export const jobWorkerClaimsPatchSchema = strictJsonObjectSchema({
    paused: v.boolean(),
});

export const jobWorkerClaimsStateSchema = v.strictObject({
    paused: v.boolean(),
    updatedAt: v.string(),
});

export const jobWorkerClaimsMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    state: jobWorkerClaimsStateSchema,
});

export const scheduledJobRunSchema = v.strictObject({
    cancelRequestedAt: v.optional(v.string()),
    cancellable: v.boolean(),
    executionId: v.optional(v.string()),
    finishedAt: v.optional(v.string()),
    id: finiteNumberSchema,
    jobId: v.string(),
    message: v.optional(v.string()),
    output: jsonObjectSchema,
    queuedAt: v.string(),
    resourceClass: jobResourceClassSchema,
    startedAt: v.string(),
    status: jobExecutionStatusSchema,
    triggerType: jobExecutionTriggerTypeSchema,
});

export const scheduledJobSchema = v.strictObject({
    actionKey: v.string(),
    actionPayload: jsonObjectSchema,
    createdAt: v.string(),
    cronExpression: v.optional(v.string()),
    description: v.string(),
    disableIntent: v.optional(jobDisableIntentSchema),
    enabled: v.boolean(),
    id: v.string(),
    intervalSeconds: finiteNumberSchema,
    isQueued: v.boolean(),
    isRunning: v.boolean(),
    lastRun: v.optional(scheduledJobRunSchema),
    name: v.string(),
    nextRunAt: v.optional(v.string()),
    resourceClass: jobResourceClassSchema,
    scheduleType: scheduledJobScheduleTypeSchema,
    timeOfDay: v.optional(v.string()),
    timeoutMs: finiteNumberSchema,
    updatedAt: v.string(),
});

export const scheduledJobPatchSchema = strictJsonObjectSchema({
    cronExpression: v.optional(v.nullable(v.string())),
    disableIntent: v.optional(v.nullable(jobDisableIntentRequestSchema)),
    enabled: v.optional(v.boolean()),
    intervalSeconds: v.optional(finiteNumberSchema),
    scheduleType: v.optional(scheduledJobScheduleTypeSchema),
    timeOfDay: v.optional(v.nullable(v.string())),
});

export const scheduledJobUpdateRequestSchema = strictJsonObjectSchema({
    patch: scheduledJobPatchSchema,
});

export const scheduledJobsResponseSchema = v.strictObject({
    jobs: v.array(scheduledJobSchema),
});

export const scheduledJobResponseSchema = v.strictObject({
    job: scheduledJobSchema,
});

export const scheduledJobMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    job: scheduledJobSchema,
});

export const scheduledJobRunsResponseSchema = v.strictObject({
    runs: v.array(scheduledJobRunSchema),
});

export const scheduledJobRunResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    run: scheduledJobRunSchema,
});

export type JobDisableIntent = v.InferOutput<typeof jobDisableIntentSchema>;
export type JobResourceClass = v.InferOutput<typeof jobResourceClassSchema>;
export type JobExecutionStatus = v.InferOutput<typeof jobExecutionStatusSchema>;
export type JobExecutionTriggerType = v.InferOutput<typeof jobExecutionTriggerTypeSchema>;
export type JobExecution = v.InferOutput<typeof jobExecutionSchema>;
export type JobExecutionSummary = v.InferOutput<typeof jobExecutionSummarySchema>;
export type JobExecutionsResponse = v.InferOutput<typeof jobExecutionsResponseSchema>;
export type JobExecutionResponse = v.InferOutput<typeof jobExecutionResponseSchema>;
export type JobExecutionCancelResponse = v.InferOutput<
    typeof jobExecutionCancelResponseSchema
>;
export type JobWorkerClaimsPatch = v.InferOutput<typeof jobWorkerClaimsPatchSchema>;
export type JobWorkerClaimsState = v.InferOutput<typeof jobWorkerClaimsStateSchema>;
export type JobWorkerClaimsMutationResponse = v.InferOutput<
    typeof jobWorkerClaimsMutationResponseSchema
>;
export type ScheduledJobScheduleType = v.InferOutput<
    typeof scheduledJobScheduleTypeSchema
>;
export type ScheduledJobRunStatus = JobExecutionStatus;
export type ScheduledJobTriggerType = JobExecutionTriggerType;
export type ScheduledJob = v.InferOutput<typeof scheduledJobSchema>;
export type ScheduledJobRun = v.InferOutput<typeof scheduledJobRunSchema>;
export type ScheduledJobPatch = v.InferOutput<typeof scheduledJobPatchSchema>;
export type ScheduledJobUpdateRequest = v.InferOutput<
    typeof scheduledJobUpdateRequestSchema
>;
export type ScheduledJobsResponse = v.InferOutput<typeof scheduledJobsResponseSchema>;
export type ScheduledJobResponse = v.InferOutput<typeof scheduledJobResponseSchema>;
export type ScheduledJobMutationResponse = v.InferOutput<
    typeof scheduledJobMutationResponseSchema
>;
export type ScheduledJobRunsResponse = v.InferOutput<
    typeof scheduledJobRunsResponseSchema
>;
export type ScheduledJobRunResponse = v.InferOutput<typeof scheduledJobRunResponseSchema>;

export function parseJobDisableIntent(
    value: unknown,
    path = "body.patch.disableIntent"
): JobDisableIntent {
    return parseContract(jobDisableIntentRequestSchema, value, path);
}

export function parseScheduledJobUpdateRequest(
    value: unknown
): ScheduledJobUpdateRequest {
    return parseContract(scheduledJobUpdateRequestSchema, value);
}

/**
 * Parses one public queue execution returned by the backend.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one public queue execution returned by the backend.
 */
export function parseJobExecution(
    value: unknown,
    path = "response.execution"
): JobExecution {
    return parseContract(jobExecutionSchema, value, path);
}

/**
 * Parses the low-cardinality queue summary shared by jobs and metrics.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the low-cardinality queue summary shared by jobs and metrics.
 */
export function parseJobExecutionSummary(
    value: unknown,
    path = "response.summary"
): JobExecutionSummary {
    return parseContract(jobExecutionSummarySchema, value, path);
}

export function parseJobExecutionsResponse(value: unknown): JobExecutionsResponse {
    return parseContract(jobExecutionsResponseSchema, value, "response");
}

export function parseJobExecutionResponse(value: unknown): JobExecutionResponse {
    return parseContract(jobExecutionResponseSchema, value, "response");
}

export function parseJobExecutionCancelResponse(
    value: unknown
): JobExecutionCancelResponse {
    return parseContract(jobExecutionCancelResponseSchema, value, "response");
}

export function parseJobWorkerClaimsPatch(value: unknown): JobWorkerClaimsPatch {
    return parseContract(jobWorkerClaimsPatchSchema, value);
}

export function parseJobWorkerClaimsMutationResponse(
    value: unknown
): JobWorkerClaimsMutationResponse {
    return parseContract(jobWorkerClaimsMutationResponseSchema, value, "response");
}

/**
 * Parses one scheduled run, including its bounded public output object.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one scheduled run, including its bounded public output object.
 */
export function parseScheduledJobRun(
    value: unknown,
    path = "response.run"
): ScheduledJobRun {
    return parseContract(scheduledJobRunSchema, value, path);
}

/**
 * Parses one scheduled job returned by list, detail, or mutation routes.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one scheduled job returned by list, detail, or mutation routes.
 */
export function parseScheduledJob(value: unknown, path = "response.job"): ScheduledJob {
    return parseContract(scheduledJobSchema, value, path);
}

export function parseScheduledJobsResponse(value: unknown): ScheduledJobsResponse {
    return parseContract(scheduledJobsResponseSchema, value, "response");
}

export function parseScheduledJobResponse(value: unknown): ScheduledJobResponse {
    return parseContract(scheduledJobResponseSchema, value, "response");
}

export function parseScheduledJobMutationResponse(
    value: unknown
): ScheduledJobMutationResponse {
    return parseContract(scheduledJobMutationResponseSchema, value, "response");
}

export function parseScheduledJobRunsResponse(value: unknown): ScheduledJobRunsResponse {
    return parseContract(scheduledJobRunsResponseSchema, value, "response");
}

export function parseScheduledJobRunResponse(value: unknown): ScheduledJobRunResponse {
    return parseContract(scheduledJobRunResponseSchema, value, "response");
}
