import * as v from "valibot";

import { taskAutomationProfileSelectSchema } from "../../database/validation/taskAutomationProfiles.ts";
import { taskLabelSelectSchema } from "../../database/validation/taskLabels.ts";
import { taskSelectSchema } from "../../database/validation/tasks.ts";
import { taskProgressRowSelectSchema } from "../../database/validation/taskUpdates.ts";
import type {
    TaskAutomationProfileRecord,
    TaskLabelRecord,
    TaskProgressRecord,
    TaskRecord,
} from "./repositoryTypes.ts";

export function parseTaskRecord(input: unknown): TaskRecord {
    return v.parse(taskSelectSchema, input);
}

export function parseTaskLabelRecord(input: unknown): TaskLabelRecord {
    return v.parse(taskLabelSelectSchema, input);
}

export function parseTaskAutomationProfileRecord(
    input: unknown
): TaskAutomationProfileRecord {
    return v.parse(taskAutomationProfileSelectSchema, input);
}

export function parseTaskProgressRecord(input: unknown): TaskProgressRecord {
    return v.parse(taskProgressRowSelectSchema, input);
}
