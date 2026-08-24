import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    hasUniqueArrayItems,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    type TaskProgressUpdate,
    type TaskSummary,
    canonicalizeTaskStrings,
    freezeTaskStrings,
    taskAssigneeIdSchema,
    taskAssigneeIds,
    taskAutomationProfileInputSchema,
    taskBodyMarkdownSchema,
    taskDetailSchema,
    taskIdSchema,
    taskLabelArraySchema,
    taskLabelInputSchema,
    taskLabelSchema,
    taskPriorities,
    taskPrioritySchema,
    taskProgressMarkdownSchema,
    taskProgressUpdateIdSchema,
    taskProgressUpdateSchema,
    taskStatuses,
    taskStatusSchema,
    taskSummarySchema,
    taskStringsAreSorted,
    taskTextIsTrimmed,
    taskTitleSchema,
    taskVersionSchema,
} from "./taskModel.ts";

/** Default task rows returned by one list request. */
export const taskPageDefault = 50;

/** Hard task-row budget for one list response. */
export const taskPageMaximum = 100;

/** Default progress rows returned by one list request. */
export const taskProgressPageDefault = 20;

/** Hard progress-row budget for one list response. */
export const taskProgressPageMaximum = 50;

/** Hard budget for the reusable task-label suggestion catalog. */
export const taskLabelSuggestionMaximum = 200;

const taskTimestampSchema = timestampMillisecondsSchema("Task timestamp is invalid");
const taskPageLimitSchema = v.pipe(
    v.number("Task page limit is invalid"),
    v.safeInteger("Task page limit is invalid"),
    v.minValue(1, "Task page limit is invalid"),
    v.maxValue(taskPageMaximum, "Task page limit is outside its budget")
);
const taskProgressPageLimitSchema = v.pipe(
    v.number("Task progress page limit is invalid"),
    v.safeInteger("Task progress page limit is invalid"),
    v.minValue(1, "Task progress page limit is invalid"),
    v.maxValue(taskProgressPageMaximum, "Task progress page limit is outside its budget")
);

/** Stable newest-first cursor for task list pagination. */
export const taskCursorSchema = v.strictObject({
    id: taskIdSchema,
    updatedAtMs: taskTimestampSchema,
});

/** Stable newest-first cursor for task progress pagination. */
export const taskProgressCursorSchema = v.strictObject({
    createdAtMs: taskTimestampSchema,
    id: taskProgressUpdateIdSchema,
});

function canonicalSelectionSchema<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
    label: string
) {
    return v.pipe(
        v.array(v.picklist(values, `${label} value is invalid`), `${label} is invalid`),
        v.minLength(1, `${label} cannot be empty`),
        v.maxLength(values.length, `${label} is outside its budget`),
        v.check(hasUniqueArrayItems<TValues[number]>, `${label} values must be unique`),
        v.transform(canonicalizeTaskStrings)
    );
}

const taskStatusFilterSchema = canonicalSelectionSchema(
    taskStatuses,
    "Task status filter"
);
const taskPriorityFilterSchema = canonicalSelectionSchema(
    taskPriorities,
    "Task priority filter"
);
const taskAssigneeFilterSchema = canonicalSelectionSchema(
    taskAssigneeIds,
    "Task assignee filter"
);
const taskLabelFilterSchema = v.pipe(
    taskLabelArraySchema,
    v.minLength(1, "Task label filter cannot be empty"),
    v.transform(canonicalizeTaskStrings)
);
const taskSearchSchema = v.pipe(
    boundedControlSafeTextSchema(200, "Task search is invalid"),
    v.check(taskTextIsTrimmed, "Task search is invalid")
);

/** Bounded task-board filters shared by browser and automation clients. */
export const taskListFiltersSchema = v.strictObject({
    assignees: v.optional(taskAssigneeFilterSchema),
    automation: v.optional(v.picklist(["recurring", "manual"])),
    labels: v.optional(taskLabelFilterSchema),
    priorities: v.optional(taskPriorityFilterSchema),
    search: v.optional(taskSearchSchema),
    statuses: v.optional(taskStatusFilterSchema),
});

/** One bounded, stable task-list request. */
export const listTasksInputSchema = v.strictObject({
    cursor: v.optional(taskCursorSchema),
    filters: v.optional(taskListFiltersSchema),
    limit: v.optional(taskPageLimitSchema, taskPageDefault),
});

/**
 * @param tasks Candidate task page.
 * @returns Whether a task page uses strict newest-first cursor order.
 */
