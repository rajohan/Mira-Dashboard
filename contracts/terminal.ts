import * as v from "valibot";

import { parseContract, strictJsonObjectSchema } from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const terminalCompletionRequestSchema = strictJsonObjectSchema({
    cwd: v.optional(trimmedNonEmptyStringSchema),
    partial: v.string(),
});

export const terminalCompletionItemSchema = v.strictObject({
    completion: v.string(),
    display: v.string(),
    type: v.picklist(["directory", "executable", "file"]),
});

export const terminalCompletionResponseSchema = v.strictObject({
    commonPrefix: v.string(),
    completions: v.array(terminalCompletionItemSchema),
});

export const terminalCdRequestSchema = strictJsonObjectSchema({
    cwd: trimmedNonEmptyStringSchema,
    path: v.string(),
});

export const terminalCdResponseSchema = v.strictObject({
    newCwd: v.string(),
});

export type TerminalCompletionRequest = v.InferOutput<
    typeof terminalCompletionRequestSchema
>;
export type TerminalCompletionItem = v.InferOutput<typeof terminalCompletionItemSchema>;
export type TerminalCompletionResponse = v.InferOutput<
    typeof terminalCompletionResponseSchema
>;
export type TerminalCdRequest = v.InferOutput<typeof terminalCdRequestSchema>;
export type TerminalCdResponse = v.InferOutput<typeof terminalCdResponseSchema>;

export function parseTerminalCompletionRequest(
    value: unknown
): TerminalCompletionRequest {
    return parseContract(terminalCompletionRequestSchema, value);
}

export function parseTerminalCdRequest(value: unknown): TerminalCdRequest {
    return parseContract(terminalCdRequestSchema, value);
}

export function parseTerminalCompletionResponse(
    value: unknown
): TerminalCompletionResponse {
    return parseContract(terminalCompletionResponseSchema, value, "response");
}

export function parseTerminalCdResponse(value: unknown): TerminalCdResponse {
    return parseContract(terminalCdResponseSchema, value, "response");
}
