import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";

const incidentStatuses = ["open", "resolved"] as const;

/** Minimal incident table used to qualify Drizzle's SQLite feature set. */
export const qualificationIncidents = sqliteTable(
    "qualification_incidents",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        incidentKey: text("incident_key").notNull(),
        lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
        resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
        status: text("status", { enum: incidentStatuses }).notNull(),
    },
    (table) => [
        check(
            "qualification_incidents_resolution_check",
            sql`(${table.status} = 'open' AND ${table.resolvedAt} IS NULL) OR (${table.status} = 'resolved' AND ${table.resolvedAt} IS NOT NULL)`
        ),
        uniqueIndex("qualification_incidents_active_key_unique")
            .on(table.incidentKey)
            .where(sql`${table.resolvedAt} IS NULL`),
        index("qualification_incidents_status_seen_idx").on(
            table.status,
            table.lastSeenAt
        ),
    ]
);

/** Minimal transactional outbox table used by the database qualification. */
export const qualificationEvents = sqliteTable(
    "qualification_events",
    {
        aggregateId: integer("aggregate_id")
            .notNull()
            .references(() => qualificationIncidents.id, { onDelete: "cascade" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        id: integer("id").primaryKey({ autoIncrement: true }),
        payload: text("payload").notNull(),
        topic: text("topic").notNull(),
    },
    (table) => [index("qualification_events_topic_id_idx").on(table.topic, table.id)]
);

/** Valibot schema generated from the Drizzle incident select model. */
export const qualificationIncidentSelectSchema =
    createSelectSchema(qualificationIncidents);

/** Valibot schema generated from the Drizzle incident insert model. */
export const qualificationIncidentInsertSchema =
    createInsertSchema(qualificationIncidents);

/** Drizzle tables supplied to the qualified database client. */
export const qualificationSchema = {
    qualificationEvents,
    qualificationIncidents,
};