export function newestTaskOrderIsStable(tasks: TaskSummary[]): boolean {
    return tasks.every((task, index) => {
        const previous = tasks[index - 1];
        return (
            previous === undefined ||
            task.updatedAtMs < previous.updatedAtMs ||
            (task.updatedAtMs === previous.updatedAtMs && task.id < previous.id)
        );
    });
}

const taskPageSchema = v.pipe(
    v.array(taskSummarySchema, "Task page is invalid"),
    v.maxLength(taskPageMaximum, "Task page is outside its budget"),
    v.check(newestTaskOrderIsStable, "Task page order is invalid")
);
const listTasksResultObjectSchema = v.strictObject({
    nextCursor: v.optional(taskCursorSchema),
    tasks: taskPageSchema,
});

type ListTasksResultValue = v.InferOutput<typeof listTasksResultObjectSchema>;

/**
 * @param result Candidate task page and cursor.
 * @returns Whether a task continuation cursor identifies the returned last row.
 */
export function taskPageCursorIsConsistent(result: ListTasksResultValue): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.tasks.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.updatedAtMs === result.nextCursor.updatedAtMs
    );
}

/** One bounded task page plus an exact continuation cursor. */
export const listTasksResultSchema = v.pipe(
    listTasksResultObjectSchema,
    v.check(taskPageCursorIsConsistent, "Task page cursor is inconsistent")
);

/** Empty authenticated request for the persisted task-label catalog. */
export const listTaskLabelsInputSchema = v.strictObject({});

const taskLabelSuggestionListSchema = v.pipe(
    v.array(taskLabelSchema, "Task label suggestions are invalid"),
    v.maxLength(
        taskLabelSuggestionMaximum,
        "Task label suggestions are outside their budget"
    ),
    v.check(hasUniqueArrayItems<string>, "Task label suggestions must be unique"),
    v.check(taskStringsAreSorted, "Task label suggestions must use canonical order"),
    v.transform(freezeTaskStrings)
);

/** Bounded canonical catalog of distinct labels persisted across all tasks. */
export const listTaskLabelsResultSchema = v.strictObject({
    labels: taskLabelSuggestionListSchema,
    truncated: v.boolean("Task label suggestion truncation state is invalid"),
});

/** Exact task lookup request. */
export const getTaskInputSchema = v.strictObject({ id: taskIdSchema });

/** One bounded, stable progress-list request. */
export const listTaskProgressInputSchema = v.strictObject({
    cursor: v.optional(taskProgressCursorSchema),
    limit: v.optional(taskProgressPageLimitSchema, taskProgressPageDefault),
    taskId: taskIdSchema,
});

/**
 * @param updates Candidate task progress page.
 * @returns Whether a progress page uses strict newest-first cursor order.
 */
export function newestProgressOrderIsStable(updates: TaskProgressUpdate[]): boolean {
    return updates.every((update, index) => {
        const previous = updates[index - 1];
        return (
            previous === undefined ||
            update.createdAtMs < previous.createdAtMs ||
            (update.createdAtMs === previous.createdAtMs && update.id < previous.id)
        );
    });
}

const taskProgressPageSchema = v.pipe(
    v.array(taskProgressUpdateSchema, "Task progress page is invalid"),
    v.maxLength(taskProgressPageMaximum, "Task progress page is outside its budget"),
    v.check(newestProgressOrderIsStable, "Task progress page order is invalid")
);
const listTaskProgressResultObjectSchema = v.strictObject({
    nextCursor: v.optional(taskProgressCursorSchema),
    updates: taskProgressPageSchema,
});

type ListTaskProgressResultValue = v.InferOutput<
    typeof listTaskProgressResultObjectSchema
>;

/**
 * @param result Candidate task progress page and cursor.
 * @returns Whether a progress continuation cursor identifies the returned last row.
 */
export function taskProgressPageCursorIsConsistent(
    result: ListTaskProgressResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.updates.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.createdAtMs === result.nextCursor.createdAtMs
    );
}

/** One bounded progress page plus an exact continuation cursor. */
export const listTaskProgressResultSchema = v.pipe(
    listTaskProgressResultObjectSchema,
    v.check(
        taskProgressPageCursorIsConsistent,
        "Task progress page cursor is inconsistent"
    )
);

/** Task creation request; identity and actor fields remain server-owned. */
export const createTaskInputSchema = v.strictObject({
    assignee: v.optional(taskAssigneeIdSchema),
    automation: v.optional(taskAutomationProfileInputSchema),
    bodyMarkdown: v.optional(taskBodyMarkdownSchema),
    labels: v.optional(taskLabelInputSchema),
    priority: v.optional(taskPrioritySchema),
    status: v.optional(taskStatusSchema),
    title: taskTitleSchema,
});

