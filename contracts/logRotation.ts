import * as v from "valibot";

import { nonNegativeIntegerSchema, parseContract } from "./runtime";

export const logRotationGroupSummarySchema = v.strictObject({
    checkedFiles: nonNegativeIntegerSchema,
    compressedFiles: nonNegativeIntegerSchema,
    deletedArchives: nonNegativeIntegerSchema,
    name: v.pipe(v.string(), v.nonEmpty()),
    rotatedFiles: nonNegativeIntegerSchema,
    skippedFiles: nonNegativeIntegerSchema,
});

export const logRotationSummarySchema = v.strictObject({
    checkedFiles: nonNegativeIntegerSchema,
    checkedGroups: nonNegativeIntegerSchema,
    compressedFiles: nonNegativeIntegerSchema,
    deletedArchives: nonNegativeIntegerSchema,
    errors: v.array(v.unknown()),
    finishedAt: v.optional(v.string()),
    groups: v.array(logRotationGroupSummarySchema),
    isDryRun: v.boolean(),
    isOk: v.boolean(),
    rotatedFiles: nonNegativeIntegerSchema,
    skippedFiles: nonNegativeIntegerSchema,
    startedAt: v.string(),
    warnings: v.array(v.unknown()),
});

export const logRotationRunResultSchema = v.strictObject({
    isSuccess: v.boolean(),
    result: logRotationSummarySchema,
    stderr: v.string(),
});

export const logRotationStatusSchema = v.strictObject({
    isSuccess: v.boolean(),
    lastRun: v.optional(logRotationSummarySchema),
});

export type LogRotationGroupSummary = v.InferOutput<typeof logRotationGroupSummarySchema>;
export type LogRotationSummary = v.InferOutput<typeof logRotationSummarySchema>;
export type LogRotationRunResult = v.InferOutput<typeof logRotationRunResultSchema>;
export type LogRotationStatus = v.InferOutput<typeof logRotationStatusSchema>;

/**
 * Parses one complete log-rotation summary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one complete log-rotation summary.
 */
export function parseLogRotationSummary(
    value: unknown,
    path = "logRotation"
): LogRotationSummary {
    return parseContract(logRotationSummarySchema, value, path);
}

/**
 * Parses the authenticated log-rotation status response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the authenticated log-rotation status response.
 */
export function parseLogRotationStatus(
    value: unknown,
    path = "logRotationStatus"
): LogRotationStatus {
    return parseContract(logRotationStatusSchema, value, path);
}

/**
 * Parses a manual or dry-run log-rotation response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a manual or dry-run log-rotation response.
 */
export function parseLogRotationRunResult(
    value: unknown,
    path = "logRotationRun"
): LogRotationRunResult {
    return parseContract(logRotationRunResultSchema, value, path);
}
