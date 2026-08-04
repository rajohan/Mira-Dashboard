import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { incidents } from "../schema/incidents.ts";
import { jsonObjectTextAction, uuidV7Action } from "./scalars.ts";

const incidentRefinements = {
    detailsJson: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, jsonObjectTextAction),
    id: (schema: v.StringSchema<undefined>) => v.pipe(schema, v.uuid(), uuidV7Action),
    generation: (schema: GetValibotTypeFromColumn<typeof incidents.generation>) =>
        v.pipe(schema, v.minValue(1)),
    occurrenceCount: (
        schema: GetValibotTypeFromColumn<typeof incidents.occurrenceCount>
    ) => v.pipe(schema, v.minValue(1)),
};

const generatedIncidentSelectSchema = createSelectSchema(incidents, incidentRefinements);

/** Validates rows read from the incidents table. */
export const incidentSelectSchema = v.strictObject(generatedIncidentSelectSchema.entries);

const generatedIncidentInsertSchema = v.omit(
    createInsertSchema(incidents, incidentRefinements),
    ["generation", "occurrenceCount"]
);

/** Validates values before an incident insert. */
export const incidentInsertSchema = v.strictObject(generatedIncidentInsertSchema.entries);

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
