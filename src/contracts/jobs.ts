import * as v from "valibot";

import {
    compareStrings,
    hasUniqueArrayItems,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import { enumFilterSchema } from "./filterSchemas.ts";
import {
    type JobRunEvent,
    type JobRunSummary,
    type JobResourceClass,
    type JobWorkerSummary,
    jobResourceClasses,
    jobResourceClassSchema,
    jobRunEventSchema,
    jobRunEventSequenceSchema,
    jobRunIdSchema,
    jobRunResultSchema,
    jobRunStates,
    jobRunSummarySchema,
    jobTimestampSchema,
    jobTriggerTypes,
    jobVersionSchema,
    jobWorkerControlSchema,
    jobWorkerSummaryMaximum,
    jobWorkerSummarySchema,
    scheduleIdSchema,
} from "./jobModel.ts";
import {
    jobMutationTransport,
    jobQueryTransport,
    jobReadAccess,
    jobSessionWriteAccess,
} from "./jobProcedurePolicies.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default durable runs returned by one request. */
export const jobRunPageDefault = 50;
/** Hard durable run-row budget for one response. */
export const jobRunPageMaximum = 100;
/** Default run events returned by one exact-detail request. */
export const jobRunEventPageDefault = 50;
/** Hard run-event budget for one detail response. */
export const jobRunEventPageMaximum = 100;

const jobRunFilterMaximum = 16;
const jobRunLimitSchema = v.pipe(
    v.number("Job run page limit is invalid"),
    v.safeInteger("Job run page limit is invalid"),
    v.minValue(1, "Job run page limit is invalid"),
    v.maxValue(jobRunPageMaximum, "Job run page limit is outside its budget")
);
const jobRunEventLimitSchema = v.pipe(
    v.number("Job event page limit is invalid"),
    v.safeInteger("Job event page limit is invalid"),
    v.minValue(1, "Job event page limit is invalid"),
    v.maxValue(jobRunEventPageMaximum, "Job event page limit is outside its budget")
);

/** Stable newest-first cursor for global and schedule-scoped run history. */
export const jobRunCursorSchema = v.strictObject({
    id: jobRunIdSchema,
    queuedAtMs: jobTimestampSchema,
});

/** Stable newest-first cursor for one run's event history. */
export const jobRunEventCursorSchema = v.strictObject({
    sequence: jobRunEventSequenceSchema,
});

/** Bounded filters supported by the durable run inventory. */
export const jobRunFiltersSchema = v.strictObject({
    resourceClasses: v.optional(
        enumFilterSchema(jobResourceClasses, "Job resource class", jobRunFilterMaximum)
    ),
    scheduleId: v.optional(scheduleIdSchema),
    states: v.optional(
        enumFilterSchema(jobRunStates, "Job run state", jobRunFilterMaximum)
    ),
    triggerTypes: v.optional(
        enumFilterSchema(jobTriggerTypes, "Job trigger type", jobRunFilterMaximum)
    ),
});

/** One stable keyset-paginated global run request. */
export const listJobRunsInputSchema = v.strictObject({
    cursor: v.optional(jobRunCursorSchema),
    filters: v.optional(jobRunFiltersSchema),
    limit: v.optional(jobRunLimitSchema, jobRunPageDefault),
});

/**
 * @param runs Run summaries to inspect.
 * @returns Whether they use strict newest-first cursor order.
 */
export function newestJobRunOrderIsStable(runs: JobRunSummary[]): boolean {
    return runs.every((run, index) => {
        const previous = runs[index - 1];
        return (
            previous === undefined ||
            run.queuedAtMs < previous.queuedAtMs ||
            (run.queuedAtMs === previous.queuedAtMs && run.id < previous.id)
        );
    });
}

/** Bounded stable run rows reused by global and schedule-scoped history. */
export const jobRunPageSchema = v.pipe(
    v.array(jobRunSummarySchema, "Job run page is invalid"),
    v.maxLength(jobRunPageMaximum, "Job run page is outside its budget"),
    v.check(newestJobRunOrderIsStable, "Job run page order is invalid")
);

const jobRunStateCountsSchema = v.strictObject({
    cancelled: nonnegativeSafeIntegerSchema("Cancelled job count is invalid"),
    failed: nonnegativeSafeIntegerSchema("Failed job count is invalid"),
    queued: nonnegativeSafeIntegerSchema("Queued job count is invalid"),
    running: nonnegativeSafeIntegerSchema("Running job count is invalid"),
    succeeded: nonnegativeSafeIntegerSchema("Succeeded job count is invalid"),
    "timed-out": nonnegativeSafeIntegerSchema("Timed-out job count is invalid"),
});

/**
 * @param resourceClasses Active resource classes to inspect.
 * @returns Whether the set is unique and in canonical order.
 */
export function activeJobResourceClassesAreCanonical(
    resourceClasses: JobResourceClass[]
): boolean {
    return (
        hasUniqueArrayItems(resourceClasses) &&
        resourceClasses.every((resourceClass, index) => {
            const previous = resourceClasses[index - 1];
            return previous === undefined || compareStrings(previous, resourceClass) < 0;
        })
    );
}

const activeJobResourceClassesSchema = v.pipe(
    v.array(jobResourceClassSchema, "Active job resource classes are invalid"),
    v.maxLength(
        jobResourceClasses.length,
        "Active job resource classes are outside their budget"
    ),
    v.check(
        activeJobResourceClassesAreCanonical,
        "Active job resource classes are not canonical"
    )
);

/**
 * @param workers Worker summaries to inspect.
 * @returns Whether they have unique IDs in canonical order.
 */
export function jobWorkerSummariesAreCanonical(workers: JobWorkerSummary[]): boolean {
    return (
        hasUniqueArrayItems(workers.map(({ id }) => id)) &&
        workers.every((worker, index) => {
            const previous = workers[index - 1];
            return previous === undefined || compareStrings(previous.id, worker.id) < 0;
        })
    );
}

const jobWorkerSummariesSchema = v.pipe(
    v.array(jobWorkerSummarySchema, "Job worker summaries are invalid"),
    v.maxLength(jobWorkerSummaryMaximum, "Job worker summaries are outside their budget"),
    v.check(jobWorkerSummariesAreCanonical, "Job worker summaries are not canonical")
);

const jobQueueSummaryObjectSchema = v.strictObject({
    activeResourceClasses: activeJobResourceClassesSchema,
    control: jobWorkerControlSchema,
    oldestQueuedAtMs: v.optional(jobTimestampSchema),
    stateCounts: jobRunStateCountsSchema,
    workers: jobWorkerSummariesSchema,
});

type JobQueueSummaryValue = v.InferOutput<typeof jobQueueSummaryObjectSchema>;

/**
 * @param summary Exact queue summary to inspect.
 * @returns Whether counts agree with optional derived fields.
 */
export function jobQueueSummaryIsConsistent(summary: JobQueueSummaryValue): boolean {
    return (
        summary.stateCounts.queued > 0 === (summary.oldestQueuedAtMs !== undefined) &&
        summary.stateCounts.running > 0 === summary.activeResourceClasses.length > 0
    );
}

/** Exact bounded worker and queue projection returned with global run history. */
export const jobQueueSummarySchema = v.pipe(
    jobQueueSummaryObjectSchema,
    v.check(jobQueueSummaryIsConsistent, "Job queue summary is inconsistent")
);

const listJobRunsResultObjectSchema = v.strictObject({
    nextCursor: v.optional(jobRunCursorSchema),
    runs: jobRunPageSchema,
    summary: jobQueueSummarySchema,
});

type ListJobRunsResultValue = v.InferOutput<typeof listJobRunsResultObjectSchema>;

/**
 * @param result Run page and cursor to inspect.
 * @returns Whether an optional cursor identifies the final returned row.
 */
export function jobRunPageCursorIsConsistent(result: ListJobRunsResultValue): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.runs.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.queuedAtMs === result.nextCursor.queuedAtMs
    );
}

