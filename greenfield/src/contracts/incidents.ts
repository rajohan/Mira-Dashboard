import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { enumFilterSchema, uniqueFilterSchema } from "./filterSchemas.ts";
import {
    type IncidentSummary,
    incidentRecordSchema,
    incidentSummarySchema,
    monitoringKindSchema,
    monitoringMonitorKeySchema,
    monitoringRecordIdSchema,
    monitoringSeverities,
} from "./monitoring.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default incidents returned by one list request. */
export const incidentPageDefault = 50;

/** Hard incident-row budget for one response. */
export const incidentPageMaximum = 100;

const incidentFilterMaximum = 16;
const incidentTimestampSchema = timestampMillisecondsSchema(
    "Incident timestamp is invalid"
);
const incidentLimitSchema = v.pipe(
    v.number("Incident page limit is invalid"),
    v.safeInteger("Incident page limit is invalid"),
    v.minValue(1, "Incident page limit is invalid"),
    v.maxValue(incidentPageMaximum, "Incident page limit is outside its budget")
);

/** Stable newest-first incident cursor. */
export const incidentCursorSchema = v.strictObject({
    id: monitoringRecordIdSchema,
    lastSeenAtMs: incidentTimestampSchema,
});

/** Bounded filters supported by incident lifecycle reads. */
export const incidentListFiltersSchema = v.strictObject({
    kinds: v.optional(
        uniqueFilterSchema(monitoringKindSchema, "Incident kind", incidentFilterMaximum)
    ),
    monitorKeys: v.optional(
        uniqueFilterSchema(
            monitoringMonitorKeySchema,
            "Incident monitor",
            incidentFilterMaximum
        )
    ),
    severities: v.optional(
        enumFilterSchema(monitoringSeverities, "Incident severity", incidentFilterMaximum)
    ),
    states: v.optional(
        enumFilterSchema(["active", "resolved"], "Incident state", incidentFilterMaximum)
    ),
});

/** One stable keyset-paginated incident request. */
export const listIncidentsInputSchema = v.strictObject({
    cursor: v.optional(incidentCursorSchema),
    filters: v.optional(incidentListFiltersSchema),
    limit: v.optional(incidentLimitSchema, incidentPageDefault),
});

/**
 * @param incidents Candidate incident page.
 * @returns Whether incidents use strict newest-first last-seen ordering.
 */
export function newestIncidentOrderIsStable(incidents: IncidentSummary[]): boolean {
    return incidents.every((incident, index) => {
        const previous = incidents[index - 1];
        return (
            previous === undefined ||
            incident.lastSeenAtMs < previous.lastSeenAtMs ||
            (incident.lastSeenAtMs === previous.lastSeenAtMs && incident.id < previous.id)
        );
    });
}

const incidentRowsSchema = v.pipe(
    v.array(incidentSummarySchema, "Incident page is invalid"),
    v.maxLength(incidentPageMaximum, "Incident page is outside its budget"),
    v.check(newestIncidentOrderIsStable, "Incident page order is invalid")
);

const listIncidentsResultObjectSchema = v.strictObject({
    incidents: incidentRowsSchema,
    nextCursor: v.optional(incidentCursorSchema),
});

type ListIncidentsResultValue = v.InferOutput<typeof listIncidentsResultObjectSchema>;

/** @returns Whether an optional incident cursor identifies the final row. */
export function incidentPageCursorIsConsistent(
    result: ListIncidentsResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.incidents.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.lastSeenAtMs === result.nextCursor.lastSeenAtMs
    );
}

/** One bounded incident page plus an exact continuation cursor. */
export const listIncidentsResultSchema = v.pipe(
    listIncidentsResultObjectSchema,
    v.check(incidentPageCursorIsConsistent, "Incident page cursor is inconsistent")
);

/** Exact incident lookup request. */
export const getIncidentInputSchema = v.strictObject({
    id: monitoringRecordIdSchema,
});

const incidentReadAccess = {
    capabilities: ["reports:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;

/** Implemented incident lifecycle read procedure metadata. */
export const incidentProcedureContracts = [
    {
        access: incidentReadAccess,
        domain: "incidents",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listIncidentsInputSchema,
        inputSchemaId: "incidents.list.input",
        kind: "query",
        name: "incidents.list",
        output: listIncidentsResultSchema,
        outputSchemaId: "incidents.list.output",
        summary: "Lists stable incident lifecycle rows for report navigation.",
        transport: queryTransport,
    },
    {
        access: incidentReadAccess,
        domain: "incidents",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getIncidentInputSchema,
        inputSchemaId: "incidents.get.input",
        kind: "query",
        name: "incidents.get",
        output: incidentRecordSchema,
        outputSchemaId: "incidents.get.output",
        summary: "Loads one exact incident lifecycle record.",
        transport: queryTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type GetIncidentInput = v.InferOutput<typeof getIncidentInputSchema>;
export type ListIncidentsInput = v.InferOutput<typeof listIncidentsInputSchema>;
export type ListIncidentsResult = v.InferOutput<typeof listIncidentsResultSchema>;
