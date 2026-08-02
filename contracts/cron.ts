import * as v from "valibot";

import { jobDisableIntentRequestSchema, jobDisableIntentSchema } from "./jobs/scheduled";
import {
    jsonObjectSchema,
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const cronTaskLinkSchema = v.strictObject({
    number: nonNegativeIntegerSchema,
    title: trimmedNonEmptyStringSchema,
});

const cronExtensionRecordSchema = v.looseObject({
    kind: v.optional(v.string()),
});

/**
 * OpenClaw owns cron fields outside this known projection, so the parser
 * validates Dashboard-consumed fields and preserves extensions.
 */
export const cronJobSchema = v.looseObject({
    delivery: v.optional(
        v.looseObject({
            mode: v.optional(v.string()),
        })
    ),
    disableIntent: v.optional(jobDisableIntentSchema),
    enabled: v.optional(v.boolean()),
    id: v.optional(trimmedNonEmptyStringSchema),
    jobId: v.optional(trimmedNonEmptyStringSchema),
    name: v.optional(v.string()),
    payload: v.optional(cronExtensionRecordSchema),
    schedule: v.optional(cronExtensionRecordSchema),
    sessionTarget: v.optional(v.string()),
    state: v.optional(v.record(v.string(), v.unknown())),
    taskLinks: v.optional(v.array(cronTaskLinkSchema)),
});

export const cronJobsResponseSchema = v.strictObject({
    jobs: v.array(cronJobSchema),
});

export const cronMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    payload: v.optional(v.unknown()),
});

export const cronToggleRequestSchema = v.pipe(
    strictJsonObjectSchema({
        disableIntent: v.optional(jobDisableIntentRequestSchema),
        enabled: v.boolean(),
    }),
    v.check(
        (request) => !request.enabled || request.disableIntent === undefined,
        "disableIntent is only valid when disabling a job"
    )
);

export const cronUpdateRequestSchema = strictJsonObjectSchema({
    patch: jsonObjectSchema,
});

export type CronTaskLink = v.InferOutput<typeof cronTaskLinkSchema>;
export type CronJob = v.InferOutput<typeof cronJobSchema>;
export type CronJobsResponse = v.InferOutput<typeof cronJobsResponseSchema>;
export type CronMutationResponse = v.InferOutput<typeof cronMutationResponseSchema>;
export type CronToggleRequest = v.InferOutput<typeof cronToggleRequestSchema>;
export type CronUpdateRequest = v.InferOutput<typeof cronUpdateRequestSchema>;

/**
 * Parses a cron enabled-state change at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed cron enabled-state change.
 */
export function parseCronToggleRequest(value: unknown): CronToggleRequest {
    return parseContract(cronToggleRequestSchema, value);
}

/**
 * Parses an OpenClaw cron patch at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed OpenClaw cron patch.
 */
export function parseCronUpdateRequest(value: unknown): CronUpdateRequest {
    return parseContract(cronUpdateRequestSchema, value);
}

/**
 * Parses one OpenClaw cron job while preserving externally owned fields.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one OpenClaw cron job while preserving externally owned fields.
 */
export function parseCronJob(value: unknown, path = "cronJob"): CronJob {
    return parseContract(cronJobSchema, value, path);
}

/**
 * Parses the cron list returned by the Dashboard API.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cron list returned by the Dashboard API.
 */
export function parseCronJobsResponse(
    value: unknown,
    path = "cronJobs"
): CronJobsResponse {
    return parseContract(cronJobsResponseSchema, value, path);
}

/**
 * Parses the common result wrapper for cron mutations.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the common result wrapper for cron mutations.
 */
export function parseCronMutationResponse(
    value: unknown,
    path = "cronMutation"
): CronMutationResponse {
    return parseContract(cronMutationResponseSchema, value, path);
}
