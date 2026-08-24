import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    monitoringKindSchema,
    monitoringProblemTitleSchema,
    monitoringReportSourceSchema,
    monitoringReportTitleSchema,
} from "../../../contracts/monitoring.ts";
import { notifications } from "../schema/notifications.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

function notificationIncidentPairIsValid(notification: {
    readonly incidentGeneration?: number | null;
    readonly incidentId?: string | null;
}): boolean {
    return (
        (notification.incidentId == null) === (notification.incidentGeneration == null)
    );
}

function notificationReadOrderIsValid(notification: {
    readonly occurredAt: Date;
    readonly readAt?: Date | null;
}): boolean {
    return (
        notification.readAt == null ||
        compareAsc(notification.readAt, notification.occurredAt) >= 0
    );
}

const notificationRefinements = {
    id: uuidV7TextSchema,
    incidentId: uuidV7TextSchema,
    incidentGeneration: (
        schema: GetValibotTypeFromColumn<typeof notifications.incidentGeneration>
    ) => v.pipe(schema, v.minValue(1)),
    kind: () => monitoringKindSchema,
    message: () => monitoringProblemTitleSchema,
    occurredAt: nonnegativeDateSchema,
    readAt: nonnegativeDateSchema,
    reportId: uuidV7TextSchema,
    source: () => monitoringReportSourceSchema,
    title: () => monitoringReportTitleSchema,
};

const generatedNotificationSelectSchema = createSelectSchema(
    notifications,
    notificationRefinements
);

/** Validates rows read from the notifications table. */
export const notificationSelectSchema = v.pipe(
    v.strictObject(generatedNotificationSelectSchema.entries),
    v.check(
        (notification) => notificationIncidentPairIsValid(notification),
        "Expected notification incident id and generation to be present together."
    ),
    v.check(
        (notification) => notificationReadOrderIsValid(notification),
        "Expected notification readAt to be at or after occurredAt."
    )
);

const generatedNotificationInsertSchema = v.omit(
    createInsertSchema(notifications, notificationRefinements),
    ["readAt"]
);

/** Validates values before a notification insert. */
export const notificationInsertSchema = v.pipe(
    v.strictObject(generatedNotificationInsertSchema.entries),
    v.check(
        (notification) => notificationIncidentPairIsValid(notification),
        "Expected notification incident id and generation to be present together."
    ),
    v.check(
        (notification) => notificationReadOrderIsValid(notification),
        "Expected notification readAt to be at or after occurredAt."
    )
);

const generatedNotificationUpdateSchema = createUpdateSchema(
    notifications,
    notificationRefinements
);

/** Validates the only mutable notification field. */
export const notificationUpdateSchema = v.strictObject({
    readAt: generatedNotificationUpdateSchema.entries.readAt,
});
