import * as v from "valibot";

import {
    taskAssigneeIds,
    taskAutomationScheduleSummaryMaximumLength,
    taskAutomationTextMaximumLength,
    taskAutomationProfileInputSchema,
    taskBodyMarkdownSchema,
    type TaskDetail,
    taskLabelInputSchema,
    taskLabelMaximumLength,
    taskMaximumLabels,
    taskPriorities,
    taskStatuses,
    taskTextIsTrimmed,
    taskTitleSchema,
} from "../../contracts/taskModel.ts";
import type { CreateTaskInput, UpdateTaskInput } from "../../contracts/tasks.ts";
import { boundedControlSafeTextSchema } from "../../shared/validation.ts";

export const unassignedTaskOwner = "unassigned";
const defaultTaskOwner = "mira-2026" satisfies (typeof taskAssigneeIds)[number];

const optionalBodySchema = v.union([v.literal(""), taskBodyMarkdownSchema]);
function optionalCanonicalAutomationTextSchema(maximumLength: number, message: string) {
    return v.union([
        v.literal(""),
        v.pipe(
            boundedControlSafeTextSchema(maximumLength, message),
            v.check(taskTextIsTrimmed, message)
        ),
    ]);
}

const optionalAutomationTextSchema = optionalCanonicalAutomationTextSchema(
    taskAutomationTextMaximumLength,
    "Use no more than 200 visible characters with no leading or trailing spaces, or leave it blank."
);
const optionalScheduleSummarySchema = optionalCanonicalAutomationTextSchema(
    taskAutomationScheduleSummaryMaximumLength,
    "Use no more than 500 visible characters with no leading or trailing spaces, or leave it blank."
);

function automationTextIsValid(enabled: boolean, value: string): boolean {
    return !enabled || v.safeParse(optionalAutomationTextSchema, value).success;
}

function automationScheduleSummaryIsValid(enabled: boolean, value: string): boolean {
    return !enabled || v.safeParse(optionalScheduleSummarySchema, value).success;
}

function rawTaskLabelsFromText(value: string): string[] {
    return value
        .split(/\r?\n/u)
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
}

/**
 * Converts the editor's serialized label value to canonical contract labels.
 * @param value Browser label field.
 * @returns Validated, sorted task labels.
 */
export function taskLabelsFromText(value: string): readonly string[] {
    return v.parse(taskLabelInputSchema, rawTaskLabelsFromText(value));
}

const taskLabelsTextSchema = v.pipe(
    v.string("Add labels, or leave them blank."),
    v.maxLength(
        taskMaximumLabels * (taskLabelMaximumLength * 2 + 2),
        "Use at most 20 unique labels. Each label may contain up to 64 visible characters."
    ),
    v.check(
        (value) =>
            v.safeParse(taskLabelInputSchema, rawTaskLabelsFromText(value)).success,
        "Use at most 20 unique labels. Each label may contain up to 64 visible characters."
    )
);

const taskEditorObjectSchema = v.strictObject({
    assignee: v.picklist([...taskAssigneeIds, unassignedTaskOwner]),
    automationCronJobId: v.string("Enter a cron job ID, or leave it blank."),
    automationEnabled: v.boolean(),
    automationModel: v.string("Enter a model, or leave it blank."),
    automationRecurring: v.boolean(),
    automationScheduleSummary: v.string("Enter a schedule summary, or leave it blank."),
    automationSessionTarget: v.string("Enter a session target, or leave it blank."),
    automationThinking: v.string("Enter a thinking level, or leave it blank."),
    bodyMarkdown: optionalBodySchema,
    labelsText: taskLabelsTextSchema,
    priority: v.picklist(taskPriorities),
    status: v.picklist(taskStatuses),
    title: taskTitleSchema,
});

