import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { monitoringMonitorKeySchema } from "../../../contracts/monitoring.ts";
import { lowercaseSha256Action } from "../../../shared/validation.ts";
import { monitorRuns } from "../schema/monitorRuns.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

function monitorRunCompletionMatchesState(run: {
    readonly completedAt?: Date | null;
    readonly state: string;
}): boolean {
    return run.state === "running"
        ? run.completedAt == null
        : run.completedAt instanceof Date;
}

function monitorRunCompletionOrderIsValid(run: {
    readonly completedAt?: Date | null;
    readonly startedAt: Date;
}): boolean {
    return run.completedAt == null || compareAsc(run.completedAt, run.startedAt) >= 0;
}

const monitorRunRefinements = {
    completedAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    monitorKey: () => monitoringMonitorKeySchema,
    reportId: uuidV7TextSchema,
    startedAt: nonnegativeDateSchema,
    submissionSha256: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, lowercaseSha256Action()),
};

const generatedMonitorRunSelectSchema = createSelectSchema(
    monitorRuns,
    monitorRunRefinements
);

/** Validates rows read from the monitor_runs table. */
export const monitorRunSelectSchema = v.pipe(
    v.strictObject(generatedMonitorRunSelectSchema.entries),
    v.check(
        (run) => monitorRunCompletionMatchesState(run),
        "Expected monitor run state and completion timestamp to agree."
    ),
    v.check(
        (run) => monitorRunCompletionOrderIsValid(run),
        "Expected monitor run completedAt to be at or after startedAt."
    )
);

const generatedMonitorRunInsertSchema = createInsertSchema(
    monitorRuns,
    monitorRunRefinements
);

/** Validates values before a monitor run insert. */
export const monitorRunInsertSchema = v.pipe(
    v.strictObject(generatedMonitorRunInsertSchema.entries),
    v.check(
        (run) => monitorRunCompletionMatchesState(run),
        "Expected monitor run state and completion timestamp to agree."
    ),
    v.check(
        (run) => monitorRunCompletionOrderIsValid(run),
        "Expected monitor run completedAt to be at or after startedAt."
    )
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
