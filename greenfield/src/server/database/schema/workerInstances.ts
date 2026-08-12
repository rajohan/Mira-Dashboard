import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { boundedJsonArrayCheck, workerActionKeysMaximumBytes } from "./jobChecks.ts";

/** Durable worker registration and heartbeat state shared across rolling releases. */
export const workerInstances = sqliteTable(
    "worker_instances",
    {
        actionKeysJson: text("action_keys_json").notNull().default("[]"),
        capacity: integer("capacity").notNull(),
        drainingAt: integer("draining_at", { mode: "timestamp_ms" }),
        heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        pid: integer("pid").notNull(),
        releaseId: text("release_id").notNull(),
        startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
        state: text("state", { enum: ["draining", "online", "stopped"] }).notNull(),
        stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
    },
    (table) => [
        check(
            "worker_instances_action_keys_json_check",
            boundedJsonArrayCheck(table.actionKeysJson, workerActionKeysMaximumBytes)
        ),
        check("worker_instances_capacity_check", sql`${table.capacity} BETWEEN 1 AND 16`),
        check("worker_instances_id_check", uuidV7TextCheck(table.id)),
        check("worker_instances_pid_check", sql`${table.pid} BETWEEN 1 AND 2147483647`),
        check(
            "worker_instances_release_id_check",
            lowercaseHexTextCheck(table.releaseId, 40)
        ),
        check(
            "worker_instances_state_check",
            sql`(${table.state} = 'online' AND ${table.drainingAt} IS NULL AND ${table.stoppedAt} IS NULL) OR (${table.state} = 'draining' AND ${table.drainingAt} IS NOT NULL AND ${table.stoppedAt} IS NULL) OR (${table.state} = 'stopped' AND ${table.drainingAt} IS NOT NULL AND ${table.stoppedAt} IS NOT NULL)`
        ),
        check(
            "worker_instances_time_check",
            sql`${timestampMillisecondsCheck(table.startedAt)} AND ${timestampMillisecondsCheck(table.heartbeatAt)} AND ${table.heartbeatAt} >= ${table.startedAt} AND (${table.drainingAt} IS NULL OR (${timestampMillisecondsCheck(table.drainingAt)} AND ${table.drainingAt} >= ${table.startedAt})) AND (${table.stoppedAt} IS NULL OR (${timestampMillisecondsCheck(table.stoppedAt)} AND ${table.stoppedAt} >= ${table.drainingAt}))`
        ),
        index("worker_instances_heartbeat_id_idx").on(table.heartbeatAt, table.id),
    ]
);
