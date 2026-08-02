import * as v from "valibot";

import { finiteNumberSchema, jsonObjectSchema, parseContract } from "../runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const dockerUpdaterServiceSchema = v.strictObject({
    appSlug: trimmedNonEmptyStringSchema,
    composeImageRef: v.optional(v.string()),
    currentDigest: v.optional(v.string()),
    currentTag: v.optional(v.string()),
    enabled: v.boolean(),
    id: finiteNumberSchema,
    imageRepo: trimmedNonEmptyStringSchema,
    lastCheckedAt: v.optional(v.string()),
    lastStatus: v.optional(v.string()),
    lastUpdatedAt: v.optional(v.string()),
    latestDigest: v.optional(v.string()),
    latestTag: v.optional(v.string()),
    metadata: jsonObjectSchema,
    pinMode: trimmedNonEmptyStringSchema,
    policy: trimmedNonEmptyStringSchema,
    serviceName: trimmedNonEmptyStringSchema,
    updateAvailable: v.boolean(),
});

export const dockerUpdaterEventSchema = v.strictObject({
    appSlug: v.string(),
    createdAt: trimmedNonEmptyStringSchema,
    eventType: trimmedNonEmptyStringSchema,
    fromDigest: v.optional(v.string()),
    fromTag: v.optional(v.string()),
    id: finiteNumberSchema,
    managedServiceId: v.optional(finiteNumberSchema),
    message: v.optional(v.string()),
    serviceName: v.string(),
    toDigest: v.optional(v.string()),
    toTag: v.optional(v.string()),
});

export const dockerUpdaterSummarySchema = v.strictObject({
    autoPolicy: finiteNumberSchema,
    enabled: finiteNumberSchema,
    failed: finiteNumberSchema,
    notifyPolicy: finiteNumberSchema,
    total: finiteNumberSchema,
    updateAvailable: finiteNumberSchema,
});

export const dockerUpdaterRunStepSchema = v.strictObject({
    changedPaths: v.optional(v.array(v.string())),
    code: v.optional(
        v.picklist(["CONFLICT", "DISABLED", "NOT_FOUND", "UNSUPPORTED_REGISTRY"])
    ),
    isOk: v.boolean(),
    stderr: v.string(),
    stdout: v.string(),
    step: trimmedNonEmptyStringSchema,
});

export const dockerUpdaterRunResultSchema = v.strictObject({
    isSuccess: v.boolean(),
    steps: v.array(dockerUpdaterRunStepSchema),
});

export const dockerManualUpdateResultSchema = v.strictObject({
    isSuccess: v.boolean(),
    result: v.strictObject({
        failed: v.array(dockerUpdaterRunStepSchema),
        serviceId: finiteNumberSchema,
        summary: v.strictObject({
            failed: finiteNumberSchema,
            updated: finiteNumberSchema,
        }),
        updated: v.array(finiteNumberSchema),
    }),
    service: v.optional(dockerUpdaterServiceSchema),
    stderr: v.string(),
});

export type DockerUpdaterService = v.InferOutput<typeof dockerUpdaterServiceSchema>;
export type DockerUpdaterEvent = v.InferOutput<typeof dockerUpdaterEventSchema>;
export type DockerUpdaterSummary = v.InferOutput<typeof dockerUpdaterSummarySchema>;
export type DockerUpdaterRunStep = v.InferOutput<typeof dockerUpdaterRunStepSchema>;
export type DockerUpdaterRunResult = v.InferOutput<typeof dockerUpdaterRunResultSchema>;
export type DockerManualUpdateResult = v.InferOutput<
    typeof dockerManualUpdateResultSchema
>;

export function parseDockerUpdaterRunResult(
    value: unknown,
    path = "dockerUpdaterRun"
): DockerUpdaterRunResult {
    return parseContract(dockerUpdaterRunResultSchema, value, path);
}

export function parseDockerManualUpdateResult(
    value: unknown,
    path = "dockerManualUpdate"
): DockerManualUpdateResult {
    return parseContract(dockerManualUpdateResultSchema, value, path);
}
