import * as v from "valibot";

import { boundedControlSafeTextSchema } from "../shared/validation.ts";
import {
    type ScheduleSummary,
    jobDescriptionMaximumLength,
    jobIdempotencyKeySchema,
    jobRunSummarySchema,
    jobTimestampSchema,
    jobVersionSchema,
    scheduleConfigurationSchema,
    scheduleIdSchema,
    scheduleSummarySchema,
} from "./jobModel.ts";
import {
    jobMutationTransport,
    jobQueryTransport,
    jobReadAccess,
    jobSessionWriteAccess,
} from "./jobProcedurePolicies.ts";
import {
    jobRunCursorSchema,
    jobRunPageDefault,
    jobRunPageMaximum,
    jobRunPageSchema,
} from "./jobs.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default schedules returned by one inventory request. */
export const schedulePageDefault = 50;
/** Hard schedule-row budget for one inventory response. */
export const schedulePageMaximum = 100;

const scheduleLimitSchema = v.pipe(
    v.number("Schedule page limit is invalid"),
    v.safeInteger("Schedule page limit is invalid"),
    v.minValue(1, "Schedule page limit is invalid"),
    v.maxValue(schedulePageMaximum, "Schedule page limit is outside its budget")
);
const scheduleRunLimitSchema = v.pipe(
    v.number("Schedule run page limit is invalid"),
    v.safeInteger("Schedule run page limit is invalid"),
    v.minValue(1, "Schedule run page limit is invalid"),
    v.maxValue(jobRunPageMaximum, "Schedule run page limit is outside its budget")
);

/** Stable ascending cursor for the code-owned schedule directory. */
export const scheduleCursorSchema = v.strictObject({ id: scheduleIdSchema });

/** One stable keyset-paginated schedule request. */
export const listSchedulesInputSchema = v.strictObject({
    cursor: v.optional(scheduleCursorSchema),
    enabled: v.optional(
        v.picklist(["all", "disabled", "enabled"], "Schedule enabled filter is invalid"),
        "all"
    ),
    limit: v.optional(scheduleLimitSchema, schedulePageDefault),
});

/**
 * @param schedules Schedule summaries to inspect.
 * @returns Whether they use strict ascending identifier order.
 */
export function scheduleOrderIsStable(schedules: ScheduleSummary[]): boolean {
    return schedules.every((schedule, index) => {
        const previous = schedules[index - 1];
        return previous === undefined || schedule.id > previous.id;
    });
}

const schedulePageSchema = v.pipe(
    v.array(scheduleSummarySchema, "Schedule page is invalid"),
    v.maxLength(schedulePageMaximum, "Schedule page is outside its budget"),
    v.check(scheduleOrderIsStable, "Schedule page order is invalid")
);

const listSchedulesResultObjectSchema = v.strictObject({
    nextCursor: v.optional(scheduleCursorSchema),
    schedules: schedulePageSchema,
});

type ListSchedulesResultValue = v.InferOutput<typeof listSchedulesResultObjectSchema>;

/**
 * @param result Schedule page and cursor to inspect.
 * @returns Whether an optional cursor identifies the final returned row.
 */
export function schedulePageCursorIsConsistent(
    result: ListSchedulesResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    return result.schedules.at(-1)?.id === result.nextCursor.id;
}

/** One bounded schedule page plus its exact continuation cursor. */
export const listSchedulesResultSchema = v.pipe(
    listSchedulesResultObjectSchema,
    v.check(schedulePageCursorIsConsistent, "Schedule page cursor is inconsistent")
);

/** Exact schedule lookup request. */
export const getScheduleInputSchema = v.strictObject({ id: scheduleIdSchema });

/** Operator-supplied reason shared by the schedule contract and browser form. */
export const scheduleDisableReasonSchema = boundedControlSafeTextSchema(
    jobDescriptionMaximumLength,
    "Schedule disable reason is invalid"
);

const scheduleDisableIntentInputSchema = v.strictObject({
    expiresAtMs: v.optional(jobTimestampSchema),
    reason: scheduleDisableReasonSchema,
});

const updateSchedulePatchObjectSchema = v.strictObject({
    disableIntent: v.optional(v.nullable(scheduleDisableIntentInputSchema)),
    enabled: v.optional(v.boolean("Schedule enabled state is invalid")),
    schedule: v.optional(scheduleConfigurationSchema),
});

export type UpdateSchedulePatch = v.InferOutput<typeof updateSchedulePatchObjectSchema>;

/**
 * @param patch Schedule patch to inspect.
 * @returns Whether it is non-empty and has one explicit disable transition.
 */
export function scheduleUpdatePatchIsConsistent(patch: UpdateSchedulePatch): boolean {
    if (Object.values(patch).every((value) => value === undefined)) return false;
    if (patch.enabled === false) {
        return patch.disableIntent !== undefined && patch.disableIntent !== null;
    }
    if (patch.enabled === true) return patch.disableIntent === null;
    return patch.disableIntent === undefined;
}

