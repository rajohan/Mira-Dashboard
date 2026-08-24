import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
} from "../../../contracts/security.ts";
import { taskIdSchema } from "../../../contracts/taskModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { jsonObjectSchema, parseJsonText } from "../../../shared/json.ts";
import { taskEvents } from "../schema/taskEvents.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

export const taskEventPayloadMaximumBytes = 4 * 1024;

const taskEventTypeSchema = v.picklist([
    "assigned",
    "created",
    "deleted",
    "moved",
    "progress-added",
    "progress-deleted",
    "progress-updated",
    "updated",
]);
const taskEventActorKindSchema = v.picklist(["automation", "user"]);
const taskEventPayloadJsonSchema = v.pipe(
    v.string(),
    v.check((value) => utf8ByteLength(value) <= taskEventPayloadMaximumBytes),
    v.check((value) => v.safeParse(jsonObjectSchema, parseJsonText(value)).success)
);

function taskEventActorIsValid(event: {
    readonly actorId: string;
    readonly actorKind: "automation" | "user";
}): boolean {
    return v.safeParse(
        event.actorKind === "automation"
            ? automationPrincipalIdSchema
            : securityRecordIdSchema,
        event.actorId
    ).success;
}

const taskEventRefinements = {
    actorKind: () => taskEventActorKindSchema,
    createdAt: nonnegativeDateSchema,
    eventType: () => taskEventTypeSchema,
    id: uuidV7TextSchema,
    payloadJson: () => taskEventPayloadJsonSchema,
    taskId: () => taskIdSchema,
};
const generatedTaskEventSelectSchema = createSelectSchema(
    taskEvents,
    taskEventRefinements
);
const taskEventSelectObjectSchema = v.strictObject(
    generatedTaskEventSelectSchema.entries
);
type TaskEventSelectValue = v.InferOutput<typeof taskEventSelectObjectSchema>;

function selectedTaskEventActorIsValid(event: TaskEventSelectValue): boolean {
    return taskEventActorIsValid(event);
}

/** Validates one immutable task event read from SQLite. */
export const taskEventSelectSchema = v.pipe(
    taskEventSelectObjectSchema,
    v.check(selectedTaskEventActorIsValid, "Task event actor is invalid")
);

const generatedTaskEventInsertSchema = createInsertSchema(
    taskEvents,
    taskEventRefinements
);
const taskEventInsertObjectSchema = v.strictObject({
    actorId: generatedTaskEventInsertSchema.entries.actorId,
    actorKind: generatedTaskEventInsertSchema.entries.actorKind,
    createdAt: generatedTaskEventInsertSchema.entries.createdAt,
    eventType: generatedTaskEventInsertSchema.entries.eventType,
    id: generatedTaskEventInsertSchema.entries.id,
    payloadJson: generatedTaskEventInsertSchema.entries.payloadJson,
    taskId: generatedTaskEventInsertSchema.entries.taskId,
});
type TaskEventInsertValue = v.InferOutput<typeof taskEventInsertObjectSchema>;

function insertedTaskEventActorIsValid(event: TaskEventInsertValue): boolean {
    return taskEventActorIsValid(event);
}

/** Validates one immutable task event before insertion. */
export const taskEventInsertSchema = v.pipe(
    taskEventInsertObjectSchema,
    v.check(insertedTaskEventActorIsValid, "Task event actor is invalid")
);
