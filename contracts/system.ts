import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

export const openClawVersionSummarySchema = v.strictObject({
    checkedAt: finiteNumberSchema,
    current: v.pipe(v.string(), v.nonEmpty()),
    hostError: v.optional(v.pipe(v.string(), v.nonEmpty())),
    latest: v.optional(v.pipe(v.string(), v.nonEmpty())),
    openclawError: v.optional(v.pipe(v.string(), v.nonEmpty())),
    updateAvailable: v.boolean(),
    updateStatusError: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

export const systemHostSummarySchema = v.strictObject({
    checkedAt: v.pipe(v.string(), v.isoTimestamp()),
    disk: v.strictObject({
        percent: finiteNumberSchema,
        totalBytes: finiteNumberSchema,
        usedBytes: finiteNumberSchema,
    }),
    hostname: v.pipe(v.string(), v.nonEmpty()),
    memory: v.strictObject({
        freeBytes: finiteNumberSchema,
        freeMb: finiteNumberSchema,
        totalBytes: finiteNumberSchema,
        usedBytes: finiteNumberSchema,
    }),
    platform: v.pipe(v.string(), v.nonEmpty()),
    uptimeSeconds: finiteNumberSchema,
    version: openClawVersionSummarySchema,
});

export type OpenClawVersionSummary = v.InferOutput<typeof openClawVersionSummarySchema>;
export type SystemHostSummary = v.InferOutput<typeof systemHostSummarySchema>;

/**
 * Parses the Dashboard-owned host and OpenClaw version summary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Dashboard-owned host and OpenClaw version summary.
 */
export function parseSystemHostSummary(
    value: unknown,
    path = "systemHost"
): SystemHostSummary {
    return parseContract(systemHostSummarySchema, value, path);
}
