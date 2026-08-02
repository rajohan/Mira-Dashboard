import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "../runtime";
import {
    type JobExecutionStatus,
    type JobExecutionTriggerType,
    jobExecutionStatusSchema,
    jobExecutionTriggerTypeSchema,
    jobResourceClassSchema,
    scheduledJobScheduleTypeSchema,
} from "./shared";

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

export function parseScheduledJobRun(
    value: unknown,
    path = "response.run"
): ScheduledJobRun {
    return parseContract(scheduledJobRunSchema, value, path);
}

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
