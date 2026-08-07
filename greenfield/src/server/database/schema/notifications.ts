import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { incidents } from "./incidents.ts";

/** User-visible notifications, optionally tied to one incident generation. */
export const notifications = sqliteTable(
    "notifications",
    {
        channel: text("channel", { enum: ["dashboard"] }).notNull(),
        id: text("id").notNull().primaryKey(),
        incidentGeneration: integer("incident_generation"),
        incidentId: text("incident_id").references(() => incidents.id, {
            onDelete: "restrict",
        }),
        kind: text("kind").notNull(),
        linkUrl: text("link_url"),
        message: text("message").notNull(),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        readAt: integer("read_at", { mode: "timestamp_ms" }),
        severity: text("severity", {
            enum: ["critical", "error", "info", "warning"],
        }).notNull(),
        title: text("title").notNull(),
    },
    (table) => [
        check("notifications_channel_check", sql`${table.channel} = 'dashboard'`),
        check(
            "notifications_incident_pair_check",
            sql`(${table.incidentId} IS NULL AND ${table.incidentGeneration} IS NULL) OR (${table.incidentId} IS NOT NULL AND ${table.incidentGeneration} IS NOT NULL)`
        ),
        check(
            "notifications_incident_generation_check",
            sql`${table.incidentGeneration} IS NULL OR ${table.incidentGeneration} >= 1`
        ),
        check(
            "notifications_read_order_check",
            sql`${table.readAt} IS NULL OR ${table.readAt} >= ${table.occurredAt}`
        ),
        check(
            "notifications_severity_check",
            sql`${table.severity} IN ('critical', 'error', 'info', 'warning')`
        ),
        uniqueIndex("notifications_incident_generation_channel_unique")
            .on(table.incidentId, table.incidentGeneration, table.channel)
            .where(sql`${table.incidentId} IS NOT NULL`),
        index("notifications_unread_occurred_idx")
            .on(table.occurredAt)
            .where(sql`${table.readAt} IS NULL`),
    ]
);
