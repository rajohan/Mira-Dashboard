import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "../runtime";

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

export const dockerContainersResponseSchema = v.strictObject({
    containers: v.array(dockerContainerSchema),
    mode: v.picklist(["isolated", "live"]),
});

export const dockerContainerLogsResponseSchema = v.strictObject({
    content: v.string(),
});

export type DockerContainerStats = v.InferOutput<typeof dockerContainerStatsSchema>;
export type DockerMount = v.InferOutput<typeof dockerMountSchema>;
export type DockerContainer = v.InferOutput<typeof dockerContainerSchema>;
export type DockerContainerDetails = v.InferOutput<typeof dockerContainerDetailsSchema>;
export type DockerImage = v.InferOutput<typeof dockerImageSchema>;
export type DockerVolume = v.InferOutput<typeof dockerVolumeSchema>;
export type DockerContainersResponse = v.InferOutput<
    typeof dockerContainersResponseSchema
>;
export type DockerContainerLogsResponse = v.InferOutput<
    typeof dockerContainerLogsResponseSchema
>;

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