/** Browser editor values validated before mapping to public task contracts. */
export const taskEditorFormSchema = v.pipe(
    taskEditorObjectSchema,
    v.forward(
        v.check(
            (value) => !value.automationEnabled || value.automationCronJobId.length > 0,
            "Cron job id is required when automation is enabled"
        ),
        ["automationCronJobId"]
    ),
    v.forward(
        v.check(
            (value) =>
                automationTextIsValid(value.automationEnabled, value.automationCronJobId),
            "Use no more than 200 visible characters with no leading or trailing spaces, or leave it blank."
        ),
        ["automationCronJobId"]
    ),
    v.forward(
        v.check(
            (value) =>
                automationTextIsValid(value.automationEnabled, value.automationModel),
            "Use no more than 200 visible characters with no leading or trailing spaces, or leave it blank."
        ),
        ["automationModel"]
    ),
    v.forward(
        v.check(
            (value) =>
                automationScheduleSummaryIsValid(
                    value.automationEnabled,
                    value.automationScheduleSummary
                ),
            "Use no more than 500 visible characters with no leading or trailing spaces, or leave it blank."
        ),
        ["automationScheduleSummary"]
    ),
    v.forward(
        v.check(
            (value) =>
                automationTextIsValid(
                    value.automationEnabled,
                    value.automationSessionTarget
                ),
            "Use no more than 200 visible characters with no leading or trailing spaces, or leave it blank."
        ),
        ["automationSessionTarget"]
    ),
    v.forward(
        v.check(
            (value) =>
                automationTextIsValid(value.automationEnabled, value.automationThinking),
            "Use no more than 200 visible characters with no leading or trailing spaces, or leave it blank."
        ),
        ["automationThinking"]
    )
);

export type TaskEditorValues = v.InferOutput<typeof taskEditorFormSchema>;

/** @returns Stable initial values for create or edit mode. */
export function taskEditorValues(task?: TaskDetail): TaskEditorValues {
    return {
        assignee: task?.assignee ?? defaultTaskOwner,
        automationCronJobId: task?.automation?.cronJobId ?? "",
        automationEnabled: task?.automation !== undefined,
        automationModel: task?.automation?.model ?? "",
        automationRecurring: task?.automation?.recurring ?? true,
        automationScheduleSummary: task?.automation?.scheduleSummary ?? "",
        automationSessionTarget: task?.automation?.sessionTarget ?? "",
        automationThinking: task?.automation?.thinking ?? "",
        bodyMarkdown: task?.bodyMarkdown ?? "",
        labelsText: task?.labels.join("\n") ?? "",
        priority: task?.priority ?? "medium",
        status: task?.status ?? "todo",
        title: task?.title ?? "",
    };
}

function optionalValue(value: string): string | undefined {
    return value.length === 0 ? undefined : value;
}

function taskAutomationFromEditor(values: TaskEditorValues) {
    if (!values.automationEnabled) return;
    return v.parse(taskAutomationProfileInputSchema, {
        cronJobId: values.automationCronJobId,
        kind: "openclaw-cron",
        ...(optionalValue(values.automationModel) === undefined
            ? {}
            : { model: values.automationModel }),
        recurring: values.automationRecurring,
        ...(optionalValue(values.automationScheduleSummary) === undefined
            ? {}
            : { scheduleSummary: values.automationScheduleSummary }),
        ...(optionalValue(values.automationSessionTarget) === undefined
            ? {}
            : { sessionTarget: values.automationSessionTarget }),
        ...(optionalValue(values.automationThinking) === undefined
            ? {}
            : { thinking: values.automationThinking }),
    });
}

/** @returns Validated create request derived from browser editor values. */
export function createTaskInputFromEditor(values: TaskEditorValues): CreateTaskInput {
    const automation = taskAutomationFromEditor(values);
    return {
        ...(values.assignee === unassignedTaskOwner ? {} : { assignee: values.assignee }),
        ...(automation === undefined ? {} : { automation }),
        ...(values.bodyMarkdown.length === 0
            ? {}
            : { bodyMarkdown: values.bodyMarkdown }),
        labels: taskLabelsFromText(values.labelsText),
        priority: values.priority,
        status: values.status,
        title: values.title,
    };
}

/** @returns Validated versioned content update derived from editor values. */
export function updateTaskInputFromEditor(
    task: TaskDetail,
    values: TaskEditorValues
): UpdateTaskInput {
    return {
        expectedVersion: task.version,
        id: task.id,
        patch: {
            automation: taskAutomationFromEditor(values) ?? null,
            bodyMarkdown: values.bodyMarkdown.length === 0 ? null : values.bodyMarkdown,
            labels: taskLabelsFromText(values.labelsText),
            priority: values.priority,
            title: values.title,
        },
    };
}
