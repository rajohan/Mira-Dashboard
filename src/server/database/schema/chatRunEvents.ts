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
    chatRunEventMaximum,
    chatRunEventPayloadMaximumBytes,
} from "../../../contracts/chatModel.ts";
import { chatRuns } from "./chatRuns.ts";
import { timestampMillisecondsCheck } from "./checks.ts";
import { boundedJsonObjectCheck } from "./jobChecks.ts";

/** Immutable ordered runtime journal with one process-global browser cursor. */
export const chatRunEvents = sqliteTable(
    "chat_run_events",
    {
        chatRunId: text("chat_run_id")
            .notNull()
            .references(() => chatRuns.id, {
                onDelete: "cascade",
                onUpdate: "restrict",
            }),
        id: integer("id").primaryKey({ autoIncrement: true }),
        kind: text("kind", {
            enum: [
                "assistant",
                "cancel",
                "interrupted",
                "item",
                "plan",
                "provider-noop",
                "reconciled",
                "status",
                "terminal",
                "thinking",
                "tool",
                "user",
            ],
        }).notNull(),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        payloadBytes: integer("payload_bytes").notNull(),
        payloadJson: text("payload_json").notNull(),
        providerSequenceEnd: integer("provider_sequence_end"),
        providerSequenceStart: integer("provider_sequence_start"),
        sequence: integer("sequence").notNull(),
    },
    (table) => [
        check(
            "chat_run_events_kind_check",
            sql`${table.kind} IN ('assistant', 'cancel', 'interrupted', 'item', 'plan', 'provider-noop', 'reconciled', 'status', 'terminal', 'thinking', 'tool', 'user')`
        ),
        check(
            "chat_run_events_sequence_check",
            sql`${table.sequence} BETWEEN 1 AND ${sql.raw(String(chatRunEventMaximum))}`
        ),
        check(
            "chat_run_events_payload_check",
            sql`${boundedJsonObjectCheck(table.payloadJson, chatRunEventPayloadMaximumBytes)} AND ${table.payloadBytes} = length(CAST(${table.payloadJson} AS BLOB)) AND ${table.payloadBytes} BETWEEN 2 AND ${sql.raw(String(chatRunEventPayloadMaximumBytes))}`
        ),
        check(
            "chat_run_events_provider_sequence_check",
            sql`(${table.providerSequenceStart} IS NULL AND ${table.providerSequenceEnd} IS NULL) OR (${table.providerSequenceStart} BETWEEN 1 AND 9007199254740991 AND ${table.providerSequenceEnd} BETWEEN ${table.providerSequenceStart} AND 9007199254740991)`
        ),
        check(
            "chat_run_events_occurred_at_check",
            timestampMillisecondsCheck(table.occurredAt)
        ),
        uniqueIndex("chat_run_events_run_sequence_unique").on(
            table.chatRunId,
            table.sequence
        ),
        index("chat_run_events_run_cursor_idx").on(table.chatRunId, table.id),
        index("chat_run_events_occurred_cursor_idx").on(table.occurredAt, table.id),
    ]
);
