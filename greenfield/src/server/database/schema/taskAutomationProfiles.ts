import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { boundedControlSafeTextCheck, uuidV7TextCheck } from "./checks.ts";
import { tasks } from "./tasks.ts";

/** Durable task-to-OpenClaw cron relationship, separate from volatile run state. */
export const taskAutomationProfiles = sqliteTable(
    "task_automation_profiles",
    {
        cronJobId: text("cron_job_id").notNull(),
        kind: text("kind", { enum: ["openclaw-cron"] }).notNull(),
        model: text("model"),
        recurring: integer("recurring", { mode: "boolean" }).notNull(),
        scheduleSummary: text("schedule_summary"),
        sessionTarget: text("session_target"),
        taskId: text("task_id")
            .notNull()
            .primaryKey()
            .references(() => tasks.id, { onDelete: "cascade" }),
        thinking: text("thinking"),
    },
    (table) => [
        check(
            "task_automation_profiles_cron_job_id_check",
            boundedControlSafeTextCheck(table.cronJobId, 200)
        ),
        check(
            "task_automation_profiles_kind_check",
            sql`${table.kind} = 'openclaw-cron'`
        ),
        check(
            "task_automation_profiles_model_check",
            sql`${table.model} IS NULL OR (${boundedControlSafeTextCheck(table.model, 200)})`
        ),
        check(
            "task_automation_profiles_recurring_check",
            sql`${table.recurring} IN (0, 1)`
        ),
        check(
            "task_automation_profiles_schedule_summary_check",
            sql`${table.scheduleSummary} IS NULL OR (${boundedControlSafeTextCheck(table.scheduleSummary, 500)})`
        ),
        check(
            "task_automation_profiles_session_target_check",
            sql`${table.sessionTarget} IS NULL OR (${boundedControlSafeTextCheck(table.sessionTarget, 200)})`
        ),
        check("task_automation_profiles_task_id_check", uuidV7TextCheck(table.taskId)),
        check(
            "task_automation_profiles_thinking_check",
            sql`${table.thinking} IS NULL OR (${boundedControlSafeTextCheck(table.thinking, 200)})`
        ),
        uniqueIndex("task_automation_profiles_cron_job_id_unique").on(table.cronJobId),
    ]
);
