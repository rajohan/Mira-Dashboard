import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { taskNotificationMessageMaximumBytes } from "../../../shared/taskNotifications.ts";
import {
    boundedControlSafeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { taskEvents } from "./taskEvents.ts";

/** Durable, retryable OpenClaw chat delivery intent created with one task event. */
export const taskNotificationOutbox = sqliteTable(
    "task_notification_outbox",
    {
        attemptCount: integer("attempt_count").notNull().default(0),
        availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
        eventId: text("event_id")
            .notNull()
            .primaryKey()
            .references(() => taskEvents.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
        leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
        leaseOwner: text("lease_owner"),
        message: text("message").notNull(),
    },
    (table) => [
        check(
            "task_notification_outbox_attempt_count_check",
            sql`${table.attemptCount} BETWEEN 0 AND 9007199254740991`
        ),
        check(
            "task_notification_outbox_available_at_check",
            sql`${timestampMillisecondsCheck(table.availableAt)} AND ${table.availableAt} >= ${table.createdAt}`
        ),
        check(
            "task_notification_outbox_created_at_check",
            timestampMillisecondsCheck(table.createdAt)
        ),
        check(
            "task_notification_outbox_delivered_at_check",
            sql`${table.deliveredAt} IS NULL OR (${timestampMillisecondsCheck(table.deliveredAt)} AND ${table.deliveredAt} >= ${table.createdAt})`
        ),
        check("task_notification_outbox_event_id_check", uuidV7TextCheck(table.eventId)),
        check(
            "task_notification_outbox_lease_check",
            sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.deliveredAt} IS NULL AND ${table.leaseOwner} IS NOT NULL AND ${uuidV7TextCheck(table.leaseOwner)} AND ${table.leaseExpiresAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.leaseExpiresAt)})`
        ),
        check(
            "task_notification_outbox_message_check",
            sql`${boundedControlSafeTextCheck(table.message, taskNotificationMessageMaximumBytes)} AND length(CAST(${table.message} AS BLOB)) <= ${sql.raw(String(taskNotificationMessageMaximumBytes))}`
        ),
        index("task_notification_outbox_eligible_idx").on(
            table.deliveredAt,
            table.availableAt,
            table.leaseExpiresAt,
            table.createdAt,
            table.eventId
        ),
    ]
);
