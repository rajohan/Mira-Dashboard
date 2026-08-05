import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    boundedNonBlankTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

/** Immutable security and host-control decision record. */
export const auditEvents = sqliteTable(
    "audit_events",
    {
        action: text("action").notNull(),
        actorId: text("actor_id").notNull(),
        actorKind: text("actor_kind", {
            enum: ["anonymous", "automation", "system", "user"],
        }).notNull(),
        authenticatorId: text("authenticator_id"),
        id: text("id").notNull().primaryKey(),
        metadataJson: text("metadata_json").notNull().default("{}"),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        outcome: text("outcome", {
            enum: ["accepted", "attempted", "cancelled", "denied", "failed", "succeeded"],
        }).notNull(),
        requestId: text("request_id"),
        targetId: text("target_id").notNull(),
        targetType: text("target_type").notNull(),
    },
    (table) => [
        check(
            "audit_events_action_check",
            sql`length(${table.action}) BETWEEN 1 AND 128 AND instr(${table.action}, char(0)) = 0 AND substr(${table.action}, 1, 1) GLOB '[a-z0-9]' AND ${table.action} = lower(${table.action}) AND ${table.action} NOT GLOB '*[^a-z0-9._-]*'`
        ),
        check(
            "audit_events_actor_check",
            sql`${table.actorKind} IN ('anonymous', 'automation', 'system', 'user') AND ${boundedNonBlankTextCheck(table.actorId, 128)} AND ((${table.actorKind} IN ('automation', 'user') AND ${table.authenticatorId} IS NOT NULL) OR (${table.actorKind} IN ('anonymous', 'system') AND ${table.authenticatorId} IS NULL))`
        ),
        check(
            "audit_events_authenticator_id_check",
            sql`${table.authenticatorId} IS NULL OR (${boundedNonBlankTextCheck(table.authenticatorId, 128)})`
        ),
        check("audit_events_id_check", uuidV7TextCheck(table.id)),
        check(
            "audit_events_metadata_json_check",
            sql`length(CAST(${table.metadataJson} AS BLOB)) <= 4096 AND CASE WHEN json_valid(${table.metadataJson}) THEN json_type(${table.metadataJson}) = 'object' ELSE 0 END`
        ),
        check(
            "audit_events_occurred_at_check",
            timestampMillisecondsCheck(table.occurredAt)
        ),
        check(
            "audit_events_outcome_check",
            sql`${table.outcome} IN ('accepted', 'attempted', 'cancelled', 'denied', 'failed', 'succeeded')`
        ),
        check(
            "audit_events_request_id_check",
            sql`${table.requestId} IS NULL OR (${boundedNonBlankTextCheck(table.requestId, 128)})`
        ),
        check(
            "audit_events_target_check",
            sql`length(${table.targetType}) BETWEEN 1 AND 64 AND instr(${table.targetType}, char(0)) = 0 AND substr(${table.targetType}, 1, 1) GLOB '[a-z0-9]' AND ${table.targetType} = lower(${table.targetType}) AND ${table.targetType} NOT GLOB '*[^a-z0-9._-]*' AND ${boundedNonBlankTextCheck(table.targetId, 256)}`
        ),
        index("audit_events_occurred_id_idx").on(table.occurredAt, table.id),
        index("audit_events_request_occurred_idx")
            .on(table.requestId, table.occurredAt, table.id)
            .where(sql`${table.requestId} IS NOT NULL`),
        index("audit_events_target_occurred_idx").on(
            table.targetType,
            table.targetId,
            table.occurredAt,
            table.id
        ),
    ]
);
