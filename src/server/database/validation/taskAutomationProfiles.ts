import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    taskAutomationProfileSchema,
    taskIdSchema,
} from "../../../contracts/taskModel.ts";
import { taskAutomationProfiles } from "../schema/taskAutomationProfiles.ts";

const automationEntries = taskAutomationProfileSchema.entries;
const automationRefinements = {
    cronJobId: () => automationEntries.cronJobId,
    kind: () => automationEntries.kind,
    model: () => v.nullable(automationEntries.model.wrapped),
    recurring: () => automationEntries.recurring,
    scheduleSummary: () => v.nullable(automationEntries.scheduleSummary.wrapped),
    sessionTarget: () => v.nullable(automationEntries.sessionTarget.wrapped),
    taskId: () => taskIdSchema,
    thinking: () => v.nullable(automationEntries.thinking.wrapped),
};
const generatedAutomationSelectSchema = createSelectSchema(
    taskAutomationProfiles,
    automationRefinements
);
const generatedAutomationInsertSchema = createInsertSchema(
    taskAutomationProfiles,
    automationRefinements
);

/** Validates one durable task automation profile read from SQLite. */
export const taskAutomationProfileSelectSchema = v.strictObject(
    generatedAutomationSelectSchema.entries
);

/** Validates one durable task automation profile before insertion. */
export const taskAutomationProfileInsertSchema = v.strictObject(
    generatedAutomationInsertSchema.entries
);
