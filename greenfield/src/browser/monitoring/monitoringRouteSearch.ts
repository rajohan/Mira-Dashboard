import * as v from "valibot";

import { monitoringRecordIdSchema } from "../../contracts/monitoring.ts";

const reportsRouteSearchSchema = v.strictObject({
    reportId: v.optional(monitoringRecordIdSchema),
});
const incidentsRouteSearchSchema = v.strictObject({
    incidentId: v.optional(monitoringRecordIdSchema),
});

/** Validated deep-link state owned by the reports and incidents route. */
export type ReportsRouteSearch = v.InferOutput<typeof reportsRouteSearchSchema>;
export type IncidentsRouteSearch = v.InferOutput<typeof incidentsRouteSearchSchema>;

/**
 * Drops malformed or unknown search state instead of turning an external URL into a route error.
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns Safe report/incident selection state.
 */
export function parseReportsRouteSearch(search: unknown): ReportsRouteSearch {
    const reportId =
        typeof search === "object" &&
        search !== null &&
        "reportId" in search &&
        typeof search.reportId === "string"
            ? search.reportId
            : undefined;
    const parsed = v.safeParse(
        reportsRouteSearchSchema,
        reportId === undefined ? {} : { reportId }
    );
    return parsed.success ? parsed.output : {};
}

/**
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns Safe incident selection state from an untrusted external URL.
 */
export function parseIncidentsRouteSearch(search: unknown): IncidentsRouteSearch {
    const incidentId =
        typeof search === "object" &&
        search !== null &&
        "incidentId" in search &&
        typeof search.incidentId === "string"
            ? search.incidentId
            : undefined;
    const parsed = v.safeParse(
        incidentsRouteSearchSchema,
        incidentId === undefined ? {} : { incidentId }
    );
    return parsed.success ? parsed.output : {};
}
