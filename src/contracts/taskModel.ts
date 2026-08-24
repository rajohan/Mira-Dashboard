import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
    securityLabelSchema,
    securityUsernameSchema,
} from "./security.ts";

/** Stable task-board columns in their displayed order. */
export const taskStatuses = ["todo", "in-progress", "blocked", "done"] as const;

/** Stable task-priority values in increasing urgency order. */
export const taskPriorities = ["low", "medium", "high"] as const;

/** Dashboard identities that can own task execution. */
export const taskAssigneeIds = ["mira-2026", "rajohan"] as const;

export const taskAssignees = Object.freeze([
    Object.freeze({ id: taskAssigneeIds[0], label: "Mira" }),
    Object.freeze({ id: taskAssigneeIds[1], label: "Raymond" }),
] as const);

/** Maximum number of labels accepted on one task. */
export const taskMaximumLabels = 20;

/** Maximum Unicode code points in one task label. */
export const taskLabelMaximumLength = 64;

/** Maximum Unicode code points in one task title. */
export const taskTitleMaximumLength = 240;

/** Maximum Unicode code points in a task body. */
export const taskBodyMaximumLength = 100_000;

/** Maximum Unicode code points in one compact automation field. */
export const taskAutomationTextMaximumLength = 200;

/** Maximum Unicode code points in an automation schedule summary. */
export const taskAutomationScheduleSummaryMaximumLength = 500;

/** Maximum Unicode code points in one progress update. */
export const taskProgressMaximumLength = 20_000;

export type TaskStatus = (typeof taskStatuses)[number];
export type TaskPriority = (typeof taskPriorities)[number];
export type TaskAssigneeId = (typeof taskAssigneeIds)[number];

export const taskIdSchema = lowercaseUuidV7Schema("Task id is invalid");
export const taskProgressUpdateIdSchema = lowercaseUuidV7Schema(
    "Task progress update id is invalid"
);
export const taskNumberSchema = positiveSafeIntegerSchema("Task number is invalid");
export const taskStatusSchema = v.picklist(taskStatuses, "Task status is invalid");
export const taskPrioritySchema = v.picklist(taskPriorities, "Task priority is invalid");
export const taskAssigneeIdSchema = v.picklist(
    taskAssigneeIds,
    "Task assignee is invalid"
);
export const taskVersionSchema = positiveSafeIntegerSchema("Task version is invalid");

/**
 * @param value Candidate compact task text.
 * @returns Whether compact task text has canonical outer whitespace.
 */
export function taskTextIsTrimmed(value: string): boolean {
    return value === value.trim();
}

function canonicalControlSafeTextSchema(maximumLength: number, message: string) {
    return v.pipe(
        boundedControlSafeTextSchema(maximumLength, message),
        v.check(taskTextIsTrimmed, message)
    );
}

export const taskTitleSchema = canonicalControlSafeTextSchema(
    taskTitleMaximumLength,
    "Use 1–240 visible characters with no leading or trailing spaces."
);
export const taskLabelSchema = canonicalControlSafeTextSchema(
    taskLabelMaximumLength,
    "Use no more than 64 visible characters with no leading or trailing spaces."
);
export const taskBodyMarkdownSchema = boundedNonBlankTextSchema(
    taskBodyMaximumLength,
    "Use no more than 100,000 characters and include non-space text, or leave it blank."
);
export const taskProgressMarkdownSchema = boundedNonBlankTextSchema(
    taskProgressMaximumLength,
    "Enter a progress update of no more than 20,000 characters."
);

/**
 * @param labels Candidate task strings.
 * @returns Whether task strings use stable code-unit order.
 */
export function taskStringsAreSorted(labels: string[]): boolean {
    return labels.every((label, index) => {
        const previous = labels[index - 1];
        return previous === undefined || previous < label;
    });
}

/**
 * @param labels Candidate task strings.
 * @returns One immutable task-string sequence without changing its order.
 */
export function freezeTaskStrings(labels: string[]): readonly string[] {
    return Object.freeze([...labels]);
}

/**
 * @param values Candidate task strings.
 * @returns One immutable task-string sequence in stable code-unit order.
 */
export function canonicalizeTaskStrings<TValue extends string>(
    values: TValue[]
): readonly TValue[] {
    return Object.freeze(values.toSorted(compareStrings));
}

/** Shared bounded task-label sequence before input/output canonicalization. */
export const taskLabelArraySchema = v.pipe(
    v.array(
        taskLabelSchema,
        "Use at most 20 unique labels; each label may contain up to 64 visible characters."
    ),
    v.maxLength(
        taskMaximumLabels,
        "Use at most 20 unique labels; each label may contain up to 64 visible characters."
    ),
    v.check(
        hasUniqueArrayItems<string>,
        "Use at most 20 unique labels; each label may contain up to 64 visible characters."
    )
);

/** Canonical task-label list accepted from callers. */
export const taskLabelInputSchema = v.pipe(
    taskLabelArraySchema,
    v.transform(canonicalizeTaskStrings)
);

/** Canonical task-label list emitted by persistence and transport boundaries. */
export const taskLabelListSchema = v.pipe(
    taskLabelArraySchema,
    v.check(taskStringsAreSorted, "Task labels must use canonical order"),
    v.transform(freezeTaskStrings)
);

