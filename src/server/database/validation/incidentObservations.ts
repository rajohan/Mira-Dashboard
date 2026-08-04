import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { incidentObservations } from "../schema/incidentObservations.ts";
import { jsonObjectTextAction, uuidV7Action } from "./scalars.ts";

const observationRefinements = {
    detailsJson: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, jsonObjectTextAction),
    incidentId: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, v.uuid(), uuidV7Action),
    monitorRunId: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, v.uuid(), uuidV7Action),
    generation: (
        schema: GetValibotTypeFromColumn<typeof incidentObservations.generation>
    ) => v.pipe(schema, v.minValue(1)),
};

const generatedIncidentObservationSelectSchema = createSelectSchema(
    incidentObservations,
    observationRefinements
);

/** Validates immutable incident observation rows read from SQLite. */
export const incidentObservationSelectSchema = v.strictObject(
    generatedIncidentObservationSelectSchema.entries
);

const generatedIncidentObservationInsertSchema = v.omit(
    createInsertSchema(incidentObservations, observationRefinements),
    ["id"]
);

/** Validates values before an immutable incident observation insert. */
export const incidentObservationInsertSchema = v.strictObject(
    generatedIncidentObservationInsertSchema.entries
);
