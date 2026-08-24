import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { notifications } from "../schema/notifications.ts";
import { uuidV7Action } from "./scalars.ts";

const notificationRefinements = {
    id: (schema: v.StringSchema<undefined>) => v.pipe(schema, v.uuid(), uuidV7Action),
    incidentId: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, v.uuid(), uuidV7Action),
    incidentGeneration: (
        schema: GetValibotTypeFromColumn<typeof notifications.incidentGeneration>
    ) => v.pipe(schema, v.minValue(1)),
};

const generatedNotificationSelectSchema = createSelectSchema(
    notifications,
    notificationRefinements
);

/** Validates rows read from the notifications table. */
export const notificationSelectSchema = v.strictObject(
    generatedNotificationSelectSchema.entries
);

const generatedNotificationInsertSchema = v.omit(
    createInsertSchema(notifications, notificationRefinements),
    ["readAt"]
);

/** Validates values before a notification insert. */
export const notificationInsertSchema = v.strictObject(
    generatedNotificationInsertSchema.entries
);

const generatedNotificationUpdateSchema = createUpdateSchema(
    notifications,
    notificationRefinements
);

/** Validates the only mutable notification field. */
export const notificationUpdateSchema = v.strictObject({
    readAt: generatedNotificationUpdateSchema.entries.readAt,
});
