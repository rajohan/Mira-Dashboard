import * as v from "valibot";

import { finiteNumberSchema, parseContract, strictJsonObjectSchema } from "../runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

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

export type DockerExecJob = v.InferOutput<typeof dockerExecJobSchema>;
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

export function parseDockerContainerActionRequest(
    value: unknown
): DockerContainerActionRequest {
    return parseContract(dockerContainerActionRequestSchema, value);
}

export function parseDockerStackActionRequest(value: unknown): DockerStackActionRequest {
    return parseContract(dockerStackActionRequestSchema, value);
}

export function parseDockerExecStartRequest(value: unknown): DockerExecStartRequest {
    return parseContract(dockerExecStartRequestSchema, value);
}

export function parseDockerPruneRequest(value: unknown): DockerPruneRequest {
    return parseContract(dockerPruneRequestSchema, value);
}

export function parseDockerExecJob(
    value: unknown,
    path = "dockerExecJob"
): DockerExecJob {
    return parseContract(dockerExecJobSchema, value, path);
}

export function parseDockerOutputResponse(
    value: unknown,
    path = "dockerOutput"
): DockerOutputResponse {
    return parseContract(dockerOutputResponseSchema, value, path);
}

export function parseDockerSuccessResponse(
    value: unknown,
    path = "dockerMutation"
): DockerSuccessResponse {
    return parseContract(dockerSuccessResponseSchema, value, path);
}

export function parseDockerPruneResponse(
    value: unknown,
    path = "dockerPrune"
): DockerPruneResponse {
    return parseContract(dockerPruneResponseSchema, value, path);
}

export function parseDockerExecStartResponse(
    value: unknown,
    path = "dockerExecStart"
): DockerExecStartResponse {
    return parseContract(dockerExecStartResponseSchema, value, path);
}
