import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    nulFreeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

/** Append-only task lifecycle history retained after the mutable task is deleted. */
export const taskEvents = sqliteTable(
    "task_events",
    {
        actorId: text("actor_id").notNull(),
        actorKind: text("actor_kind", { enum: ["automation", "user"] }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        eventType: text("event_type", {
            enum: [
                "assigned",
                "created",
                "deleted",
                "moved",
                "progress-added",
                "progress-deleted",
                "progress-updated",
                "updated",
            ],
        }).notNull(),
        id: text("id").notNull().primaryKey(),
        payloadJson: text("payload_json").notNull().default("{}"),
        taskId: text("task_id").notNull(),
    },
    (table) => [
        check(
            "task_events_actor_check",
            sql`(${table.actorKind} = 'user' AND ${uuidV7TextCheck(table.actorId)}) OR (${table.actorKind} = 'automation' AND length(${table.actorId}) BETWEEN 1 AND 64 AND ${nulFreeTextCheck(table.actorId)} AND ${table.actorId} = lower(${table.actorId}) AND substr(${table.actorId}, 1, 1) GLOB '[a-z0-9]' AND ${table.actorId} NOT GLOB '*[^a-z0-9._-]*')`
        ),
        check(
            "task_events_created_at_check",
            timestampMillisecondsCheck(table.createdAt)
        ),
        check(
            "task_events_event_type_check",
            sql`${table.eventType} IN ('assigned', 'created', 'deleted', 'moved', 'progress-added', 'progress-deleted', 'progress-updated', 'updated')`
        ),
        check("task_events_id_check", uuidV7TextCheck(table.id)),
        check(
            "task_events_payload_json_check",
            sql`length(CAST(${table.payloadJson} AS BLOB)) <= 4096 AND CASE WHEN json_valid(${table.payloadJson}) THEN json_type(${table.payloadJson}) = 'object' ELSE 0 END`
        ),
        check("task_events_task_id_check", uuidV7TextCheck(table.taskId)),
        index("task_events_task_created_id_idx").on(
            table.taskId,
            table.createdAt,
            table.id
        ),
    ]
);
