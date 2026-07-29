import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    positiveIntegerSchema,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const TASK_ASSIGNEES = {
    mira: {
        id: "mira-2026",
        label: "Mira",
        githubUrl: "https://github.com/mira-2026",
    },
    raymond: {
        id: "rajohan",
        label: "Raymond",
        githubUrl: "https://github.com/rajohan",
    },
} as const;

export const TASK_ASSIGNEE_IDS = [
    TASK_ASSIGNEES.mira.id,
    TASK_ASSIGNEES.raymond.id,
] as const;
export const TASK_COLUMNS = ["todo", "in-progress", "blocked", "done"] as const;

export const taskAssigneeIdSchema = v.picklist(TASK_ASSIGNEE_IDS);
export const taskColumnSchema = v.picklist(TASK_COLUMNS);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export const taskAutomationSchema = v.strictObject({
    cronJobId: trimmedNonEmptyStringSchema,
    enabled: v.optional(v.boolean()),
    jobName: v.optional(v.string()),
    lastDurationMs: v.optional(finiteNumberSchema),
    lastRunAtMs: v.optional(finiteNumberSchema),
    lastRunStatus: v.optional(v.string()),
    model: v.optional(v.string()),
    nextRunAtMs: v.optional(finiteNumberSchema),
    recurring: v.boolean(),
    runningAtMs: v.optional(finiteNumberSchema),
    schedule: v.optional(jsonObjectSchema),
    scheduleSummary: v.optional(v.string()),
    sessionTarget: v.optional(v.string()),
    source: v.optional(v.picklist(["cron", "stored"])),
    thinking: v.optional(v.string()),
    type: v.literal("cron"),
});

export const taskAutomationInputSchema = v.pipe(
    v.strictObject({
        cronJobId: trimmedNonEmptyStringSchema,
        model: v.optional(v.string()),
        recurring: v.optional(v.boolean()),
        scheduleSummary: v.optional(v.string()),
        sessionTarget: v.optional(v.string()),
        thinking: v.optional(v.string()),
        type: v.optional(v.literal("cron")),
    }),
    v.transform((input) => {
        const model = input.model?.trim();
        const scheduleSummary = input.scheduleSummary?.trim();
        const sessionTarget = input.sessionTarget?.trim();
        const thinking = input.thinking?.trim();
        return {
            cronJobId: input.cronJobId,
            ...(model && { model }),
            ...(input.recurring !== undefined && { recurring: input.recurring }),
            ...(scheduleSummary && { scheduleSummary }),
            ...(sessionTarget && { sessionTarget }),
            ...(thinking && { thinking }),
            ...(input.type !== undefined && { type: input.type }),
        };
    })
);

const taskAssigneeSchema = v.object({
    avatar_url: v.optional(v.string()),
    login: v.optional(v.string()),
    name: v.optional(v.string()),
});

const taskLabelSchema = v.object({
    color: v.optional(v.string()),
    name: v.string(),
});

export const taskSchema = v.strictObject({
    assignees: v.array(taskAssigneeSchema),
    automation: v.optional(taskAutomationSchema),
    body: v.optional(v.string()),
    createdAt: nonBlankStringSchema,
    labels: v.array(taskLabelSchema),
    number: positiveIntegerSchema,
    state: trimmedNonEmptyStringSchema,
    title: v.string(),
    updatedAt: nonBlankStringSchema,
    url: v.string(),
});

export const taskUpdateSchema = v.strictObject({
    author: taskAssigneeIdSchema,
    createdAt: nonBlankStringSchema,
    id: positiveIntegerSchema,
    messageMd: nonBlankStringSchema,
    taskId: positiveIntegerSchema,
});

export const taskCreateRequestSchema = strictJsonObjectSchema({
    assignee: v.optional(v.nullable(taskAssigneeIdSchema)),
    automation: v.optional(taskAutomationInputSchema),
    body: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    title: trimmedNonEmptyStringSchema,
});

export const updateTaskRequestSchema = strictJsonObjectSchema({
    automation: v.optional(v.nullable(taskAutomationInputSchema)),
    body: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    title: v.optional(trimmedNonEmptyStringSchema),
});

