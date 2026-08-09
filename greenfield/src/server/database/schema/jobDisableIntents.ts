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
    boundedControlSafeTextCheck,
    boundedNonBlankTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { jobActorCheck } from "./jobChecks.ts";
import { scheduledJobs } from "./scheduledJobs.ts";

/** Append-only operator intent explaining why one schedule or external cron is disabled. */
export const jobDisableIntents = sqliteTable(
    "job_disable_intents",
    {
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        createdById: text("created_by_id").notNull(),
        createdByKind: text("created_by_kind", {
            enum: ["automation", "user"],
        }).notNull(),
        endedAt: integer("ended_at", { mode: "timestamp_ms" }),
        endedById: text("ended_by_id"),
        endedByKind: text("ended_by_kind", {
            enum: ["automation", "system", "user"],
        }),
        endedReason: text("ended_reason", {
            enum: ["expired", "re-enabled", "replaced", "target-deleted"],
        }),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
        externalJobId: text("external_job_id"),
        externalProvider: text("external_provider", { enum: ["openclaw"] }),
        id: text("id").notNull().primaryKey(),
        reason: text("reason").notNull(),
        scheduledJobId: text("scheduled_job_id").references(() => scheduledJobs.id, {
            onDelete: "restrict",
            onUpdate: "restrict",
        }),
        targetKind: text("target_kind", {
            enum: ["dashboard-schedule", "openclaw-cron"],
        }).notNull(),
    },
    (table) => [
        check(
            "job_disable_intents_created_at_check",
            timestampMillisecondsCheck(table.createdAt)
        ),
        check(
            "job_disable_intents_created_actor_check",
            jobActorCheck(table.createdByKind, table.createdById)
        ),
        check(
            "job_disable_intents_end_check",
            sql`(${table.endedAt} IS NULL AND ${table.endedByKind} IS NULL AND ${table.endedById} IS NULL AND ${table.endedReason} IS NULL) OR (${table.endedAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.endedAt)} AND ${table.endedAt} >= ${table.createdAt} AND ${table.endedByKind} IS NOT NULL AND ${table.endedById} IS NOT NULL AND ${table.endedReason} IN ('expired', 're-enabled', 'replaced', 'target-deleted') AND ${jobActorCheck(table.endedByKind, table.endedById, { allowSystem: true })} AND (${table.endedReason} <> 'expired' OR (${table.endedByKind} = 'system' AND ${table.expiresAt} IS NOT NULL AND ${table.endedAt} >= ${table.expiresAt})))`
        ),
        check(
            "job_disable_intents_expiry_check",
            sql`${table.expiresAt} IS NULL OR (${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt})`
        ),
        check(
            "job_disable_intents_external_job_id_check",
            sql`${table.externalJobId} IS NULL OR (${boundedNonBlankTextCheck(table.externalJobId, 256)})`
        ),
        check("job_disable_intents_id_check", uuidV7TextCheck(table.id)),
        check(
            "job_disable_intents_reason_check",
            sql`${boundedControlSafeTextCheck(table.reason, 1000)} AND length(CAST(${table.reason} AS BLOB)) <= 4000`
        ),
        check(
            "job_disable_intents_target_check",
            sql`(${table.targetKind} = 'dashboard-schedule' AND ${table.scheduledJobId} IS NOT NULL AND ${table.externalProvider} IS NULL AND ${table.externalJobId} IS NULL) OR (${table.targetKind} = 'openclaw-cron' AND ${table.scheduledJobId} IS NULL AND ${table.externalProvider} = 'openclaw' AND ${table.externalJobId} IS NOT NULL)`
        ),
        uniqueIndex("job_disable_intents_active_schedule_unique")
            .on(table.scheduledJobId)
            .where(sql`${table.scheduledJobId} IS NOT NULL AND ${table.endedAt} IS NULL`),
        uniqueIndex("job_disable_intents_active_external_unique")
            .on(table.externalProvider, table.externalJobId)
            .where(sql`${table.externalJobId} IS NOT NULL AND ${table.endedAt} IS NULL`),
        index("job_disable_intents_active_expiry_idx")
            .on(table.expiresAt, table.id)
            .where(sql`${table.expiresAt} IS NOT NULL AND ${table.endedAt} IS NULL`),
        index("job_disable_intents_schedule_created_id_idx").on(
            table.scheduledJobId,
            table.createdAt,
            table.id
        ),
        index("job_disable_intents_external_created_id_idx").on(
            table.externalProvider,
            table.externalJobId,
            table.createdAt,
            table.id
        ),
    ]
);
