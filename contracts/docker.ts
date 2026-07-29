import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    strictJsonObjectSchema,
} from "./runtime";

const stringRecordSchema = v.record(v.string(), v.string());
const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const dockerContainerStatsSchema = v.strictObject({
    blockIO: v.string(),
    cpu: v.string(),
    id: v.optional(v.string()),
    memory: v.string(),
    memoryPercent: v.string(),
    netIO: v.string(),
    pids: v.string(),
});

export const dockerMountSchema = v.strictObject({
    destination: v.string(),
    mode: v.string(),
    name: v.optional(v.string()),
    readOnly: v.boolean(),
    source: v.string(),
    type: v.string(),
});

export const dockerContainerSchema = v.strictObject({
    command: v.string(),
    createdAt: v.string(),
    finishedAt: v.optional(v.string()),
    health: v.string(),
    id: trimmedNonEmptyStringSchema,
    image: v.string(),
    imageId: v.string(),
    ipAddresses: stringRecordSchema,
    mounts: v.array(dockerMountSchema),
    name: trimmedNonEmptyStringSchema,
    ports: v.array(v.string()),
    project: v.optional(v.string()),
    restartCount: finiteNumberSchema,
    runningFor: v.string(),
    service: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    state: v.string(),
    stats: v.optional(dockerContainerStatsSchema),
    status: v.string(),
});

export const dockerContainerDetailsSchema = v.strictObject({
    ...dockerContainerSchema.entries,
    env: v.array(v.string()),
    labels: stringRecordSchema,
    networks: v.array(
        v.strictObject({
            gateway: v.string(),
            ipAddress: v.string(),
            macAddress: v.string(),
            name: trimmedNonEmptyStringSchema,
        })
    ),
});

export const dockerImageSchema = v.strictObject({
    containerName: v.string(),
    createdAt: v.string(),
    id: trimmedNonEmptyStringSchema,
    inUseBy: v.array(v.string()),
    lastTagTime: v.string(),
    platform: v.string(),
    repository: v.string(),
    size: finiteNumberSchema,
    tag: v.string(),
});

export const dockerVolumeSchema = v.strictObject({
    driver: v.string(),
    labels: stringRecordSchema,
    mountpoint: v.string(),
    name: trimmedNonEmptyStringSchema,
    scope: v.string(),
    size: v.string(),
    usedBy: v.array(v.string()),
});

export const dockerExecJobSchema = v.strictObject({
    code: v.optional(finiteNumberSchema),
    containerId: trimmedNonEmptyStringSchema,
    endedAt: v.optional(finiteNumberSchema),
    jobId: trimmedNonEmptyStringSchema,
    startedAt: finiteNumberSchema,
    status: v.picklist(["done", "running"]),
    stderr: v.string(),
    stdout: v.string(),
});

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

export const dockerSummaryCacheSchema = v.strictObject({
    checkedAt: trimmedNonEmptyStringSchema,
    containers: v.array(dockerContainerSchema),
    images: v.array(dockerImageSchema),
    updaterEvents: v.array(dockerUpdaterEventSchema),
    updaterServices: v.array(dockerUpdaterServiceSchema),
    updaterSummary: dockerUpdaterSummarySchema,
    volumes: v.array(dockerVolumeSchema),
});

export const dockerContainersResponseSchema = v.strictObject({
    containers: v.array(dockerContainerSchema),
    mode: v.picklist(["isolated", "live"]),
});
export const dockerContainerLogsResponseSchema = v.strictObject({
    content: v.string(),
});
export const dockerOutputResponseSchema = v.strictObject({
    output: v.string(),
});
export const dockerSuccessResponseSchema = v.strictObject({
    isSuccess: v.boolean(),
});
export const dockerPruneResponseSchema = v.strictObject({
    isSuccess: v.boolean(),
    output: v.string(),
});
export const dockerExecStartResponseSchema = v.strictObject({
    jobId: trimmedNonEmptyStringSchema,
});

const dockerIdentifierSchema = v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
);

export const dockerContainerActionSchema = v.picklist(["restart", "start", "stop"]);
export const dockerContainerActionRequestSchema = strictJsonObjectSchema({
    action: dockerContainerActionSchema,
});

export const dockerStackActionRequestSchema = strictJsonObjectSchema({
    action: dockerContainerActionSchema,
    service: v.optional(dockerIdentifierSchema),
});

export const dockerExecStartRequestSchema = strictJsonObjectSchema({
    command: v.pipe(
        v.string(),
        v.check((value) => value.trim().length > 0, "must not be blank")
    ),
    containerId: dockerIdentifierSchema,
});

export const dockerPruneRequestSchema = strictJsonObjectSchema({
    target: v.picklist(["images", "volumes"]),
});