export const assignTaskRequestSchema = strictJsonObjectSchema({
    assignee: v.optional(v.nullable(taskAssigneeIdSchema)),
});

export const moveTaskRequestSchema = strictJsonObjectSchema({
    columnLabel: taskColumnSchema,
});

export const taskUpdateCreateRequestSchema = strictJsonObjectSchema({
    author: taskAssigneeIdSchema,
    messageMd: nonBlankStringSchema,
});

export const updateTaskUpdateRequestSchema = strictJsonObjectSchema({
    messageMd: nonBlankStringSchema,
});

export const taskMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export type TaskAssigneeId = v.InferOutput<typeof taskAssigneeIdSchema>;
export type ColumnId = v.InferOutput<typeof taskColumnSchema>;
export type TaskAutomation = v.InferOutput<typeof taskAutomationSchema>;
export type TaskAutomationInput = v.InferOutput<typeof taskAutomationInputSchema>;
export type Task = v.InferOutput<typeof taskSchema>;
export type TaskUpdate = v.InferOutput<typeof taskUpdateSchema>;
export type CreateTaskRequest = v.InferOutput<typeof taskCreateRequestSchema>;
export type UpdateTaskRequest = v.InferOutput<typeof updateTaskRequestSchema>;
export type AssignTaskRequest = v.InferOutput<typeof assignTaskRequestSchema>;
export type MoveTaskRequest = v.InferOutput<typeof moveTaskRequestSchema>;
export type CreateTaskUpdateRequest = v.InferOutput<typeof taskUpdateCreateRequestSchema>;
export type UpdateTaskUpdateRequest = v.InferOutput<typeof updateTaskUpdateRequestSchema>;
export type TaskMutationResponse = v.InferOutput<typeof taskMutationResponseSchema>;

/**
 * Parses the reusable task-automation request fragment.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the reusable task-automation request fragment.
 */
export function parseTaskAutomationInput(
    value: unknown,
    path = "body.automation"
): TaskAutomationInput {
    return parseContract(taskAutomationInputSchema, value, path);
}

/**
 * Parses task creation at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed task creation at the backend HTTP trust boundary.
 */
export function parseCreateTaskRequest(value: unknown): CreateTaskRequest {
    return parseContract(taskCreateRequestSchema, value);
}

/**
 * Parses a task patch without accepting unknown or mistyped fields.
 * @param value Value to process.
 * @returns Parsed a task patch without accepting unknown or mistyped fields.
 */
export function parseUpdateTaskRequest(value: unknown): UpdateTaskRequest {
    return parseContract(updateTaskRequestSchema, value);
}

export function parseAssignTaskRequest(value: unknown): AssignTaskRequest {
    return parseContract(assignTaskRequestSchema, value);
}

export function parseMoveTaskRequest(value: unknown): MoveTaskRequest {
    return parseContract(moveTaskRequestSchema, value);
}

export function parseCreateTaskUpdateRequest(value: unknown): CreateTaskUpdateRequest {
    return parseContract(taskUpdateCreateRequestSchema, value);
}

export function parseUpdateTaskUpdateRequest(value: unknown): UpdateTaskUpdateRequest {
    return parseContract(updateTaskUpdateRequestSchema, value);
}

/**
 * Parses one task response before frontend state accepts it.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one task response before frontend state accepts it.
 */
export function parseTaskResponse(value: unknown, path = "response"): Task {
    return parseContract(taskSchema, value, path);
}

export function parseTasksResponse(value: unknown): Task[] {
    return parseContract(v.array(taskSchema), value, "response");
}

export function parseTaskUpdateResponse(value: unknown, path = "response"): TaskUpdate {
    return parseContract(taskUpdateSchema, value, path);
}

export function parseTaskUpdatesResponse(value: unknown): TaskUpdate[] {
    return parseContract(v.array(taskUpdateSchema), value, "response");
}

export function parseTaskMutationResponse(value: unknown): TaskMutationResponse {
    return parseContract(taskMutationResponseSchema, value, "response");
}
