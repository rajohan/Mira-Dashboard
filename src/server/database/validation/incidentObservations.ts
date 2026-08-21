import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    monitoringKindSchema,
    monitoringProblemTitleSchema,
} from "../../../contracts/monitoring.ts";
import { incidentObservations } from "../schema/incidentObservations.ts";
import {
    jsonObjectTextSchema,
    nonnegativeDateSchema,
    uuidV7TextSchema,
} from "./scalars.ts";

const observationRefinements = {
    detailsJson: jsonObjectTextSchema,
    incidentId: uuidV7TextSchema,
    kind: () => monitoringKindSchema,
    monitorRunId: uuidV7TextSchema,
    observedAt: nonnegativeDateSchema,
    title: () => monitoringProblemTitleSchema,
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
