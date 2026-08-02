import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    successLiteralSchema,
} from "../runtime";
import {
    jobExecutionStatusSchema,
    jobExecutionTriggerTypeSchema,
    jobResourceClassSchema,
} from "./shared";

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

export type JobExecution = v.InferOutput<typeof jobExecutionSchema>;
export type JobExecutionSummary = v.InferOutput<typeof jobExecutionSummarySchema>;
export type JobExecutionsResponse = v.InferOutput<typeof jobExecutionsResponseSchema>;
export type JobExecutionResponse = v.InferOutput<typeof jobExecutionResponseSchema>;
export type JobExecutionCancelResponse = v.InferOutput<
    typeof jobExecutionCancelResponseSchema
>;

export function parseJobExecution(
    value: unknown,
    path = "response.execution"
): JobExecution {
    return parseContract(jobExecutionSchema, value, path);
}

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