export type DockerContainerStats = v.InferOutput<typeof dockerContainerStatsSchema>;
export type DockerMount = v.InferOutput<typeof dockerMountSchema>;
export type DockerContainer = v.InferOutput<typeof dockerContainerSchema>;
export type DockerContainerDetails = v.InferOutput<typeof dockerContainerDetailsSchema>;
export type DockerImage = v.InferOutput<typeof dockerImageSchema>;
export type DockerVolume = v.InferOutput<typeof dockerVolumeSchema>;
export type DockerExecJob = v.InferOutput<typeof dockerExecJobSchema>;
export type DockerUpdaterService = v.InferOutput<typeof dockerUpdaterServiceSchema>;
export type DockerUpdaterEvent = v.InferOutput<typeof dockerUpdaterEventSchema>;
export type DockerUpdaterSummary = v.InferOutput<typeof dockerUpdaterSummarySchema>;
export type DockerUpdaterRunStep = v.InferOutput<typeof dockerUpdaterRunStepSchema>;
export type DockerUpdaterRunResult = v.InferOutput<typeof dockerUpdaterRunResultSchema>;
export type DockerManualUpdateResult = v.InferOutput<
    typeof dockerManualUpdateResultSchema
>;
export type DockerSummaryCache = v.InferOutput<typeof dockerSummaryCacheSchema>;
export type DockerContainersResponse = v.InferOutput<
    typeof dockerContainersResponseSchema
>;
export type DockerContainerLogsResponse = v.InferOutput<
    typeof dockerContainerLogsResponseSchema
>;
export type DockerOutputResponse = v.InferOutput<typeof dockerOutputResponseSchema>;
export type DockerSuccessResponse = v.InferOutput<typeof dockerSuccessResponseSchema>;
export type DockerPruneResponse = v.InferOutput<typeof dockerPruneResponseSchema>;
export type DockerExecStartResponse = v.InferOutput<typeof dockerExecStartResponseSchema>;
export type DockerContainerAction = v.InferOutput<typeof dockerContainerActionSchema>;
export type DockerContainerActionRequest = v.InferOutput<
    typeof dockerContainerActionRequestSchema
>;
export type DockerStackActionRequest = v.InferOutput<
    typeof dockerStackActionRequestSchema
>;
export type DockerExecStartRequest = v.InferOutput<typeof dockerExecStartRequestSchema>;
export type DockerPruneRequest = v.InferOutput<typeof dockerPruneRequestSchema>;

/**
 * Parses a Docker container action at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed Docker container action.
 */
export function parseDockerContainerActionRequest(
    value: unknown
): DockerContainerActionRequest {
    return parseContract(dockerContainerActionRequestSchema, value);
}

/**
 * Parses a Docker stack action at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed Docker stack action.
 */
export function parseDockerStackActionRequest(value: unknown): DockerStackActionRequest {
    return parseContract(dockerStackActionRequestSchema, value);
}

/**
 * Parses a Docker exec request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed Docker exec request.
 */
export function parseDockerExecStartRequest(value: unknown): DockerExecStartRequest {
    return parseContract(dockerExecStartRequestSchema, value);
}

/**
 * Parses a Docker prune request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed Docker prune request.
 */
export function parseDockerPruneRequest(value: unknown): DockerPruneRequest {
    return parseContract(dockerPruneRequestSchema, value);
}

/**
 * Parses one Docker container API summary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Docker container API summary.
 */
export function parseDockerContainer(
    value: unknown,
    path = "dockerContainer"
): DockerContainer {
    return parseContract(dockerContainerSchema, value, path);
}

export function parseDockerContainerDetails(
    value: unknown,
    path = "dockerContainerDetails"
): DockerContainerDetails {
    return parseContract(dockerContainerDetailsSchema, value, path);
}

/**
 * Parses a queued Docker exec result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a queued Docker exec result.
 */
export function parseDockerExecJob(
    value: unknown,
    path = "dockerExecJob"
): DockerExecJob {
    return parseContract(dockerExecJobSchema, value, path);
}

/**
 * Parses the cached Docker overview payload.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cached Docker overview payload.
 */
export function parseDockerSummaryCache(
    value: unknown,
    path = "dockerSummary"
): DockerSummaryCache {
    return parseContract(dockerSummaryCacheSchema, value, path);
}

export function parseDockerContainersResponse(
    value: unknown,
    path = "dockerContainers"
): DockerContainersResponse {
    return parseContract(dockerContainersResponseSchema, value, path);
}

export function parseDockerContainerLogsResponse(
    value: unknown,
    path = "dockerContainerLogs"
): DockerContainerLogsResponse {
    return parseContract(dockerContainerLogsResponseSchema, value, path);
}

/**
 * Parses a Docker action output wrapper.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a Docker action output wrapper.
 */
export function parseDockerOutputResponse(
    value: unknown,
    path = "dockerOutput"
): DockerOutputResponse {
    return parseContract(dockerOutputResponseSchema, value, path);
}

/**
 * Parses the common Docker mutation result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the common Docker mutation result.
 */
export function parseDockerSuccessResponse(
    value: unknown,
    path = "dockerMutation"
): DockerSuccessResponse {
    return parseContract(dockerSuccessResponseSchema, value, path);
}

/**
 * Parses a Docker prune result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a Docker prune result.
 */
export function parseDockerPruneResponse(
    value: unknown,
    path = "dockerPrune"
): DockerPruneResponse {
    return parseContract(dockerPruneResponseSchema, value, path);
}

/**
 * Parses the identifier returned when a Docker exec job starts.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the identifier returned when a Docker exec job starts.
 */
export function parseDockerExecStartResponse(
    value: unknown,
    path = "dockerExecStart"
): DockerExecStartResponse {
    return parseContract(dockerExecStartResponseSchema, value, path);
}

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
