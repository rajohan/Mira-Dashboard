import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { enumFilterSchema, uniqueFilterSchema } from "./filterSchemas.ts";
import {
    type NotificationRecord,
    monitoringKindSchema,
    monitoringLinkPathSchema,
    monitoringProblemTitleSchema,
    monitoringRecordIdSchema,
    monitoringReportSourceSchema,
    monitoringReportTitleSchema,
    monitoringSeverities,
    monitoringSeveritySchema,
    notificationRecordSchema,
} from "./monitoring.ts";
import type { ProcedureContract } from "./registry.ts";

/** Default notifications returned by one list request. */
export const notificationPageDefault = 50;

/** Hard notification-row budget for one response or bulk mutation. */
export const notificationPageMaximum = 100;

const notificationFilterMaximum = 16;
const notificationTimestampSchema = timestampMillisecondsSchema(
    "Notification timestamp is invalid"
);
const notificationLimitSchema = v.pipe(
    v.number("Notification page limit is invalid"),
    v.safeInteger("Notification page limit is invalid"),
    v.minValue(1, "Notification page limit is invalid"),
    v.maxValue(notificationPageMaximum, "Notification page limit is outside its budget")
);

/** Stable newest-first notification cursor. */
export const notificationCursorSchema = v.strictObject({
    id: monitoringRecordIdSchema,
    occurredAtMs: notificationTimestampSchema,
});

/** Bounded notification filters shared by reads and bulk actions. */
export const notificationFiltersSchema = v.strictObject({
    incidentId: v.optional(monitoringRecordIdSchema),
    kinds: v.optional(
        uniqueFilterSchema(
            monitoringKindSchema,
            "Notification kind",
            notificationFilterMaximum
        )
    ),
    readState: v.optional(
        v.picklist(["all", "read", "unread"], "Notification read state is invalid"),
        "all"
    ),
    severities: v.optional(
        enumFilterSchema(
            monitoringSeverities,
            "Notification severity",
            notificationFilterMaximum
        )
    ),
    sources: v.optional(
        uniqueFilterSchema(
            monitoringReportSourceSchema,
            "Notification source",
            notificationFilterMaximum
        )
    ),
});

/** One stable keyset-paginated notification request. */
export const listNotificationsInputSchema = v.strictObject({
    cursor: v.optional(notificationCursorSchema),
    filters: v.optional(notificationFiltersSchema),
    limit: v.optional(notificationLimitSchema, notificationPageDefault),
});

/**
 * @param notifications Candidate notification page.
 * @returns Whether notifications use strict newest-first occurrence ordering.
 */
export function newestNotificationOrderIsStable(
    notifications: NotificationRecord[]
): boolean {
    return notifications.every((notification, index) => {
        const previous = notifications[index - 1];
        return (
            previous === undefined ||
            notification.occurredAtMs < previous.occurredAtMs ||
            (notification.occurredAtMs === previous.occurredAtMs &&
                notification.id < previous.id)
        );
    });
}

const notificationRowsSchema = v.pipe(
    v.array(notificationRecordSchema, "Notification page is invalid"),
    v.maxLength(notificationPageMaximum, "Notification page is outside its budget"),
    v.check(newestNotificationOrderIsStable, "Notification page order is invalid")
);

const listNotificationsResultObjectSchema = v.strictObject({
    nextCursor: v.optional(notificationCursorSchema),
    notifications: notificationRowsSchema,
    readCount: v.pipe(
        v.number("Notification read count is invalid"),
        v.safeInteger("Notification read count is invalid"),
        v.minValue(0, "Notification read count is invalid")
    ),
    unreadCount: v.pipe(
        v.number("Notification unread count is invalid"),
        v.safeInteger("Notification unread count is invalid"),
        v.minValue(0, "Notification unread count is invalid")
    ),
});

type ListNotificationsResultValue = v.InferOutput<
    typeof listNotificationsResultObjectSchema
>;

/** @returns Whether an optional notification cursor identifies the final row. */
export function notificationPageCursorIsConsistent(
    result: ListNotificationsResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.notifications.at(-1);
    return (
        last !== undefined &&
        last.id === result.nextCursor.id &&
        last.occurredAtMs === result.nextCursor.occurredAtMs
    );
}

/** One bounded notification page plus an exact cursor and global unread count. */
export const listNotificationsResultSchema = v.pipe(
    listNotificationsResultObjectSchema,
    v.check(
        notificationPageCursorIsConsistent,
        "Notification page cursor is inconsistent"
    )
);

const notificationIncidentReferenceEntries = {
    incidentGeneration: v.optional(
        v.pipe(
            v.number("Notification incident generation is invalid"),
            v.safeInteger("Notification incident generation is invalid"),
            v.minValue(1, "Notification incident generation is invalid")
        )
    ),
    incidentId: v.optional(monitoringRecordIdSchema),
};

const upsertNotificationInputObjectSchema = v.strictObject({
    id: monitoringRecordIdSchema,
    ...notificationIncidentReferenceEntries,
    kind: monitoringKindSchema,
    linkUrl: v.optional(monitoringLinkPathSchema),
    message: monitoringProblemTitleSchema,
    occurredAtMs: notificationTimestampSchema,
    reportId: v.optional(monitoringRecordIdSchema),
    severity: monitoringSeveritySchema,
    source: v.optional(monitoringReportSourceSchema),
    title: monitoringReportTitleSchema,
});

