import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    monitoringKindSchema,
    monitoringMonitorKeySchema,
    monitoringProblemTitleSchema,
} from "../../../contracts/monitoring.ts";
import { lowercaseSha256Action } from "../../../shared/validation.ts";
import { incidents } from "../schema/incidents.ts";
import {
    jsonObjectTextSchema,
    nonnegativeDateSchema,
    uuidV7TextSchema,
} from "./scalars.ts";

function incidentResolutionMatchesState(incident: {
    readonly resolvedAt?: Date | null;
    readonly state: string;
}): boolean {
    return incident.state === "active"
        ? incident.resolvedAt == null
        : incident.resolvedAt instanceof Date;
}

function incidentSeenOrderIsValid(incident: {
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
}): boolean {
    return compareAsc(incident.lastSeenAt, incident.firstSeenAt) >= 0;
}

function incidentResolutionOrderIsValid(incident: {
    readonly lastSeenAt: Date;
    readonly resolvedAt?: Date | null;
}): boolean {
    return (
        incident.resolvedAt == null ||
        compareAsc(incident.resolvedAt, incident.lastSeenAt) >= 0
    );
}

const incidentRefinements = {
    detailsJson: jsonObjectTextSchema,
    fingerprint: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, lowercaseSha256Action()),
    firstSeenAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    kind: () => monitoringKindSchema,
    lastSeenAt: nonnegativeDateSchema,
    monitorKey: () => monitoringMonitorKeySchema,
    resolvedAt: nonnegativeDateSchema,
    title: () => monitoringProblemTitleSchema,
    generation: (schema: GetValibotTypeFromColumn<typeof incidents.generation>) =>
        v.pipe(schema, v.minValue(1)),
    occurrenceCount: (
        schema: GetValibotTypeFromColumn<typeof incidents.occurrenceCount>
    ) => v.pipe(schema, v.minValue(1)),
};

const generatedIncidentSelectSchema = createSelectSchema(incidents, incidentRefinements);

/** Validates rows read from the incidents table. */
export const incidentSelectSchema = v.pipe(
    v.strictObject(generatedIncidentSelectSchema.entries),
    v.check(
        (incident) => incidentResolutionMatchesState(incident),
        "Expected incident state and resolution timestamp to agree."
    ),
    v.check(
        (incident) => incidentSeenOrderIsValid(incident),
        "Expected incident lastSeenAt to be at or after firstSeenAt."
    ),
    v.check(
        (incident) => incidentResolutionOrderIsValid(incident),
        "Expected incident resolvedAt to be at or after lastSeenAt."
    )
);

const generatedIncidentInsertSchema = v.omit(
    createInsertSchema(incidents, incidentRefinements),
    ["generation", "occurrenceCount"]
);

/** Validates values before an incident insert. */
export const incidentInsertSchema = v.pipe(
    v.strictObject(generatedIncidentInsertSchema.entries),
    v.check(
        (incident) => incidentResolutionMatchesState(incident),
        "Expected incident state and resolution timestamp to agree."
    ),
    v.check(
        (incident) => incidentSeenOrderIsValid(incident),
        "Expected incident lastSeenAt to be at or after firstSeenAt."
    ),
    v.check(
        (incident) => incidentResolutionOrderIsValid(incident),
        "Expected incident resolvedAt to be at or after lastSeenAt."
    )
);

const generatedIncidentUpdateSchema = createUpdateSchema(incidents, incidentRefinements);

/** Validates only the mutable columns accepted by incident lifecycle repositories. */
export const incidentUpdateSchema = v.strictObject({
    detailsJson: generatedIncidentUpdateSchema.entries.detailsJson,
    generation: generatedIncidentUpdateSchema.entries.generation,
    lastSeenAt: generatedIncidentUpdateSchema.entries.lastSeenAt,
    occurrenceCount: generatedIncidentUpdateSchema.entries.occurrenceCount,
    resolvedAt: generatedIncidentUpdateSchema.entries.resolvedAt,
    severity: generatedIncidentUpdateSchema.entries.severity,
    state: generatedIncidentUpdateSchema.entries.state,
    title: generatedIncidentUpdateSchema.entries.title,
});
