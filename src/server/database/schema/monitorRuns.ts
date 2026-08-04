import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { reports } from "./reports.ts";

/** One complete or partial observation run from a named monitor. */
export const monitorRuns = sqliteTable(
    "monitor_runs",
    {
        completedAt: integer("completed_at", { mode: "timestamp_ms" }),
        completeSnapshot: integer("complete_snapshot", { mode: "boolean" }).notNull(),
        id: text("id").notNull().primaryKey(),
        monitorKey: text("monitor_key").notNull(),
        reportId: text("report_id").references(() => reports.id, {
            onDelete: "set null",
        }),
        submissionSha256: text("submission_sha256").notNull(),
        startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
        state: text("state", { enum: ["failed", "running", "succeeded"] }).notNull(),
    },
    (table) => [
        check(
            "monitor_runs_complete_snapshot_check",
            sql`${table.completeSnapshot} IN (0, 1)`
        ),
        check(
            "monitor_runs_state_check",
            sql`${table.state} IN ('failed', 'running', 'succeeded')`
        ),
        check(
            "monitor_runs_completion_check",
            sql`(${table.state} = 'running' AND ${table.completedAt} IS NULL) OR (${table.state} IN ('failed', 'succeeded') AND ${table.completedAt} IS NOT NULL)`
        ),
        check(
            "monitor_runs_completion_order_check",
            sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`
        ),
        check(
            "monitor_runs_submission_sha256_check",
            sql`length(${table.submissionSha256}) = 64 AND ${table.submissionSha256} NOT GLOB '*[^0-9a-f]*'`
        ),
        index("monitor_runs_monitor_completed_id_idx").on(
            table.monitorKey,
            table.completedAt,
            table.id
        ),
    ]
);
