import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { taskIdSchema, taskLabelSchema } from "../../../contracts/taskModel.ts";
import { taskLabels } from "../schema/taskLabels.ts";

const labelRefinements = {
    label: () => taskLabelSchema,
    taskId: () => taskIdSchema,
};
const generatedTaskLabelSelectSchema = createSelectSchema(taskLabels, labelRefinements);
const generatedTaskLabelInsertSchema = createInsertSchema(taskLabels, labelRefinements);

/** Validates one normalized task-label row read from SQLite. */
export const taskLabelSelectSchema = v.strictObject(
    generatedTaskLabelSelectSchema.entries
);

/** Validates one normalized task-label row before insertion. */
export const taskLabelInsertSchema = v.strictObject(
    generatedTaskLabelInsertSchema.entries
);
