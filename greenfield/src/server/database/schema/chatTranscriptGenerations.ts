import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { boundedControlSafeTextCheck, timestampMillisecondsCheck } from "./checks.ts";

/**
 * Durable current provider-transcript pointer for one canonical Gateway session.
 * Historical runs keep their stamped generation after this pointer advances.
 */
export const chatTranscriptGenerations = sqliteTable(
    "chat_transcript_generations",
    {
        currentGeneration: integer("current_generation").notNull().default(1),
        gatewayScope: text("gateway_scope").notNull(),
        lastBoundaryAction: text("last_boundary_action", {
            enum: ["compact", "delete", "new", "reset", "transport"],
        }),
        lastBoundaryProviderUpdatedAt: integer("last_boundary_provider_updated_at", {
            mode: "timestamp_ms",
        }),
        observedAt: integer("observed_at", { mode: "timestamp_ms" }),
        pendingAction: text("pending_action", {
            enum: ["compact", "delete", "reset"],
        }),
        pendingControlId: text("pending_control_id"),
        pendingPreviousStatus: text("pending_previous_status", {
            enum: ["absent", "ready"],
        }),
        providerSessionId: text("provider_session_id"),
        providerUpdatedAt: integer("provider_updated_at", { mode: "timestamp_ms" }),
        sessionKey: text("session_key").notNull(),
        status: text("status", {
            enum: ["absent", "control-pending", "ready", "reconciling"],
        })
            .notNull()
            .default("ready"),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        version: integer("version").notNull().default(1),
    },
    (table) => [
        primaryKey({
            columns: [table.gatewayScope, table.sessionKey],
            name: "chat_transcript_generations_pk",
        }),
        check(
            "chat_transcript_generations_gateway_scope_check",
            boundedControlSafeTextCheck(table.gatewayScope, 64)
        ),
        check(
            "chat_transcript_generations_session_key_check",
            boundedControlSafeTextCheck(table.sessionKey, 512)
        ),
        check(
            "chat_transcript_generations_current_generation_check",
            sql`${table.currentGeneration} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "chat_transcript_generations_version_check",
            sql`${table.version} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "chat_transcript_generations_status_check",
            sql`${table.status} IN ('absent', 'control-pending', 'ready', 'reconciling')`
        ),
        check(
            "chat_transcript_generations_pending_check",
            sql`(${table.status} = 'control-pending' AND ${table.pendingAction} IN ('compact', 'delete', 'reset') AND ${table.pendingControlId} IS NOT NULL AND ${boundedControlSafeTextCheck(table.pendingControlId, 128)} AND ${table.pendingPreviousStatus} IN ('absent', 'ready')) OR (${table.status} <> 'control-pending' AND ${table.pendingAction} IS NULL AND ${table.pendingControlId} IS NULL AND ${table.pendingPreviousStatus} IS NULL)`
        ),
        check(
            "chat_transcript_generations_provider_session_check",
            sql`${table.providerSessionId} IS NULL OR ${boundedControlSafeTextCheck(table.providerSessionId, 256)}`
        ),
        check(
            "chat_transcript_generations_boundary_action_check",
            sql`${table.lastBoundaryAction} IS NULL OR ${table.lastBoundaryAction} IN ('compact', 'delete', 'new', 'reset', 'transport')`
        ),
        check(
            "chat_transcript_generations_time_check",
            sql`${timestampMillisecondsCheck(table.updatedAt)} AND (${table.observedAt} IS NULL OR (${timestampMillisecondsCheck(table.observedAt)} AND ${table.observedAt} <= ${table.updatedAt})) AND (${table.providerUpdatedAt} IS NULL OR ${timestampMillisecondsCheck(table.providerUpdatedAt)}) AND (${table.lastBoundaryProviderUpdatedAt} IS NULL OR ${timestampMillisecondsCheck(table.lastBoundaryProviderUpdatedAt)})`
        ),
        check(
            "chat_transcript_generations_absent_check",
            sql`${table.status} <> 'absent' OR ${table.providerSessionId} IS NULL`
        ),
    ]
);
