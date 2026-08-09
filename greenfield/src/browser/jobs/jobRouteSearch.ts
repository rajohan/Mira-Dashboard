import * as v from "valibot";

import { jobRunIdSchema, scheduleIdSchema } from "../../contracts/jobModel.ts";
import { openClawCronJobIdSchema } from "../../contracts/openClawCron.ts";

const jobsRouteSearchSchema = v.strictObject({
    cronJobId: v.optional(openClawCronJobIdSchema),
    runId: v.optional(jobRunIdSchema),
    scheduleId: v.optional(scheduleIdSchema),
    source: v.optional(v.picklist(["dashboard", "openclaw"])),
});

/** Validated independent selections owned by the Dashboard-local jobs route. */
export type JobsRouteSearch = v.InferOutput<typeof jobsRouteSearchSchema>;

function searchString(
    search: unknown,
    key: "cronJobId" | "runId" | "scheduleId" | "source"
): string | undefined {
    if (typeof search !== "object" || search === null) return undefined;
    const value = (search as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

/**
 * Drops each malformed or unknown selection without discarding an independent valid one.
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns Safe schedule and run deep-link state.
 */
export function parseJobsRouteSearch(search: unknown): JobsRouteSearch {
    const rawCronJobId = searchString(search, "cronJobId");
    const rawRunId = searchString(search, "runId");
    const rawScheduleId = searchString(search, "scheduleId");
    const rawSource = searchString(search, "source");
    const cronJobId = v.safeParse(openClawCronJobIdSchema, rawCronJobId);
    const runId = v.safeParse(jobRunIdSchema, rawRunId);
    const scheduleId = v.safeParse(scheduleIdSchema, rawScheduleId);
    const source = v.safeParse(v.picklist(["dashboard", "openclaw"]), rawSource);

    return {
        ...(cronJobId.success ? { cronJobId: cronJobId.output } : {}),
        ...(runId.success ? { runId: runId.output } : {}),
        ...(scheduleId.success ? { scheduleId: scheduleId.output } : {}),
        ...(source.success ? { source: source.output } : {}),
    };
}
