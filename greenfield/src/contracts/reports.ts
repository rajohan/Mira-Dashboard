import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { hasUniqueArrayItems } from "../shared/validation.ts";
import { uniqueFilterSchema } from "./filterSchemas.ts";
import {
    type ReportSummary,
    monitoringJsonObjectSchema,
    monitoringKindSchema,
    monitoringMutationInputFitsBudget,
    monitoringMutationInputMaximumBytes,
    monitoringRecordIdSchema,
    monitoringReportBodyMarkdownSchema,
    monitoringReportSourceJobIdSchema,
    monitoringReportSourceSchema,
    monitoringReportStatusSchema,
    monitoringReportSummarySchema,
    monitoringReportTitleSchema,
    reportDetailSchema,
    reportSummarySchema,
} from "./monitoring.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default reports returned by one list request. */
export const reportPageDefault = 100;

/** Hard report-row budget for one list response. */
export const reportPageMaximum = 200;

const reportFilterMaximum = 16;
const reportTimestampSchema = timestampMillisecondsSchema("Report timestamp is invalid");
const reportLimitSchema = v.pipe(
    v.number("Report page limit is invalid"),
    v.safeInteger("Report page limit is invalid"),
    v.minValue(1, "Report page limit is invalid"),
    v.maxValue(reportPageMaximum, "Report page limit is outside its budget")
);

/** Stable newest-first report cursor. */
export const reportCursorSchema = v.strictObject({
    id: monitoringRecordIdSchema,
    occurredAtMs: reportTimestampSchema,
});

/** Bounded filters supported by the immutable report catalog. */
export const reportListFiltersSchema = v.strictObject({
    kinds: v.optional(
        uniqueFilterSchema(monitoringKindSchema, "Report kind", reportFilterMaximum)
    ),
    sourceJobIds: v.optional(
        uniqueFilterSchema(
            monitoringReportSourceJobIdSchema,
            "Report source-job",
            reportFilterMaximum
        )
    ),
    sources: v.optional(
        uniqueFilterSchema(
            monitoringReportSourceSchema,
            "Report source",
            reportFilterMaximum
        )
    ),
    statuses: v.optional(
        v.pipe(
            v.array(monitoringReportStatusSchema, "Report status filter is invalid"),
            v.minLength(1, "Report status filter cannot be empty"),
            v.maxLength(
                reportFilterMaximum,
                "Report status filter is outside its budget"
            ),
            v.check(hasUniqueArrayItems, "Report status filter values must be unique")
        )
    ),
});

/** One stable keyset-paginated report request. */
export const listReportsInputSchema = v.strictObject({
    cursor: v.optional(reportCursorSchema),
    filters: v.optional(reportListFiltersSchema),
    limit: v.optional(reportLimitSchema, reportPageDefault),
});

/**
 * @param reports Candidate report page.
 * @returns Whether report summaries use strict newest-first cursor order.
 */
export function newestReportOrderIsStable(reports: ReportSummary[]): boolean {
    return reports.every((report, index) => {
        const previous = reports[index - 1];
        return (
            previous === undefined ||
            report.occurredAtMs < previous.occurredAtMs ||
            (report.occurredAtMs === previous.occurredAtMs && report.id < previous.id)
        );
    });
}

const reportRowsSchema = v.pipe(
    v.array(reportSummarySchema, "Report page is invalid"),
    v.maxLength(reportPageMaximum, "Report page is outside its budget"),
    v.check(newestReportOrderIsStable, "Report page order is invalid")
);

const listReportsResultObjectSchema = v.strictObject({
    nextCursor: v.optional(reportCursorSchema),
    reports: reportRowsSchema,
});

type ListReportsResultValue = v.InferOutput<typeof listReportsResultObjectSchema>;

/** @returns Whether an optional report cursor identifies the final returned row. */
export function reportPageCursorIsConsistent(result: ListReportsResultValue): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.reports.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.occurredAtMs === result.nextCursor.occurredAtMs
    );
}

/** One bounded report page plus an exact continuation cursor. */
export const listReportsResultSchema = v.pipe(
    listReportsResultObjectSchema,
    v.check(reportPageCursorIsConsistent, "Report page cursor is inconsistent")
);