type UpsertNotificationInputValue = v.InferOutput<
    typeof upsertNotificationInputObjectSchema
>;

/** @returns Whether optional incident identity and generation are present together. */
export function notificationInputIncidentReferenceIsConsistent(
    notification: UpsertNotificationInputValue
): boolean {
    return (
        (notification.incidentId === undefined) ===
        (notification.incidentGeneration === undefined)
    );
}

/** Idempotent immutable notification producer input. */
export const upsertNotificationInputSchema = v.pipe(
    upsertNotificationInputObjectSchema,
    v.check(
        notificationInputIncidentReferenceIsConsistent,
        "Notification incident reference is inconsistent"
    )
);

/** Exact notification read/delete request. */
export const notificationIdentityInputSchema = v.strictObject({
    id: monitoringRecordIdSchema,
});

/** Bulk user action over a bounded set of matching notifications. */
export const bulkNotificationInputSchema = v.strictObject({
    filters: v.optional(v.omit(notificationFiltersSchema, ["readState"]), {}),
});

/** Stable bounded bulk-action acknowledgement. */
export const bulkNotificationResultSchema = v.strictObject({
    affectedCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    completedAtMs: notificationTimestampSchema,
    remaining: v.boolean(),
});

/** Stable single-notification deletion acknowledgement. */
export const deleteNotificationResultSchema = v.strictObject({
    deletedAtMs: notificationTimestampSchema,
    id: monitoringRecordIdSchema,
});

const notificationReadAccess = {
    capabilities: ["notifications:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const notificationProducerAccess = {
    capabilities: ["notifications:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["automation"],
} as const;
const notificationSessionWriteAccess = {
    capabilities: ["notifications:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

/** Implemented notification inventory and acknowledgement procedure metadata. */
export const notificationProcedureContracts = [
    {
        access: notificationReadAccess,
        domain: "notifications",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listNotificationsInputSchema,
        inputSchemaId: "notifications.list.input",
        kind: "query",
        name: "notifications.list",
        output: listNotificationsResultSchema,
        outputSchemaId: "notifications.list.output",
        summary: "Lists a stable filtered notification page and unread count.",
        transport: queryTransport,
    },
    {
        access: notificationProducerAccess,
        domain: "notifications",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: upsertNotificationInputSchema,
        inputSchemaId: "notifications.upsert.input",
        kind: "mutation",
        name: "notifications.upsert",
        output: notificationRecordSchema,
        outputSchemaId: "notifications.upsert.output",
        summary: "Creates a notification or accepts an exact idempotent replay.",
        transport: mutationTransport,
    },
    {
        access: notificationSessionWriteAccess,
        domain: "notifications",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: notificationIdentityInputSchema,
        inputSchemaId: "notifications.markRead.input",
        kind: "mutation",
        name: "notifications.markRead",
        output: notificationRecordSchema,
        outputSchemaId: "notifications.markRead.output",
        summary: "Marks one notification read idempotently.",
        transport: mutationTransport,
    },
    {
        access: notificationSessionWriteAccess,
        domain: "notifications",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: bulkNotificationInputSchema,
        inputSchemaId: "notifications.markAllRead.input",
        kind: "mutation",
        name: "notifications.markAllRead",
        output: bulkNotificationResultSchema,
        outputSchemaId: "notifications.markAllRead.output",
        summary: "Marks one bounded page of matching notifications read.",
        transport: mutationTransport,
    },
    {
        access: notificationSessionWriteAccess,
        domain: "notifications",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: bulkNotificationInputSchema,
        inputSchemaId: "notifications.clearRead.input",
        kind: "mutation",
        name: "notifications.clearRead",
        output: bulkNotificationResultSchema,
        outputSchemaId: "notifications.clearRead.output",
        summary: "Deletes one bounded page of matching read notifications.",
        transport: mutationTransport,
    },
    {
        access: notificationSessionWriteAccess,
        domain: "notifications",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: notificationIdentityInputSchema,
        inputSchemaId: "notifications.delete.input",
        kind: "mutation",
        name: "notifications.delete",
        output: deleteNotificationResultSchema,
        outputSchemaId: "notifications.delete.output",
        summary: "Deletes one exact Dashboard notification.",
        transport: mutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type BulkNotificationInput = v.InferOutput<typeof bulkNotificationInputSchema>;
export type BulkNotificationResult = v.InferOutput<typeof bulkNotificationResultSchema>;
export type DeleteNotificationResult = v.InferOutput<
    typeof deleteNotificationResultSchema
>;
export type ListNotificationsInput = v.InferOutput<typeof listNotificationsInputSchema>;
export type ListNotificationsResult = v.InferOutput<typeof listNotificationsResultSchema>;
export type NotificationIdentityInput = v.InferOutput<
    typeof notificationIdentityInputSchema
>;
export type UpsertNotificationInput = v.InferOutput<typeof upsertNotificationInputSchema>;
