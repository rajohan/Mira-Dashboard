import * as v from "valibot";

import { finiteNumberSchema, parseContract, strictJsonObjectSchema } from "./runtime";

const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export const execRequestSchema = strictJsonObjectSchema({
    args: v.optional(v.array(v.string())),
    command: nonBlankStringSchema,
    cwd: v.optional(v.string()),
    shell: v.optional(v.boolean()),
});

export const execResponseSchema = v.strictObject({
    code: v.optional(finiteNumberSchema),
    stderr: v.string(),
    stdout: v.string(),
});

export const execStartResponseSchema = v.strictObject({
    jobId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
});

export const execJobStatusSchema = v.picklist(["done", "running", "signaled"]);

export const execJobResponseSchema = v.strictObject({
    ...execResponseSchema.entries,
    endedAt: v.optional(finiteNumberSchema),
    jobId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    startedAt: finiteNumberSchema,
    status: execJobStatusSchema,
});

export const execStopResponseSchema = v.strictObject({
    isSuccess: v.boolean(),
    message: v.string(),
});

export type ExecRequest = v.InferOutput<typeof execRequestSchema>;
export type ExecResponse = v.InferOutput<typeof execResponseSchema>;
export type ExecStartResponse = v.InferOutput<typeof execStartResponseSchema>;
export type ExecJobStatus = v.InferOutput<typeof execJobStatusSchema>;
export type ExecJobResponse = v.InferOutput<typeof execJobResponseSchema>;
export type ExecStopResponse = v.InferOutput<typeof execStopResponseSchema>;

/**
 * Parses the transport shape before service-level command authorization.
 * @param value Value to process.
 * @returns Parsed the transport shape before service-level command authorization.
 */
export function parseExecRequest(value: unknown): ExecRequest {
    return parseContract(execRequestSchema, value);
}

export function parseExecResponse(value: unknown): ExecResponse {
    return parseContract(execResponseSchema, value, "response");
}

export function parseExecStartResponse(value: unknown): ExecStartResponse {
    return parseContract(execStartResponseSchema, value, "response");
}

export function parseExecJobResponse(value: unknown): ExecJobResponse {
    return parseContract(execJobResponseSchema, value, "response");
}

export function parseExecStopResponse(value: unknown): ExecStopResponse {
    return parseContract(execStopResponseSchema, value, "response");
}
