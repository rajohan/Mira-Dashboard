import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { canonicalScheduleTimeZones } from "../../../contracts/scheduleTimeZones.ts";
import { boundedControlSafeTextCheck, timestampMillisecondsCheck } from "./checks.ts";
import {
    boundedJobKeyCheck,
    boundedJsonArrayCheck,
    boundedJsonObjectCheck,
} from "./jobChecks.ts";

const canonicalScheduleTimeZoneSql = sql.raw(
    canonicalScheduleTimeZones
        .map((timeZone) => `'${timeZone.replaceAll("'", "''")}'`)
        .join(", ")
);

/** Dashboard-owned recurring job definitions reconciled against the action registry. */
export const scheduledJobs = sqliteTable(
    "scheduled_jobs",
    {
        actionKey: text("action_key").notNull(),
        actionPayloadJson: text("action_payload_json").notNull(),
        attemptLimit: integer("attempt_limit").notNull(),
        cancellationPolicy: text("cancellation_policy", {
            enum: ["cooperative", "never", "queued-only"],
        }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        cronExpression: text("cron_expression"),
        description: text("description").notNull(),
        enabled: integer("enabled", { mode: "boolean" }).notNull(),
        id: text("id").notNull().primaryKey(),
        intervalMs: integer("interval_ms"),
        name: text("name").notNull(),
        nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
        priority: integer("priority").notNull(),
        resourceClass: text("resource_class", {
            enum: ["exclusive", "host-heavy", "interactive", "light", "network"],
        }).notNull(),
        resourceKeysJson: text("resource_keys_json").notNull(),
        retrySafe: integer("retry_safe", { mode: "boolean" }).notNull(),
        scheduleKind: text("schedule_kind", {
            enum: ["cron", "daily", "interval"],
        }).notNull(),
        timeOfDay: text("time_of_day"),
        timeZone: text("time_zone"),
        timeoutMs: integer("timeout_ms").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        version: integer("version").notNull(),
    },
    (table) => [
        check(
            "scheduled_jobs_action_key_check",
            boundedJobKeyCheck(table.actionKey, 128)
        ),
        check(
            "scheduled_jobs_action_payload_json_check",
            boundedJsonObjectCheck(table.actionPayloadJson, 65_536)
        ),
        check(
            "scheduled_jobs_attempt_limit_check",
            sql`${table.attemptLimit} BETWEEN 1 AND 10`
        ),
        check(
            "scheduled_jobs_cancellation_policy_check",
            sql`${table.cancellationPolicy} IN ('cooperative', 'never', 'queued-only')`
        ),
        check(
            "scheduled_jobs_created_at_check",
            timestampMillisecondsCheck(table.createdAt)
        ),
        check(
            "scheduled_jobs_description_check",
            sql`${boundedControlSafeTextCheck(table.description, 1000)} AND length(CAST(${table.description} AS BLOB)) <= 4000`
        ),
        check("scheduled_jobs_enabled_check", sql`${table.enabled} IN (0, 1)`),
        check("scheduled_jobs_id_check", boundedJobKeyCheck(table.id, 80)),
        check(
            "scheduled_jobs_name_check",
            sql`${boundedControlSafeTextCheck(table.name, 160)} AND length(CAST(${table.name} AS BLOB)) <= 640`
        ),
        check(
            "scheduled_jobs_next_run_check",
            sql`${table.enabled} = 0 OR (${table.nextRunAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.nextRunAt)})`
        ),
        check(
            "scheduled_jobs_priority_check",
            sql`${table.priority} BETWEEN -100 AND 100`
        ),
        check(
            "scheduled_jobs_resource_class_check",
            sql`${table.resourceClass} IN ('exclusive', 'host-heavy', 'interactive', 'light', 'network')`
        ),
        check(
            "scheduled_jobs_resource_keys_json_check",
            boundedJsonArrayCheck(table.resourceKeysJson, 4096)
        ),
        check("scheduled_jobs_retry_safe_check", sql`${table.retrySafe} IN (0, 1)`),
        check(
            "scheduled_jobs_schedule_shape_check",
            sql`(${table.scheduleKind} = 'interval' AND ${table.intervalMs} BETWEEN 60000 AND 31536000000 AND ${table.timeOfDay} IS NULL AND ${table.cronExpression} IS NULL AND ${table.timeZone} IS NULL) OR (${table.scheduleKind} = 'daily' AND ${table.intervalMs} IS NULL AND ${table.timeOfDay} IS NOT NULL AND ${table.timeOfDay} GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(${table.timeOfDay}, 1, 2) AS INTEGER) BETWEEN 0 AND 23 AND ${table.cronExpression} IS NULL AND ${table.timeZone} IS NOT NULL) OR (${table.scheduleKind} = 'cron' AND ${table.intervalMs} IS NULL AND ${table.timeOfDay} IS NULL AND ${table.cronExpression} IS NOT NULL AND length(${table.cronExpression}) BETWEEN 9 AND 200 AND ${table.cronExpression} = trim(${table.cronExpression}) AND ${table.cronExpression} NOT LIKE '%  %' AND length(${table.cronExpression}) - length(replace(${table.cronExpression}, ' ', '')) = 4 AND ${table.timeZone} IS NOT NULL)`
        ),
        check(
            "scheduled_jobs_time_zone_check",
            sql`${table.timeZone} IS NULL OR ${table.timeZone} IN (${canonicalScheduleTimeZoneSql})`
        ),
        check(
            "scheduled_jobs_timeout_check",
            sql`${table.timeoutMs} BETWEEN 1000 AND 86400000`
        ),
        check(
            "scheduled_jobs_updated_at_check",
            sql`${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.createdAt}`
        ),
        check(
            "scheduled_jobs_version_check",
            sql`${table.version} BETWEEN 1 AND 9007199254740991`
        ),
        index("scheduled_jobs_due_idx")
            .on(table.nextRunAt, table.id)
            .where(sql`${table.enabled} = 1`),
        index("scheduled_jobs_updated_id_idx").on(table.updatedAt, table.id),
    ]
);