/** Exact report lookup request. */
export const getReportInputSchema = v.strictObject({ id: monitoringRecordIdSchema });

const upsertReportInputObjectSchema = v.strictObject({
    bodyMarkdown: monitoringReportBodyMarkdownSchema,
    id: monitoringRecordIdSchema,
    kind: monitoringKindSchema,
    metadata: v.optional(monitoringJsonObjectSchema, {}),
    occurredAtMs: reportTimestampSchema,
    source: monitoringReportSourceSchema,
    sourceJobId: v.optional(monitoringReportSourceJobIdSchema),
    status: v.optional(monitoringReportStatusSchema, "ok"),
    summary: v.optional(monitoringReportSummarySchema),
    title: monitoringReportTitleSchema,
});

type UpsertReportInputValue = v.InferOutput<typeof upsertReportInputObjectSchema>;

/** @returns Whether one report producer input fits its aggregate encoded budget. */
export function upsertReportInputFitsBudget(input: UpsertReportInputValue): boolean {
    return monitoringMutationInputFitsBudget(input);
}

/** Idempotent immutable report producer input. */
export const upsertReportInputSchema = v.pipe(
    upsertReportInputObjectSchema,
    v.check(
        upsertReportInputFitsBudget,
        `Expected monitoring mutation input no larger than ${monitoringMutationInputMaximumBytes} encoded bytes.`
    )
);

/** Exact immutable report deletion request. */
export const deleteReportInputSchema = getReportInputSchema;

/** Stable report deletion acknowledgement. */
export const deleteReportResultSchema = v.strictObject({
    deletedAtMs: reportTimestampSchema,
    id: monitoringRecordIdSchema,
});

const reportReadAccess = {
    capabilities: ["reports:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const reportWriteAccess = {
    capabilities: ["reports:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const largeMutationTransport = {
    ...mutationTransport,
    requestBody: "monitoring",
} as const;

/** Implemented immutable report-catalog procedure metadata. */
export const reportProcedureContracts = [
    {
        access: reportReadAccess,
        domain: "reports",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listReportsInputSchema,
        inputSchemaId: "reports.list.input",
        kind: "query",
        name: "reports.list",
        output: listReportsResultSchema,
        outputSchemaId: "reports.list.output",
        summary: "Lists a stable filtered page of immutable report summaries.",
        transport: queryTransport,
    },
    {
        access: reportReadAccess,
        domain: "reports",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getReportInputSchema,
        inputSchemaId: "reports.get.input",
        kind: "query",
        name: "reports.get",
        output: reportDetailSchema,
        outputSchemaId: "reports.get.output",
        summary: "Loads one complete immutable Markdown report.",
        transport: queryTransport,
    },
    {
        access: reportWriteAccess,
        domain: "reports",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: upsertReportInputSchema,
        inputSchemaId: "reports.upsert.input",
        kind: "mutation",
        name: "reports.upsert",
        output: reportDetailSchema,
        outputSchemaId: "reports.upsert.output",
        summary: "Creates a report or accepts an exact idempotent replay.",
        transport: largeMutationTransport,
    },
    {
        access: reportWriteAccess,
        domain: "reports",
        errors: [
            "FORBIDDEN",
            "NOT_FOUND",
            "PRECONDITION_FAILED",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: deleteReportInputSchema,
        inputSchemaId: "reports.delete.input",
        kind: "mutation",
        name: "reports.delete",
        output: deleteReportResultSchema,
        outputSchemaId: "reports.delete.output",
        summary: "Deletes one report while preserving its monitor-run history.",
        transport: mutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type DeleteReportInput = v.InferOutput<typeof deleteReportInputSchema>;
export type DeleteReportResult = v.InferOutput<typeof deleteReportResultSchema>;
export type GetReportInput = v.InferOutput<typeof getReportInputSchema>;
export type ListReportsInput = v.InferOutput<typeof listReportsInputSchema>;
export type ListReportsResult = v.InferOutput<typeof listReportsResultSchema>;
export type UpsertReportInput = v.InferOutput<typeof upsertReportInputSchema>;
