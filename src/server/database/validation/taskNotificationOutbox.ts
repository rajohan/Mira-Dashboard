import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { taskNotificationMessageSchema } from "../../../shared/taskNotifications.ts";
import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";
import { taskNotificationOutbox } from "../schema/taskNotificationOutbox.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

const refinements = {
    attemptCount: () => nonnegativeSafeIntegerSchema(),
    availableAt: nonnegativeDateSchema,
    createdAt: nonnegativeDateSchema,
    deliveredAt: nonnegativeDateSchema,
    eventId: uuidV7TextSchema,
    leaseExpiresAt: nonnegativeDateSchema,
    leaseOwner: uuidV7TextSchema,
    message: () => taskNotificationMessageSchema,
};

const generatedSelectSchema = createSelectSchema(taskNotificationOutbox, refinements);
const selectObjectSchema = v.strictObject(generatedSelectSchema.entries);
type TaskNotificationOutboxSelect = v.InferOutput<typeof selectObjectSchema>;

function stateIsConsistent(row: TaskNotificationOutboxSelect): boolean {
    const leaseIsComplete = (row.leaseOwner === null) === (row.leaseExpiresAt === null);
    return (
        leaseIsComplete &&
        row.availableAt >= row.createdAt &&
        (row.deliveredAt === null ||
            (row.deliveredAt >= row.createdAt && row.leaseOwner === null))
    );
}

/** Validates one mutable task-notification delivery row read from SQLite. */
export const taskNotificationOutboxSelectSchema = v.pipe(
    selectObjectSchema,
    v.check(stateIsConsistent, "Task notification delivery state is inconsistent")
);

const generatedInsertSchema = createInsertSchema(taskNotificationOutbox, refinements);

/** Validates the initial pending delivery intent written with a task event. */
export const taskNotificationOutboxInsertSchema = v.strictObject({
    availableAt: generatedInsertSchema.entries.availableAt,
    createdAt: generatedInsertSchema.entries.createdAt,
    eventId: generatedInsertSchema.entries.eventId,
    message: generatedInsertSchema.entries.message,
});
