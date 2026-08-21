import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    taskAssigneeIdSchema,
    taskBodyMarkdownSchema,
    taskIdSchema,
    taskNumberSchema,
    taskPrioritySchema,
    taskStatusSchema,
    taskTitleSchema,
    taskVersionSchema,
} from "../../../contracts/taskModel.ts";
import { tasks } from "../schema/tasks.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

function taskDatesAreOrdered(task: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
}): boolean {
    return compareAsc(task.updatedAt, task.createdAt) >= 0;
}

const taskRefinements = {
    assignee: () => v.nullable(taskAssigneeIdSchema),
    bodyMarkdown: () => v.nullable(taskBodyMarkdownSchema),
    createdAt: nonnegativeDateSchema,
    id: () => taskIdSchema,
    number: () => taskNumberSchema,
    priority: () => taskPrioritySchema,
    status: () => taskStatusSchema,
    title: () => taskTitleSchema,
    updatedAt: nonnegativeDateSchema,
    version: () => taskVersionSchema,
};

const generatedTaskSelectSchema = createSelectSchema(tasks, taskRefinements);
const taskSelectObjectSchema = v.strictObject(generatedTaskSelectSchema.entries);
type TaskSelectValue = v.InferOutput<typeof taskSelectObjectSchema>;

function selectedTaskDatesAreOrdered(task: TaskSelectValue): boolean {
    return taskDatesAreOrdered(task);
}

/** Validates authoritative rows read from tasks. */
export const taskSelectSchema = v.pipe(
    taskSelectObjectSchema,
    v.check(selectedTaskDatesAreOrdered, "Task timestamps are inconsistent")
);

const generatedTaskInsertSchema = createInsertSchema(tasks, taskRefinements);
const taskInsertObjectSchema = v.strictObject({
    assignee: generatedTaskInsertSchema.entries.assignee,
    bodyMarkdown: generatedTaskInsertSchema.entries.bodyMarkdown,
    createdAt: generatedTaskInsertSchema.entries.createdAt,
    id: generatedTaskInsertSchema.entries.id,
    priority: generatedTaskInsertSchema.entries.priority,
    status: generatedTaskInsertSchema.entries.status,
    title: generatedTaskInsertSchema.entries.title,
    updatedAt: generatedTaskInsertSchema.entries.updatedAt,
});
type TaskInsertValue = v.InferOutput<typeof taskInsertObjectSchema>;

function insertedTaskDatesAreOrdered(task: TaskInsertValue): boolean {
    return taskDatesAreOrdered(task);
}

/** Validates a new task before inserting its default version. */
export const taskInsertSchema = v.pipe(
    taskInsertObjectSchema,
    v.check(insertedTaskDatesAreOrdered, "Task timestamps are inconsistent")
);

const generatedTaskUpdateSchema = createUpdateSchema(tasks, taskRefinements);

/** Validates partial mutable task columns before a versioned update. */
export const taskUpdateSchema = v.strictObject({
    assignee: generatedTaskUpdateSchema.entries.assignee,
    bodyMarkdown: generatedTaskUpdateSchema.entries.bodyMarkdown,
    priority: generatedTaskUpdateSchema.entries.priority,
    status: generatedTaskUpdateSchema.entries.status,
    title: generatedTaskUpdateSchema.entries.title,
    updatedAt: generatedTaskUpdateSchema.entries.updatedAt,
    version: generatedTaskUpdateSchema.entries.version,
});