/** Stable global run page plus exact queue summary and continuation cursor. */
export const listJobRunsResultSchema = v.pipe(
    listJobRunsResultObjectSchema,
    v.check(jobRunPageCursorIsConsistent, "Job run page cursor is inconsistent")
);

/**
 * @param events Durable run events to inspect.
 * @returns Whether they use strict newest-first sequence order.
 */
export function newestJobRunEventOrderIsStable(events: JobRunEvent[]): boolean {
    return events.every((event, index) => {
        const previous = events[index - 1];
        return previous === undefined || event.sequence < previous.sequence;
    });
}

const jobRunEventPageSchema = v.pipe(
    v.array(jobRunEventSchema, "Job run event page is invalid"),
    v.maxLength(jobRunEventPageMaximum, "Job run event page is outside its budget"),
    v.check(newestJobRunEventOrderIsStable, "Job run event page order is invalid")
);

const jobRunDetailObjectSchema = v.strictObject({
    events: jobRunEventPageSchema,
    nextEventCursor: v.optional(jobRunEventCursorSchema),
    result: v.optional(jobRunResultSchema),
    run: jobRunSummarySchema,
});

export type JobRunDetail = v.InferOutput<typeof jobRunDetailObjectSchema>;

/**
 * @param detail Public run detail to inspect.
 * @returns Whether it agrees with run state, event count, and cursor.
 */
