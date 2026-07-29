import * as v from "valibot";

import {
    jsonObjectSchema,
    nonNegativeIntegerSchema,
    parseContract,
    positiveIntegerSchema,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const REPORT_TYPES = [
    "daily_brief",
    "daily_summary",
    "heartbeat",
    "custom",
] as const;
export const REPORT_STATUSES = ["ok", "warning", "error"] as const;

export const reportTypeSchema = v.picklist(REPORT_TYPES);
export const reportStatusSchema = v.picklist(REPORT_STATUSES);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);
const normalizedTimestampSchema = v.pipe(
    v.string(),
    v.check((value) => !Number.isNaN(Date.parse(value)), "must be a valid timestamp"),
    v.transform((value) => new Date(value).toISOString())
);

export const reportSchema = v.strictObject({
    bodyMd: v.string(),
    createdAt: nonBlankStringSchema,
    dedupeKey: v.optional(v.string()),
    id: positiveIntegerSchema,
    metadata: jsonObjectSchema,
    occurredAt: nonBlankStringSchema,
    source: v.optional(v.string()),
    sourceJobId: v.optional(v.string()),
    status: reportStatusSchema,
    summary: v.string(),
    title: v.string(),
    type: reportTypeSchema,
    updatedAt: nonBlankStringSchema,
});

const reportCreateRequestSchema = strictJsonObjectSchema({
    bodyMd: nonBlankStringSchema,
    dedupeKey: v.optional(trimmedNonEmptyStringSchema),
    metadata: v.optional(jsonObjectSchema),
    notify: v.optional(v.boolean()),
    occurredAt: v.optional(normalizedTimestampSchema),
    source: v.optional(trimmedNonEmptyStringSchema),
    sourceJobId: v.optional(trimmedNonEmptyStringSchema),
    status: v.optional(reportStatusSchema),
    summary: v.optional(trimmedNonEmptyStringSchema),
    title: trimmedNonEmptyStringSchema,
    type: reportTypeSchema,
});

export const reportCreateInputSchema = v.pipe(
    reportCreateRequestSchema,
    v.transform((input) => ({
        ...input,
        status: input.status ?? ("ok" as const),
    }))
);

export const reportsFiltersSchema = v.strictObject({
    status: v.optional(reportStatusSchema),
    type: v.optional(reportTypeSchema),
});

export const reportsResponseSchema = v.strictObject({
    items: v.array(reportSchema),
});

export const reportResponseSchema = v.strictObject({
    report: reportSchema,
});

export const reportCreateResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    report: reportSchema,
});

export const reportDeleteResponseSchema = v.strictObject({
    deleted: nonNegativeIntegerSchema,
    isOk: successLiteralSchema,
});

export type ReportType = v.InferOutput<typeof reportTypeSchema>;
export type ReportStatus = v.InferOutput<typeof reportStatusSchema>;
export type Report = v.InferOutput<typeof reportSchema>;
export type CreateReportInput = v.InferOutput<typeof reportCreateInputSchema>;
export type ReportsFilters = v.InferOutput<typeof reportsFiltersSchema>;
export type ReportsResponse = v.InferOutput<typeof reportsResponseSchema>;
export type ReportResponse = v.InferOutput<typeof reportResponseSchema>;
export type CreateReportResponse = v.InferOutput<typeof reportCreateResponseSchema>;
export type DeleteReportResponse = v.InferOutput<typeof reportDeleteResponseSchema>;

/**
 * Parses report creation for both automation and browser callers.
 * @param value Value to process.
 * @returns Parsed report creation for both automation and browser callers.
 */
export function parseCreateReportInput(value: unknown): CreateReportInput {
    return parseContract(reportCreateInputSchema, value);
}

export function parseReportResponseValue(value: unknown, path = "response"): Report {
    return parseContract(reportSchema, value, path);
}

export function parseReportsResponse(value: unknown): ReportsResponse {
    return parseContract(reportsResponseSchema, value, "response");
}

export function parseReportResponse(value: unknown): ReportResponse {
    return parseContract(reportResponseSchema, value, "response");
}

export function parseCreateReportResponse(value: unknown): CreateReportResponse {
    return parseContract(reportCreateResponseSchema, value, "response");
}

export function parseDeleteReportResponse(value: unknown): DeleteReportResponse {
    return parseContract(reportDeleteResponseSchema, value, "response");
}