/** Versioned operator update with a complete mutually exclusive schedule variant. */
export const updateScheduleInputSchema = v.strictObject({
    expectedVersion: jobVersionSchema,
    id: scheduleIdSchema,
    patch: v.pipe(
        updateSchedulePatchObjectSchema,
        v.check(scheduleUpdatePatchIsConsistent, "Schedule update patch is inconsistent")
    ),
});

/** Lost-response-safe manual schedule run request. */
export const runScheduleInputSchema = v.strictObject({
    id: scheduleIdSchema,
    idempotencyKey: jobIdempotencyKeySchema,
});

/** One stable newest-first schedule run-history request. */
export const listScheduleRunsInputSchema = v.strictObject({
    cursor: v.optional(jobRunCursorSchema),
    id: scheduleIdSchema,
    limit: v.optional(scheduleRunLimitSchema, jobRunPageDefault),
});

const listScheduleRunsResultObjectSchema = v.strictObject({
    nextCursor: v.optional(jobRunCursorSchema),
    runs: jobRunPageSchema,
});

type ListScheduleRunsResultValue = v.InferOutput<
    typeof listScheduleRunsResultObjectSchema
>;

/**
 * @param result Schedule run page and cursor to inspect.
 * @returns Whether an optional cursor identifies the final row.
 */
export function scheduleRunPageCursorIsConsistent(
    result: ListScheduleRunsResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.runs.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.queuedAtMs === result.nextCursor.queuedAtMs
    );
}

/** One bounded schedule-scoped run page plus its exact continuation cursor. */
export const listScheduleRunsResultSchema = v.pipe(
    listScheduleRunsResultObjectSchema,
    v.check(scheduleRunPageCursorIsConsistent, "Schedule run page cursor is inconsistent")
);

const scheduleRunAccess = {
    capabilities: ["jobs:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
/** Dashboard-local schedule inventory, update, and manual-run contracts. */
export const scheduleProcedureContracts = [
    {
        access: jobReadAccess,
        domain: "schedules",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listSchedulesInputSchema,
        inputSchemaId: "schedules.list.input",
        kind: "query",
        name: "schedules.list",
        output: listSchedulesResultSchema,
        outputSchemaId: "schedules.list.output",
        summary: "Lists the stable code-owned Dashboard schedule directory.",
        transport: jobQueryTransport,
    },
    {
        access: jobReadAccess,
        domain: "schedules",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getScheduleInputSchema,
        inputSchemaId: "schedules.get.input",
        kind: "query",
        name: "schedules.get",
        output: scheduleSummarySchema,
        outputSchemaId: "schedules.get.output",
        summary: "Loads one code-owned schedule and its latest durable run state.",
        transport: jobQueryTransport,
    },
    {
        access: jobSessionWriteAccess,
        domain: "schedules",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: updateScheduleInputSchema,
        inputSchemaId: "schedules.update.input",
        kind: "mutation",
        name: "schedules.update",
        output: scheduleSummarySchema,
        outputSchemaId: "schedules.update.output",
        summary: "Updates one schedule or its explicit disable intent by version.",
        transport: jobMutationTransport,
    },
    {
        access: scheduleRunAccess,
        domain: "schedules",
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: runScheduleInputSchema,
        inputSchemaId: "schedules.run.input",
        kind: "mutation",
        name: "schedules.run",
        output: jobRunSummarySchema,
        outputSchemaId: "schedules.run.output",
        summary: "Enqueues one caller-scoped idempotent manual schedule run.",
        transport: jobMutationTransport,
    },
    {
        access: jobReadAccess,
        domain: "schedules",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: listScheduleRunsInputSchema,
        inputSchemaId: "schedules.listRuns.input",
        kind: "query",
        name: "schedules.listRuns",
        output: listScheduleRunsResultSchema,
        outputSchemaId: "schedules.listRuns.output",
        summary: "Lists stable newest-first durable history for one schedule.",
        transport: jobQueryTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type GetScheduleInput = v.InferOutput<typeof getScheduleInputSchema>;
export type ListScheduleRunsInput = v.InferOutput<typeof listScheduleRunsInputSchema>;
export type ListScheduleRunsResult = v.InferOutput<typeof listScheduleRunsResultSchema>;
export type ListSchedulesInput = v.InferOutput<typeof listSchedulesInputSchema>;
export type ListSchedulesResult = v.InferOutput<typeof listSchedulesResultSchema>;
export type RunScheduleInput = v.InferOutput<typeof runScheduleInputSchema>;
export type UpdateScheduleInput = v.InferOutput<typeof updateScheduleInputSchema>;
