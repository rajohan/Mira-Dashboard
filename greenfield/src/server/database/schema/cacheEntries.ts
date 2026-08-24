import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    cacheEntryKeyMaximumLength,
    cacheEntryMetadataMaximumBytes,
    cacheEntryPayloadMaximumBytes,
    cacheFailureMessageMaximumLength,
    cacheLastAttemptNumberMaximum,
} from "../../../contracts/cache.ts";
import {
    boundedControlSafeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import {
    boundedJobKeyCheck,
    boundedJsonObjectCheck,
    optionalJobMessageCheck,
    optionalJobTerminalCodeCheck,
} from "./jobChecks.ts";
import { jobRuns } from "./jobRuns.ts";

/** Durable last-known-good provider projection and separate latest-attempt outcome. */
export const cacheEntries = sqliteTable(
    "cache_entries",
    {
        consecutiveFailures: integer("consecutive_failures").notNull().default(0),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
        failureCode: text("failure_code"),
        failureMessage: text("failure_message"),
        key: text("key").notNull().primaryKey(),
        lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }).notNull(),
        lastAttemptDurationMs: integer("last_attempt_duration_ms").notNull(),
        lastAttemptNumber: integer("last_attempt_number").notNull(),
        lastAttemptRunId: text("last_attempt_run_id")
            .notNull()
            .references(() => jobRuns.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
        lastAttemptStatus: text("last_attempt_status", {
            enum: ["failed", "succeeded"],
        }).notNull(),
        lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
        metadataJson: text("metadata_json"),
        payloadJson: text("payload_json"),
        schemaId: text("schema_id"),
        source: text("source"),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check(
            "cache_entries_attempt_number_check",
            sql`${table.lastAttemptNumber} BETWEEN 1 AND ${sql.raw(String(cacheLastAttemptNumberMaximum))}`
        ),
        check(
            "cache_entries_attempt_run_id_check",
            uuidV7TextCheck(table.lastAttemptRunId)
        ),
        check(
            "cache_entries_attempt_status_check",
            sql`${table.lastAttemptStatus} IN ('failed', 'succeeded')`
        ),
        check(
            "cache_entries_duration_check",
            sql`${table.lastAttemptDurationMs} BETWEEN 0 AND 9007199254740991`
        ),
        check(
            "cache_entries_failure_code_check",
            optionalJobTerminalCodeCheck(table.failureCode, 128)
        ),
        check(
            "cache_entries_failure_message_check",
            optionalJobMessageCheck(
                table.failureMessage,
                cacheFailureMessageMaximumLength,
                cacheFailureMessageMaximumLength * 4
            )
        ),
        check(
            "cache_entries_failure_state_check",
            sql`(${table.lastAttemptStatus} = 'succeeded' AND ${table.consecutiveFailures} = 0 AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL) OR (${table.lastAttemptStatus} = 'failed' AND ${table.consecutiveFailures} BETWEEN 1 AND 9007199254740991 AND ${table.failureCode} IS NOT NULL AND ${table.failureMessage} IS NOT NULL)`
        ),
        check(
            "cache_entries_key_check",
            boundedJobKeyCheck(table.key, cacheEntryKeyMaximumLength)
        ),
        check(
            "cache_entries_metadata_json_check",
            sql`${table.metadataJson} IS NULL OR (${boundedJsonObjectCheck(table.metadataJson, cacheEntryMetadataMaximumBytes)})`
        ),
        check(
            "cache_entries_payload_json_check",
            sql`${table.payloadJson} IS NULL OR (${boundedJsonObjectCheck(table.payloadJson, cacheEntryPayloadMaximumBytes)})`
        ),
        check(
            "cache_entries_projection_check",
            sql`(${table.payloadJson} IS NULL AND ${table.metadataJson} IS NULL AND ${table.source} IS NULL AND ${table.schemaId} IS NULL AND ${table.lastSuccessAt} IS NULL AND ${table.expiresAt} IS NULL) OR (${table.payloadJson} IS NOT NULL AND ${table.metadataJson} IS NOT NULL AND ${table.source} IS NOT NULL AND ${table.schemaId} IS NOT NULL AND ${table.lastSuccessAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)`
        ),
        check(
            "cache_entries_schema_id_check",
            sql`${table.schemaId} IS NULL OR (${boundedJobKeyCheck(table.schemaId, cacheEntryKeyMaximumLength)})`
        ),
        check(
            "cache_entries_source_check",
            sql`${table.source} IS NULL OR (${boundedControlSafeTextCheck(table.source, 128)} AND length(CAST(${table.source} AS BLOB)) <= 512)`
        ),
        check(
            "cache_entries_success_state_check",
            sql`${table.lastAttemptStatus} <> 'succeeded' OR (${table.payloadJson} IS NOT NULL AND ${table.lastSuccessAt} = ${table.lastAttemptAt})`
        ),
        check(
            "cache_entries_time_check",
            sql`${timestampMillisecondsCheck(table.lastAttemptAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.lastAttemptAt} AND (${table.lastSuccessAt} IS NULL OR (${timestampMillisecondsCheck(table.lastSuccessAt)} AND ${table.lastSuccessAt} <= ${table.lastAttemptAt})) AND (${table.expiresAt} IS NULL OR (${timestampMillisecondsCheck(table.expiresAt)} AND ${table.lastSuccessAt} IS NOT NULL AND ${table.expiresAt} > ${table.lastSuccessAt}))`
        ),
        index("cache_entries_status_expires_key_idx").on(
            table.lastAttemptStatus,
            table.expiresAt,
            table.key
        ),
    ]
);
