import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Transactional outbox and resumable browser event journal. */
export const realtimeEvents = sqliteTable(
    "realtime_events",
    {
        entityId: text("entity_id"),
        entityType: text("entity_type").notNull(),
        id: integer("id").primaryKey({ autoIncrement: true }),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        operation: text("operation", {
            enum: ["created", "deleted", "snapshot-required", "updated"],
        }).notNull(),
        payloadJson: text("payload_json").notNull(),
        topic: text("topic").notNull(),
    },
    (table) => [
        check(
            "realtime_events_payload_json_check",
            sql`json_valid(${table.payloadJson})`
        ),
        check(
            "realtime_events_operation_check",
            sql`${table.operation} IN ('created', 'deleted', 'snapshot-required', 'updated')`
        ),
        index("realtime_events_topic_id_idx").on(table.topic, table.id),
    ]
);
