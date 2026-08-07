import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
} from "../../../contracts/security.ts";
import {
    taskIdSchema,
    taskProgressMarkdownSchema,
    taskProgressUpdateIdSchema,
    taskVersionSchema,
} from "../../../contracts/taskModel.ts";
import { taskUpdates } from "../schema/taskUpdates.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const taskUpdateAuthorKindSchema = v.picklist(["automation", "user"]);

function taskUpdateAuthorIsValid(update: {
    readonly authorId: string;
    readonly authorKind: "automation" | "user";
}): boolean {
    return v.safeParse(
        update.authorKind === "automation"
            ? automationPrincipalIdSchema
            : securityRecordIdSchema,
        update.authorId
    ).success;
}

function taskUpdateDatesAreOrdered(update: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
}): boolean {
    return compareAsc(update.updatedAt, update.createdAt) >= 0;
}

const taskUpdateRefinements = {
    authorKind: () => taskUpdateAuthorKindSchema,
    createdAt: nonnegativeDateSchema,
    id: () => taskProgressUpdateIdSchema,
    messageMarkdown: () => taskProgressMarkdownSchema,
    taskId: () => taskIdSchema,
    updatedAt: nonnegativeDateSchema,
    version: () => taskVersionSchema,
};
const generatedTaskUpdateSelectSchema = createSelectSchema(
    taskUpdates,
    taskUpdateRefinements
);
const taskProgressSelectObjectSchema = v.strictObject(
    generatedTaskUpdateSelectSchema.entries
);
type TaskProgressSelectValue = v.InferOutput<typeof taskProgressSelectObjectSchema>;

function selectedTaskUpdateAuthorIsValid(update: TaskProgressSelectValue): boolean {
    return taskUpdateAuthorIsValid(update);
}

function selectedTaskUpdateDatesAreOrdered(update: TaskProgressSelectValue): boolean {
    return taskUpdateDatesAreOrdered(update);
}

/** Validates one task progress row read from SQLite. */
export const taskProgressRowSelectSchema = v.pipe(
    taskProgressSelectObjectSchema,
    v.check(selectedTaskUpdateAuthorIsValid, "Task progress author is invalid"),
    v.check(
        selectedTaskUpdateDatesAreOrdered,
        "Task progress timestamps are inconsistent"
    )
);

const generatedTaskUpdateInsertSchema = createInsertSchema(
    taskUpdates,
    taskUpdateRefinements
);
const taskProgressInsertObjectSchema = v.strictObject({
    authorId: generatedTaskUpdateInsertSchema.entries.authorId,
    authorKind: generatedTaskUpdateInsertSchema.entries.authorKind,
    createdAt: generatedTaskUpdateInsertSchema.entries.createdAt,
    id: generatedTaskUpdateInsertSchema.entries.id,
    messageMarkdown: generatedTaskUpdateInsertSchema.entries.messageMarkdown,
    taskId: generatedTaskUpdateInsertSchema.entries.taskId,
    updatedAt: generatedTaskUpdateInsertSchema.entries.updatedAt,
});
type TaskProgressInsertValue = v.InferOutput<typeof taskProgressInsertObjectSchema>;

function insertedTaskUpdateAuthorIsValid(update: TaskProgressInsertValue): boolean {
    return taskUpdateAuthorIsValid(update);
}

function insertedTaskUpdateDatesAreOrdered(update: TaskProgressInsertValue): boolean {
    return taskUpdateDatesAreOrdered(update);
}

/** Validates one task progress row before inserting its default version. */
export const taskProgressRowInsertSchema = v.pipe(
    taskProgressInsertObjectSchema,
    v.check(insertedTaskUpdateAuthorIsValid, "Task progress author is invalid"),
    v.check(
        insertedTaskUpdateDatesAreOrdered,
        "Task progress timestamps are inconsistent"
    )
);

/** Validates the complete mutable progress fields used by one CAS update. */
export const taskProgressRowUpdateSchema = v.strictObject({
    messageMarkdown: taskProgressMarkdownSchema,
    updatedAt: v.pipe(
        v.date(),
        v.check((date) => date.getTime() >= 0)
    ),
    version: taskVersionSchema,
});
