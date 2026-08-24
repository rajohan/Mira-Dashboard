import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { reports } from "../schema/reports.ts";
import { jsonObjectTextAction, uuidV7Action } from "./scalars.ts";

const reportRefinements = {
    id: (schema: v.StringSchema<undefined>) => v.pipe(schema, v.uuid(), uuidV7Action),
    metadataJson: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, jsonObjectTextAction),
};

const generatedReportSelectSchema = createSelectSchema(reports, reportRefinements);

/** Validates immutable report rows read from SQLite. */
export const reportSelectSchema = v.strictObject(generatedReportSelectSchema.entries);

const generatedReportInsertSchema = createInsertSchema(reports, reportRefinements);

/** Validates values before an immutable report insert. */
export const reportInsertSchema = v.strictObject(generatedReportInsertSchema.entries);