const updateTaskPatchObjectSchema = v.strictObject({
    automation: v.optional(v.nullable(taskAutomationProfileInputSchema)),
    bodyMarkdown: v.optional(v.nullable(taskBodyMarkdownSchema)),
    labels: v.optional(taskLabelInputSchema),
    priority: v.optional(taskPrioritySchema),
    title: v.optional(taskTitleSchema),
});

type UpdateTaskPatchValue = v.InferOutput<typeof updateTaskPatchObjectSchema>;

/**
 * @param patch Candidate task patch.
 * @returns Whether a task patch contains at least one explicit field.
 */
export function taskPatchHasChange(patch: UpdateTaskPatchValue): boolean {
    return Object.values(patch).some((value) => value !== undefined);
}

/** General versioned task edit excluding separately audited assignment and movement. */
export const updateTaskInputSchema = v.strictObject({
    expectedVersion: taskVersionSchema,
    id: taskIdSchema,
    patch: v.pipe(
        updateTaskPatchObjectSchema,
        v.check(taskPatchHasChange, "Task update cannot be empty")
    ),
});

const existingTaskMutationEntries = {
    expectedVersion: taskVersionSchema,
    id: taskIdSchema,
};

/** Versioned task-assignment mutation. Null explicitly clears the assignee. */
export const assignTaskInputSchema = v.strictObject({
    ...existingTaskMutationEntries,
    assignee: v.nullable(taskAssigneeIdSchema),
});

/** Versioned task-column movement mutation. */
export const moveTaskInputSchema = v.strictObject({
    ...existingTaskMutationEntries,
    status: taskStatusSchema,
});

/** Versioned task deletion mutation. */
export const deleteTaskInputSchema = v.strictObject(existingTaskMutationEntries);

export const taskDeletionResultSchema = v.strictObject({
    deletedAtMs: taskTimestampSchema,
    id: taskIdSchema,
});

/** Adds one immutable-author progress entry to an existing task. */
export const addTaskProgressInputSchema = v.strictObject({
    messageMarkdown: taskProgressMarkdownSchema,
    taskId: taskIdSchema,
});

/** Edits one progress entry without permitting author reassignment. */
export const updateTaskProgressInputSchema = v.strictObject({
    expectedVersion: taskVersionSchema,
    messageMarkdown: taskProgressMarkdownSchema,
    taskId: taskIdSchema,
    updateId: taskProgressUpdateIdSchema,
});

/** Deletes one progress entry under optimistic concurrency control. */
export const deleteTaskProgressInputSchema = v.strictObject({
    expectedVersion: taskVersionSchema,
    taskId: taskIdSchema,
    updateId: taskProgressUpdateIdSchema,
});

export const taskProgressDeletionResultSchema = v.strictObject({
    deletedAtMs: taskTimestampSchema,
    taskId: taskIdSchema,
    updateId: taskProgressUpdateIdSchema,
});

