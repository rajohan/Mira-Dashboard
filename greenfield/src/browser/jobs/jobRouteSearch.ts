import * as v from "valibot";

import { jobRunIdSchema, scheduleIdSchema } from "../../contracts/jobModel.ts";

const jobsRouteSearchSchema = v.strictObject({
    runId: v.optional(jobRunIdSchema),
    scheduleId: v.optional(scheduleIdSchema),
});

/** Validated independent selections owned by the Dashboard-local jobs route. */
export type JobsRouteSearch = v.InferOutput<typeof jobsRouteSearchSchema>;

function searchString(search: unknown, key: "runId" | "scheduleId"): string | undefined {
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
    const rawRunId = searchString(search, "runId");
    const rawScheduleId = searchString(search, "scheduleId");
    const runId = v.safeParse(jobRunIdSchema, rawRunId);
    const scheduleId = v.safeParse(scheduleIdSchema, rawScheduleId);

    return {
        ...(runId.success ? { runId: runId.output } : {}),
        ...(scheduleId.success ? { scheduleId: scheduleId.output } : {}),
    };
}
