import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
    chatRunEventBytesMaximum,
    chatRunEventMaximum,
    chatRunRequestMaximumBytes,
} from "../../../contracts/chatModel.ts";
import {
    boundedCanonicalBase64UrlTextCheck,
    boundedControlSafeTextCheck,
    boundedNonBlankTextCheck,
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { boundedJsonObjectCheck, jobActorCheck } from "./jobChecks.ts";

/** Durable admission, provider identity, lifecycle, and reconciliation boundary. */
export const chatRuns = sqliteTable(
    "chat_runs",
    {
        actorId: text("actor_id").notNull(),
        actorKind: text("actor_kind", { enum: ["automation", "user"] }).notNull(),
        admittedAt: integer("admitted_at", { mode: "timestamp_ms" }).notNull(),
        cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
        dispatchAttemptedAt: integer("dispatch_attempted_at", {
            mode: "timestamp_ms",
        }),
        eventBytes: integer("event_bytes").notNull().default(0),
        eventCount: integer("event_count").notNull().default(0),
        failureCode: text("failure_code"),
        failureMessage: text("failure_message"),
        gatewayScope: text("gateway_scope").notNull(),
        historyMessageId: text("history_message_id"),
        id: text("id").notNull().primaryKey(),
        idempotencyKey: text("idempotency_key").notNull(),
        lastEventSequence: integer("last_event_sequence").notNull().default(0),
        providerAcknowledgedAt: integer("provider_acknowledged_at", {
            mode: "timestamp_ms",
        }),
        providerRunId: text("provider_run_id"),
        reconciledAt: integer("reconciled_at", { mode: "timestamp_ms" }),
        reconciliationState: text("reconciliation_state", {
            enum: ["failed", "history-authoritative", "pending", "runtime-authoritative"],
        })
            .notNull()
            .default("pending"),
        requestJson: text("request_json").notNull(),
        requestSha256: text("request_sha256").notNull(),
        retentionExpiresAt: integer("retention_expires_at", { mode: "timestamp_ms" }),
        sessionKey: text("session_key").notNull(),
        state: text("state", {
            enum: [
                "active",
                "admitted",
                "cancel-requested",
                "cancelled",
                "completed",
                "failed",
                "interrupted",
                "outcome-unknown",
                "unresolved",
            ],
        })
            .notNull()
            .default("admitted"),
        stateVersion: integer("state_version").notNull().default(1),
        terminalAt: integer("terminal_at", { mode: "timestamp_ms" }),
        transcriptGeneration: integer("transcript_generation").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check("chat_runs_actor_check", jobActorCheck(table.actorKind, table.actorId)),
        check("chat_runs_id_check", uuidV7TextCheck(table.id)),
        check(
            "chat_runs_idempotency_key_check",
            boundedCanonicalBase64UrlTextCheck(table.idempotencyKey, 32, 128)
        ),
        check(
            "chat_runs_gateway_scope_check",
            boundedControlSafeTextCheck(table.gatewayScope, 64)
        ),
        check(
            "chat_runs_session_key_check",
            boundedControlSafeTextCheck(table.sessionKey, 512)
        ),
        check(
            "chat_runs_provider_run_id_check",
            sql`${table.providerRunId} IS NULL OR ${boundedControlSafeTextCheck(table.providerRunId, 256)}`
        ),
        check(
            "chat_runs_history_message_id_check",
            sql`${table.historyMessageId} IS NULL OR ${boundedControlSafeTextCheck(table.historyMessageId, 256)}`
        ),
        check(
            "chat_runs_request_json_check",
            boundedJsonObjectCheck(table.requestJson, chatRunRequestMaximumBytes)
        ),
        check(
            "chat_runs_request_sha256_check",
            lowercaseHexTextCheck(table.requestSha256, 64)
        ),
        check(
            "chat_runs_event_budget_check",
            sql`${table.eventCount} BETWEEN 0 AND ${sql.raw(String(chatRunEventMaximum))} AND ${table.lastEventSequence} = ${table.eventCount} AND ${table.eventBytes} BETWEEN 0 AND ${sql.raw(String(chatRunEventBytesMaximum))}`
        ),
        check(
            "chat_runs_state_check",
            sql`${table.state} IN ('active', 'admitted', 'cancel-requested', 'cancelled', 'completed', 'failed', 'interrupted', 'outcome-unknown', 'unresolved')`
        ),
        check(
            "chat_runs_reconciliation_state_check",
            sql`${table.reconciliationState} IN ('failed', 'history-authoritative', 'pending', 'runtime-authoritative')`
        ),
        check(
            "chat_runs_state_version_check",
            sql`${table.stateVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "chat_runs_failure_check",
            sql`(${table.state} = 'failed' AND ${table.failureCode} IS NOT NULL AND ${boundedControlSafeTextCheck(table.failureCode, 128)} AND ${table.failureMessage} IS NOT NULL AND ${boundedNonBlankTextCheck(table.failureMessage, 2000)}) OR (${table.state} <> 'failed' AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)`
        ),
        check(
            "chat_runs_lifecycle_check",
            sql`(${table.state} IN ('cancelled', 'completed', 'failed', 'unresolved') AND ${table.terminalAt} IS NOT NULL AND ${table.retentionExpiresAt} IS NOT NULL AND ${table.retentionExpiresAt} > ${table.terminalAt}) OR (${table.state} NOT IN ('cancelled', 'completed', 'failed', 'unresolved') AND ${table.terminalAt} IS NULL AND ${table.retentionExpiresAt} IS NULL)`
        ),
        check(
            "chat_runs_cancellation_check",
            sql`(${table.state} IN ('cancel-requested', 'cancelled') AND ${table.cancelRequestedAt} IS NOT NULL) OR (${table.state} IN ('admitted', 'active', 'interrupted') AND ${table.cancelRequestedAt} IS NULL) OR (${table.state} IN ('completed', 'failed', 'outcome-unknown', 'unresolved'))`
        ),
        check(
            "chat_runs_reconciliation_check",
            sql`(${table.reconciliationState} = 'history-authoritative' AND ${table.reconciledAt} IS NOT NULL) OR (${table.reconciliationState} <> 'history-authoritative' AND ${table.reconciledAt} IS NULL)`
        ),
        check(
            "chat_runs_transcript_generation_check",
            sql`${table.transcriptGeneration} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "chat_runs_time_check",
            sql`${timestampMillisecondsCheck(table.admittedAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.admittedAt} AND (${table.dispatchAttemptedAt} IS NULL OR (${timestampMillisecondsCheck(table.dispatchAttemptedAt)} AND ${table.dispatchAttemptedAt} BETWEEN ${table.admittedAt} AND ${table.updatedAt})) AND (${table.providerAcknowledgedAt} IS NULL OR (${table.dispatchAttemptedAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.providerAcknowledgedAt)} AND ${table.providerAcknowledgedAt} BETWEEN ${table.dispatchAttemptedAt} AND ${table.updatedAt})) AND (${table.cancelRequestedAt} IS NULL OR (${timestampMillisecondsCheck(table.cancelRequestedAt)} AND ${table.cancelRequestedAt} BETWEEN ${table.admittedAt} AND ${table.updatedAt})) AND (${table.terminalAt} IS NULL OR (${timestampMillisecondsCheck(table.terminalAt)} AND ${table.terminalAt} BETWEEN ${table.admittedAt} AND ${table.updatedAt})) AND (${table.reconciledAt} IS NULL OR (${timestampMillisecondsCheck(table.reconciledAt)} AND ${table.reconciledAt} BETWEEN ${table.admittedAt} AND ${table.updatedAt})) AND (${table.retentionExpiresAt} IS NULL OR ${timestampMillisecondsCheck(table.retentionExpiresAt)})`
        ),
        uniqueIndex("chat_runs_actor_idempotency_unique").on(
            table.actorKind,
            table.actorId,
            table.idempotencyKey
        ),
        uniqueIndex("chat_runs_provider_intent_unique").on(
            table.gatewayScope,
            table.sessionKey,
            table.transcriptGeneration,
            table.idempotencyKey
        ),
        uniqueIndex("chat_runs_provider_identity_unique")
            .on(
                table.gatewayScope,
                table.sessionKey,
                table.transcriptGeneration,
                table.providerRunId
            )
            .where(sql`${table.providerRunId} IS NOT NULL`),
        index("chat_runs_session_updated_id_idx").on(
            table.gatewayScope,
            table.sessionKey,
            table.transcriptGeneration,
            table.updatedAt,
            table.id
        ),
        index("chat_runs_active_session_idx")
            .on(
                table.gatewayScope,
                table.sessionKey,
                table.transcriptGeneration,
                table.admittedAt,
                table.id
            )
            .where(
                sql`${table.state} IN ('active', 'admitted', 'cancel-requested', 'interrupted', 'outcome-unknown')`
            ),
        index("chat_runs_active_process_idx")
            .on(
                table.gatewayScope,
                table.transcriptGeneration,
                table.admittedAt,
                table.id
            )
            .where(
                sql`${table.state} IN ('active', 'admitted', 'cancel-requested', 'interrupted', 'outcome-unknown')`
            ),
        index("chat_runs_retention_idx")
            .on(table.retentionExpiresAt, table.id)
            .where(sql`${table.retentionExpiresAt} IS NOT NULL`),
    ]
);