const taskReadAccess = {
    capabilities: ["tasks:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const taskWriteAccess = {
    capabilities: ["tasks:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const taskQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const taskMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const taskContentMutationTransport = {
    ...taskMutationTransport,
    requestBody: "task-content",
} as const;
const taskProgressMutationTransport = {
    ...taskMutationTransport,
    requestBody: "task-progress",
} as const;
const existingTaskMutationErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;

/** Implemented task-domain procedure metadata. */
export const taskProcedureContracts = [
    {
        access: taskReadAccess,
        domain: "tasks",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listTasksInputSchema,
        inputSchemaId: "tasks.list.input",
        kind: "query",
        name: "tasks.list",
        output: listTasksResultSchema,
        outputSchemaId: "tasks.list.output",
        summary: "Lists one stable filtered page of task-board rows.",
        transport: taskQueryTransport,
    },
    {
        access: taskReadAccess,
        domain: "tasks",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listTaskLabelsInputSchema,
        inputSchemaId: "tasks.listLabels.input",
        kind: "query",
        name: "tasks.listLabels",
        output: listTaskLabelsResultSchema,
        outputSchemaId: "tasks.listLabels.output",
        summary: "Lists a bounded canonical catalog of distinct persisted task labels.",
        transport: taskQueryTransport,
    },
    {
        access: taskReadAccess,
        domain: "tasks",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: getTaskInputSchema,
        inputSchemaId: "tasks.get.input",
        kind: "query",
        name: "tasks.get",
        output: taskDetailSchema,
        outputSchemaId: "tasks.get.output",
        summary: "Loads one complete task for detail editing.",
        transport: taskQueryTransport,
    },
    {
        access: taskReadAccess,
        domain: "tasks",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: listTaskProgressInputSchema,
        inputSchemaId: "tasks.listUpdates.input",
        kind: "query",
        name: "tasks.listUpdates",
        output: listTaskProgressResultSchema,
        outputSchemaId: "tasks.listUpdates.output",
        summary: "Lists one stable newest-first page of task progress entries.",
        transport: taskQueryTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: createTaskInputSchema,
        inputSchemaId: "tasks.create.input",
        kind: "mutation",
        name: "tasks.create",
        output: taskDetailSchema,
        outputSchemaId: "tasks.create.output",
        summary: "Creates one task with server-owned identity and audit history.",
        transport: taskContentMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: updateTaskInputSchema,
        inputSchemaId: "tasks.update.input",
        kind: "mutation",
        name: "tasks.update",
        output: taskDetailSchema,
        outputSchemaId: "tasks.update.output",
        summary: "Updates task content under optimistic concurrency control.",
        transport: taskContentMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: assignTaskInputSchema,
        inputSchemaId: "tasks.assign.input",
        kind: "mutation",
        name: "tasks.assign",
        output: taskDetailSchema,
        outputSchemaId: "tasks.assign.output",
        summary: "Assigns or unassigns a task under optimistic concurrency control.",
        transport: taskMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: moveTaskInputSchema,
        inputSchemaId: "tasks.move.input",
        kind: "mutation",
        name: "tasks.move",
        output: taskDetailSchema,
        outputSchemaId: "tasks.move.output",
        summary:
            "Moves a task between board columns under optimistic concurrency control.",
        transport: taskMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: deleteTaskInputSchema,
        inputSchemaId: "tasks.delete.input",
        kind: "mutation",
        name: "tasks.delete",
        output: taskDeletionResultSchema,
        outputSchemaId: "tasks.delete.output",
        summary:
            "Deletes a version-matched task and mutable relationships while retaining append-only events.",
        transport: taskMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: addTaskProgressInputSchema,
        inputSchemaId: "tasks.addUpdate.input",
        kind: "mutation",
        name: "tasks.addUpdate",
        output: taskProgressUpdateSchema,
        outputSchemaId: "tasks.addUpdate.output",
        summary: "Appends one authenticated progress update to a task.",
        transport: taskProgressMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: updateTaskProgressInputSchema,
        inputSchemaId: "tasks.updateProgress.input",
        kind: "mutation",
        name: "tasks.updateProgress",
        output: taskProgressUpdateSchema,
        outputSchemaId: "tasks.updateProgress.output",
        summary: "Edits one task progress entry under optimistic concurrency control.",
        transport: taskProgressMutationTransport,
    },
    {
        access: taskWriteAccess,
        domain: "tasks",
        errors: existingTaskMutationErrors,
        input: deleteTaskProgressInputSchema,
        inputSchemaId: "tasks.deleteProgress.input",
        kind: "mutation",
        name: "tasks.deleteProgress",
        output: taskProgressDeletionResultSchema,
        outputSchemaId: "tasks.deleteProgress.output",
        summary: "Deletes one version-matched task progress entry.",
        transport: taskMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type AddTaskProgressInput = v.InferOutput<typeof addTaskProgressInputSchema>;
export type AssignTaskInput = v.InferOutput<typeof assignTaskInputSchema>;
export type CreateTaskInput = v.InferOutput<typeof createTaskInputSchema>;
export type DeleteTaskInput = v.InferOutput<typeof deleteTaskInputSchema>;
export type DeleteTaskProgressInput = v.InferOutput<typeof deleteTaskProgressInputSchema>;
export type DeleteTaskProgressResult = v.InferOutput<
    typeof taskProgressDeletionResultSchema
>;
export type DeleteTaskResult = v.InferOutput<typeof taskDeletionResultSchema>;
export type GetTaskInput = v.InferOutput<typeof getTaskInputSchema>;
export type ListTaskLabelsInput = v.InferOutput<typeof listTaskLabelsInputSchema>;
export type ListTaskLabelsResult = v.InferOutput<typeof listTaskLabelsResultSchema>;
export type ListTaskProgressInput = v.InferOutput<typeof listTaskProgressInputSchema>;
export type ListTaskProgressResult = v.InferOutput<typeof listTaskProgressResultSchema>;
export type ListTasksInput = v.InferOutput<typeof listTasksInputSchema>;
export type ListTasksResult = v.InferOutput<typeof listTasksResultSchema>;
export type MoveTaskInput = v.InferOutput<typeof moveTaskInputSchema>;
export type UpdateTaskInput = v.InferOutput<typeof updateTaskInputSchema>;
export type UpdateTaskProgressInput = v.InferOutput<typeof updateTaskProgressInputSchema>;
