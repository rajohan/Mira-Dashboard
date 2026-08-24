import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
} from "drizzle-orm/sqlite-core";

import { timestampMillisecondsCheck } from "./checks.ts";
import { boundedJsonObjectCheck, optionalJobMessageCheck } from "./jobChecks.ts";
import { jobRuns } from "./jobRuns.ts";
import { workerInstances } from "./workerInstances.ts";

/** Ordered bounded progress and lifecycle timeline for one durable job run. */
export const jobRunEvents = sqliteTable(
    "job_run_events",
    {
        attempt: integer("attempt").notNull(),
        jobRunId: text("job_run_id")
            .notNull()
            .references(() => jobRuns.id, {
                onDelete: "cascade",
                onUpdate: "restrict",
            }),
        kind: text("kind", {
            enum: [
                "cancel-requested",
                "cancelled",
                "claimed",
                "failed",
                "lease-expired",
                "output-truncated",
                "progress",
                "queued",
                "retry-scheduled",
                "stderr",
                "stdout",
                "succeeded",
                "timed-out",
            ],
        }).notNull(),
        message: text("message"),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        progressJson: text("progress_json"),
        sequence: integer("sequence").notNull(),
        workerInstanceId: text("worker_instance_id").references(
            () => workerInstances.id,
            {
                onDelete: "set null",
                onUpdate: "restrict",
            }
        ),
    },
    (table) => [
        check("job_run_events_attempt_check", sql`${table.attempt} BETWEEN 0 AND 10`),
        check(
            "job_run_events_kind_check",
            sql`${table.kind} IN ('cancel-requested', 'cancelled', 'claimed', 'failed', 'lease-expired', 'output-truncated', 'progress', 'queued', 'retry-scheduled', 'stderr', 'stdout', 'succeeded', 'timed-out')`
        ),
        check(
            "job_run_events_message_check",
            optionalJobMessageCheck(table.message, 4096, 4096)
        ),
        check(
            "job_run_events_occurred_at_check",
            timestampMillisecondsCheck(table.occurredAt)
        ),
        check(
            "job_run_events_payload_shape_check",
            sql`(${table.kind} = 'progress' AND ${table.progressJson} IS NOT NULL AND ${boundedJsonObjectCheck(table.progressJson, 16_384)}) OR (${table.kind} IN ('stderr', 'stdout') AND ${table.message} IS NOT NULL AND ${table.progressJson} IS NULL) OR (${table.kind} NOT IN ('progress', 'stderr', 'stdout') AND ${table.progressJson} IS NULL)`
        ),
        check("job_run_events_sequence_check", sql`${table.sequence} BETWEEN 1 AND 1000`),
        primaryKey({
            columns: [table.jobRunId, table.sequence],
            name: "job_run_events_pk",
        }),
        index("job_run_events_occurred_run_sequence_idx").on(
            table.occurredAt,
            table.jobRunId,
            table.sequence
        ),
    ]
);