const taskAutomationTextSchema = canonicalControlSafeTextSchema(
    taskAutomationTextMaximumLength,
    "Task automation value is invalid"
);
const taskScheduleSummarySchema = canonicalControlSafeTextSchema(
    taskAutomationScheduleSummaryMaximumLength,
    "Task automation schedule summary is invalid"
);
const taskAutomationBaseEntries = {
    cronJobId: taskAutomationTextSchema,
    kind: v.literal("openclaw-cron"),
    model: v.optional(taskAutomationTextSchema),
    scheduleSummary: v.optional(taskScheduleSummarySchema),
    sessionTarget: v.optional(taskAutomationTextSchema),
    thinking: v.optional(taskAutomationTextSchema),
};

/** Persisted task-to-OpenClaw automation link without mutable run projection. */
export const taskAutomationProfileSchema = v.strictObject({
    ...taskAutomationBaseEntries,
    recurring: v.boolean(),
});

/** Caller-provided task automation settings. */
export const taskAutomationProfileInputSchema = v.strictObject({
    ...taskAutomationBaseEntries,
    recurring: v.optional(v.boolean(), true),
});

const taskTimestampSchema = timestampMillisecondsSchema("Task timestamp is invalid");
const taskBaseEntries = {
    assignee: v.optional(taskAssigneeIdSchema),
    automation: v.optional(taskAutomationProfileSchema),
    createdAtMs: taskTimestampSchema,
    id: taskIdSchema,
    labels: taskLabelListSchema,
    number: taskNumberSchema,
    priority: taskPrioritySchema,
    status: taskStatusSchema,
    title: taskTitleSchema,
    updatedAtMs: taskTimestampSchema,
    version: taskVersionSchema,
};

const taskSummaryObjectSchema = v.strictObject(taskBaseEntries);
type TaskSummaryValue = v.InferOutput<typeof taskSummaryObjectSchema>;

const taskDetailObjectSchema = v.strictObject({
    ...taskBaseEntries,
    bodyMarkdown: v.optional(taskBodyMarkdownSchema),
});
type TaskDetailValue = v.InferOutput<typeof taskDetailObjectSchema>;

/**
 * Checks creation and update timestamp ordering on a task.
 * @param task Candidate task output.
 * @returns Whether the update timestamp follows creation.
 */
export function taskTimesAreOrdered(task: TaskSummaryValue): boolean {
    return task.updatedAtMs >= task.createdAtMs;
}

/**
 * @param task Candidate complete task output.
 * @returns Whether a complete task's update timestamp follows creation.
 */
export function taskDetailTimesAreOrdered(task: TaskDetailValue): boolean {
    return task.updatedAtMs >= task.createdAtMs;
}

/** Task row used by list and realtime cache surfaces. */
export const taskSummarySchema = v.pipe(
    taskSummaryObjectSchema,
    v.check(taskTimesAreOrdered, "Task timestamps are inconsistent")
);

/** Complete task row loaded for the detail editor. */
export const taskDetailSchema = v.pipe(
    taskDetailObjectSchema,
    v.check(taskDetailTimesAreOrdered, "Task timestamps are inconsistent")
);

/** Authenticated identity that authored one task progress entry. */
export const taskProgressAuthorSchema = v.variant("kind", [
    v.strictObject({
        id: automationPrincipalIdSchema,
        kind: v.literal("automation"),
        label: securityLabelSchema,
    }),
    v.strictObject({
        id: securityRecordIdSchema,
        kind: v.literal("user"),
        username: securityUsernameSchema,
    }),
]);

const taskProgressUpdateObjectSchema = v.strictObject({
    author: taskProgressAuthorSchema,
    createdAtMs: taskTimestampSchema,
    id: taskProgressUpdateIdSchema,
    messageMarkdown: taskProgressMarkdownSchema,
    taskId: taskIdSchema,
    updatedAtMs: taskTimestampSchema,
    version: taskVersionSchema,
});

type TaskProgressUpdateValue = v.InferOutput<typeof taskProgressUpdateObjectSchema>;

/**
 * Checks creation and update ordering on one task progress entry.
 * @param update Candidate task progress output.
 * @returns Whether its update timestamp follows creation.
 */
export function taskProgressTimesAreOrdered(update: TaskProgressUpdateValue): boolean {
    return update.updatedAtMs >= update.createdAtMs;
}

/** Immutable-author task progress entry with versioned editable content. */
export const taskProgressUpdateSchema = v.pipe(
    taskProgressUpdateObjectSchema,
    v.check(taskProgressTimesAreOrdered, "Task progress timestamps are inconsistent")
);

export type TaskAutomationProfile = v.InferOutput<typeof taskAutomationProfileSchema>;
export type TaskAutomationProfileInput = v.InferOutput<
    typeof taskAutomationProfileInputSchema
>;
export type TaskDetail = v.InferOutput<typeof taskDetailSchema>;
export type TaskProgressAuthor = v.InferOutput<typeof taskProgressAuthorSchema>;
export type TaskProgressUpdate = v.InferOutput<typeof taskProgressUpdateSchema>;
export type TaskSummary = v.InferOutput<typeof taskSummarySchema>;
