import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    nonNegativeIntegerSchema,
    parseContract,
    positiveIntegerSchema,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const NOTIFICATION_TYPES = ["error", "info", "success", "warning"] as const;

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const notificationTypeSchema = v.picklist(NOTIFICATION_TYPES);

export const notificationItemSchema = v.strictObject({
    createdAt: trimmedNonEmptyStringSchema,
    dedupeKey: v.optional(v.string()),
    description: v.string(),
    id: positiveIntegerSchema,
    isRead: v.boolean(),
    metadata: jsonObjectSchema,
    occurredAt: trimmedNonEmptyStringSchema,
    source: v.optional(v.string()),
    title: v.string(),
    type: notificationTypeSchema,
    updatedAt: trimmedNonEmptyStringSchema,
});

export const notificationsResponseSchema = v.strictObject({
    items: v.array(notificationItemSchema),
    readCount: finiteNumberSchema,
    unreadCount: finiteNumberSchema,
});

export const notificationCreateInputSchema = strictJsonObjectSchema({
    dedupeKey: v.optional(trimmedNonEmptyStringSchema),
    description: v.optional(v.string()),
    metadata: v.optional(jsonObjectSchema),
    occurredAt: v.optional(
        v.pipe(
            v.string(),
            v.check(
                (value) => !Number.isNaN(Date.parse(value)),
                "must be a valid timestamp"
            )
        )
    ),
    source: v.optional(trimmedNonEmptyStringSchema),
    title: trimmedNonEmptyStringSchema,
    type: v.optional(notificationTypeSchema),
});

export const notificationClearReadRequestSchema = strictJsonObjectSchema({
    source: v.optional(trimmedNonEmptyStringSchema),
});

export const notificationCreateResponseSchema = v.strictObject({
    id: positiveIntegerSchema,
    isOk: successLiteralSchema,
});

export const notificationMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export const notificationsDeleteResponseSchema = v.strictObject({
    deleted: nonNegativeIntegerSchema,
    isOk: successLiteralSchema,
});

export type NotificationType = v.InferOutput<typeof notificationTypeSchema>;
export type NotificationItem = v.InferOutput<typeof notificationItemSchema>;
export type NotificationsResponse = v.InferOutput<typeof notificationsResponseSchema>;
export type CreateNotificationInput = v.InferOutput<typeof notificationCreateInputSchema>;
export type ClearReadNotificationsRequest = v.InferOutput<
    typeof notificationClearReadRequestSchema
>;
export type CreateNotificationResponse = v.InferOutput<
    typeof notificationCreateResponseSchema
>;
export type NotificationMutationResponse = v.InferOutput<
    typeof notificationMutationResponseSchema
>;
export type DeleteNotificationsResponse = v.InferOutput<
    typeof notificationsDeleteResponseSchema
>;

export function parseCreateNotificationInput(
    value: unknown,
    path = "body"
): CreateNotificationInput {
    return parseContract(notificationCreateInputSchema, value, path);
}

/**
 * Parses a read-notification cleanup request at the backend HTTP boundary.
 * @param value Value to process.
 * @returns Parsed read-notification cleanup request.
 */
export function parseClearReadNotificationsRequest(
    value: unknown
): ClearReadNotificationsRequest {
    return parseContract(notificationClearReadRequestSchema, value);
}

/**
 * Parses the notification list at the browser HTTP trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the notification list at the browser HTTP trust boundary.
 */
export function parseNotificationsResponse(
    value: unknown,
    path = "notifications"
): NotificationsResponse {
    return parseContract(notificationsResponseSchema, value, path);
}

export function parseCreateNotificationResponse(
    value: unknown,
    path = "createNotification"
): CreateNotificationResponse {
    return parseContract(notificationCreateResponseSchema, value, path);
}

export function parseNotificationMutationResponse(
    value: unknown,
    path = "notificationMutation"
): NotificationMutationResponse {
    return parseContract(notificationMutationResponseSchema, value, path);
}

export function parseDeleteNotificationsResponse(
    value: unknown,
    path = "deleteNotifications"
): DeleteNotificationsResponse {
    return parseContract(notificationsDeleteResponseSchema, value, path);
}
