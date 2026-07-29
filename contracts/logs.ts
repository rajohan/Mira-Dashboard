import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

export const logFileSchema = v.strictObject({
    modified: v.string(),
    name: v.pipe(v.string(), v.nonEmpty()),
    size: finiteNumberSchema,
});

const logContentSchema = v.strictObject({
    content: v.string(),
    lineIds: v.array(v.string()),
});

export const openClawLogFilesResponseSchema = v.strictObject({
    logs: v.array(logFileSchema),
    unavailableReason: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

export const openClawLogContentResponseSchema = v.strictObject({
    ...logContentSchema.entries,
    file: v.pipe(v.string(), v.nonEmpty()),
});

export const dashboardLogContentResponseSchema = v.strictObject({
    ...logContentSchema.entries,
    unavailableReason: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

export type LogFile = v.InferOutput<typeof logFileSchema>;
export type LogContent = v.InferOutput<typeof logContentSchema>;
export type OpenClawLogFilesResponse = v.InferOutput<
    typeof openClawLogFilesResponseSchema
>;
export type OpenClawLogContentResponse = v.InferOutput<
    typeof openClawLogContentResponseSchema
>;
export type DashboardLogContentResponse = v.InferOutput<
    typeof dashboardLogContentResponseSchema
>;

/**
 * Parses the OpenClaw log-file index at the browser trust boundary.
 * @param value Value to process.
 * @returns Parsed the OpenClaw log-file index at the browser trust boundary.
 */
export function parseOpenClawLogFilesResponse(value: unknown): OpenClawLogFilesResponse {
    return parseContract(openClawLogFilesResponseSchema, value, "logs");
}

/**
 * Parses an OpenClaw log snapshot at the browser trust boundary.
 * @param value Value to process.
 * @returns Parsed an OpenClaw log snapshot at the browser trust boundary.
 */
export function parseOpenClawLogContentResponse(
    value: unknown
): OpenClawLogContentResponse {
    return parseContract(openClawLogContentResponseSchema, value, "logContent");
}

/**
 * Parses a Dashboard journal snapshot at the browser trust boundary.
 * @param value Value to process.
 * @returns Parsed a Dashboard journal snapshot at the browser trust boundary.
 */
export function parseDashboardLogContentResponse(
    value: unknown
): DashboardLogContentResponse {
    return parseContract(dashboardLogContentResponseSchema, value, "dashboardLogs");
}