export function jobRunDetailIsConsistent(detail: JobRunDetail): boolean {
    if ((detail.run.state === "succeeded") !== (detail.result !== undefined)) {
        return false;
    }
    if (
        detail.events.some(
            (event) =>
                event.sequence > detail.run.eventCount ||
                event.attempt > detail.run.attemptCount
        )
    ) {
        return false;
    }
    if (detail.nextEventCursor === undefined) return true;
    return detail.events.at(-1)?.sequence === detail.nextEventCursor.sequence;
}

/** Complete public run detail without raw input or lease/fencing internals. */
export const jobRunDetailSchema = v.pipe(
    jobRunDetailObjectSchema,
    v.check(jobRunDetailIsConsistent, "Job run detail is inconsistent")
);

/** Exact run lookup with one bounded newest-first event page. */
export const getJobRunInputSchema = v.strictObject({
    eventCursor: v.optional(jobRunEventCursorSchema),
    eventLimit: v.optional(jobRunEventLimitSchema, jobRunEventPageDefault),
    id: jobRunIdSchema,
});

/** Exact session-owned cancellation request. */
export const cancelJobRunInputSchema = v.strictObject({ id: jobRunIdSchema });

/** Versioned cross-process claim-pause update. */
export const setJobClaimingPausedInputSchema = v.strictObject({
    expectedVersion: jobVersionSchema,
    paused: v.boolean("Worker claiming state is invalid"),
});

/** Durable job inventory, detail, cancellation, and worker-control contracts. */
export const jobProcedureContracts = [
    {
        access: jobReadAccess,
        domain: "jobs",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listJobRunsInputSchema,
        inputSchemaId: "jobs.listRuns.input",
        kind: "query",
        name: "jobs.listRuns",
        output: listJobRunsResultSchema,
        outputSchemaId: "jobs.listRuns.output",
        summary: "Lists stable newest-first durable run history and queue state.",
        transport: jobQueryTransport,
    },
    {
        access: jobReadAccess,
        domain: "jobs",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getJobRunInputSchema,
        inputSchemaId: "jobs.getRun.input",
        kind: "query",
        name: "jobs.getRun",
        output: jobRunDetailSchema,
        outputSchemaId: "jobs.getRun.output",
        summary: "Loads one durable run with bounded newest-first events.",
        transport: jobQueryTransport,
    },
    {
        access: jobSessionWriteAccess,
        domain: "jobs",
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: cancelJobRunInputSchema,
        inputSchemaId: "jobs.cancelRun.input",
        kind: "mutation",
        name: "jobs.cancelRun",
        output: jobRunSummarySchema,
        outputSchemaId: "jobs.cancelRun.output",
        summary: "Cancels a queued run or requests cooperative running cancellation.",
        transport: jobMutationTransport,
    },
    {
        access: jobSessionWriteAccess,
        domain: "jobs",
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: setJobClaimingPausedInputSchema,
        inputSchemaId: "jobs.setClaimingPaused.input",
        kind: "mutation",
        name: "jobs.setClaimingPaused",
        output: jobWorkerControlSchema,
        outputSchemaId: "jobs.setClaimingPaused.output",
        summary: "Pauses or resumes new cross-process claims under version control.",
        transport: jobMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type CancelJobRunInput = v.InferOutput<typeof cancelJobRunInputSchema>;
export type GetJobRunInput = v.InferOutput<typeof getJobRunInputSchema>;
export type JobQueueSummary = v.InferOutput<typeof jobQueueSummarySchema>;
export type ListJobRunsInput = v.InferOutput<typeof listJobRunsInputSchema>;
export type ListJobRunsResult = v.InferOutput<typeof listJobRunsResultSchema>;
export type SetJobClaimingPausedInput = v.InferOutput<
    typeof setJobClaimingPausedInputSchema
>;
