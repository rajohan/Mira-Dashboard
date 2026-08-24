import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { agentCurrentTaskMaximumLength } from "../../../contracts/agentModel.ts";
import {
    boundedControlSafeTextCheck,
    nulFreeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

function agentIdCheck(column: Parameters<typeof nulFreeTextCheck>[0]) {
    return sql`length(${column}) BETWEEN 1 AND 64 AND ${nulFreeTextCheck(column)} AND ${column} = lower(${column}) AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9._-]*'`;
}

function actorCheck(
    kind: Parameters<typeof nulFreeTextCheck>[0],
    id: Parameters<typeof nulFreeTextCheck>[0]
) {
    return sql`(${kind} = 'user' AND ${uuidV7TextCheck(id)}) OR (${kind} = 'automation' AND ${agentIdCheck(id)})`;
}

/** Mutable active interval and immutable completed history for Dashboard agent tasks. */
export const agentTaskRuns = sqliteTable(
    "agent_task_runs",
    {
        agentId: text("agent_id").notNull(),
        completedAt: integer("completed_at", { mode: "timestamp_ms" }),
        completedById: text("completed_by_id"),
        completedByKind: text("completed_by_kind", {
            enum: ["automation", "user"],
        }),
        id: text("id").notNull().primaryKey(),
        lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
        lastUpdatedById: text("last_updated_by_id").notNull(),
        lastUpdatedByKind: text("last_updated_by_kind", {
            enum: ["automation", "user"],
        }).notNull(),
        startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
        startedById: text("started_by_id").notNull(),
        startedByKind: text("started_by_kind", {
            enum: ["automation", "user"],
        }).notNull(),
        task: text("task").notNull(),
    },
    (table) => [
        check("agent_task_runs_agent_id_check", agentIdCheck(table.agentId)),
        check(
            "agent_task_runs_completed_actor_check",
            sql`(${table.completedAt} IS NULL AND ${table.completedByKind} IS NULL AND ${table.completedById} IS NULL) OR (${table.completedAt} IS NOT NULL AND ${table.completedByKind} IS NOT NULL AND ${table.completedById} IS NOT NULL AND (${actorCheck(table.completedByKind, table.completedById)}))`
        ),
        check("agent_task_runs_id_check", uuidV7TextCheck(table.id)),
        check(
            "agent_task_runs_last_updated_actor_check",
            actorCheck(table.lastUpdatedByKind, table.lastUpdatedById)
        ),
        check(
            "agent_task_runs_started_actor_check",
            actorCheck(table.startedByKind, table.startedById)
        ),
        check(
            "agent_task_runs_task_check",
            boundedControlSafeTextCheck(table.task, agentCurrentTaskMaximumLength)
        ),
        check(
            "agent_task_runs_time_check",
            sql`${timestampMillisecondsCheck(table.startedAt)} AND ${timestampMillisecondsCheck(table.lastActivityAt)} AND ${table.lastActivityAt} >= ${table.startedAt} AND (${table.completedAt} IS NULL OR (${timestampMillisecondsCheck(table.completedAt)} AND ${table.completedAt} >= ${table.lastActivityAt}))`
        ),
        uniqueIndex("agent_task_runs_one_active_agent_idx")
            .on(table.agentId)
            .where(sql`${table.completedAt} IS NULL`),
        index("agent_task_runs_started_id_idx").on(table.startedAt, table.id),
        index("agent_task_runs_agent_started_id_idx").on(
            table.agentId,
            table.startedAt,
            table.id
        ),
    ]
);
