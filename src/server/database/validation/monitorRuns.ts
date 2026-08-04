import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { monitorRuns } from "../schema/monitorRuns.ts";
import { uuidV7Action } from "./scalars.ts";

const monitorRunRefinements = {
    id: (schema: v.StringSchema<undefined>) => v.pipe(schema, v.uuid(), uuidV7Action),
    reportId: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, v.uuid(), uuidV7Action),
    submissionSha256: (schema: v.StringSchema<undefined>) =>
        v.pipe(
            schema,
            v.regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 checksum.")
        ),
};

const generatedMonitorRunSelectSchema = createSelectSchema(
    monitorRuns,
    monitorRunRefinements
);

/** Validates rows read from the monitor_runs table. */
export const monitorRunSelectSchema = v.strictObject(
    generatedMonitorRunSelectSchema.entries
);

const generatedMonitorRunInsertSchema = createInsertSchema(
    monitorRuns,
    monitorRunRefinements
);

/** Validates values before a monitor run insert. */
export const monitorRunInsertSchema = v.strictObject(
    generatedMonitorRunInsertSchema.entries
);

const generatedMonitorRunUpdateSchema = createUpdateSchema(
    monitorRuns,
    monitorRunRefinements
);

/** Validates only the mutable completion fields accepted by monitor run repositories. */
export const monitorRunUpdateSchema = v.strictObject({
    completedAt: generatedMonitorRunUpdateSchema.entries.completedAt,
    completeSnapshot: generatedMonitorRunUpdateSchema.entries.completeSnapshot,
    reportId: generatedMonitorRunUpdateSchema.entries.reportId,
    state: generatedMonitorRunUpdateSchema.entries.state,
});
