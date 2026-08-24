import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { lowercaseHexTextCheck } from "./checks.ts";

/** Current lifecycle state for one stable monitor problem fingerprint. */
export const incidents = sqliteTable(
    "incidents",
    {
        detailsJson: text("details_json").notNull().default("{}"),
        fingerprint: text("fingerprint").notNull(),
        firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
        generation: integer("generation").notNull().default(1),
        id: text("id").notNull().primaryKey(),
        kind: text("kind").notNull(),
        lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
        monitorKey: text("monitor_key").notNull(),
        occurrenceCount: integer("occurrence_count").notNull().default(1),
        resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
        severity: text("severity", {
            enum: ["critical", "error", "info", "warning"],
        }).notNull(),
        state: text("state", { enum: ["active", "resolved"] }).notNull(),
        title: text("title").notNull(),
    },
    (table) => [
        check(
            "incidents_details_json_check",
            sql`CASE WHEN json_valid(${table.detailsJson}) THEN json_type(${table.detailsJson}) = 'object' ELSE 0 END`
        ),
        check(
            "incidents_fingerprint_check",
            lowercaseHexTextCheck(table.fingerprint, 64)
        ),
        check("incidents_generation_check", sql`${table.generation} >= 1`),
        check("incidents_occurrence_count_check", sql`${table.occurrenceCount} >= 1`),
        check(
            "incidents_severity_check",
            sql`${table.severity} IN ('critical', 'error', 'info', 'warning')`
        ),
        check("incidents_state_check", sql`${table.state} IN ('active', 'resolved')`),
        check(
            "incidents_resolution_check",
            sql`(${table.state} = 'active' AND ${table.resolvedAt} IS NULL) OR (${table.state} = 'resolved' AND ${table.resolvedAt} IS NOT NULL)`
        ),
        check(
            "incidents_seen_order_check",
            sql`${table.lastSeenAt} >= ${table.firstSeenAt}`
        ),
        check(
            "incidents_resolution_order_check",
            sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.lastSeenAt}`
        ),
        uniqueIndex("incidents_monitor_fingerprint_unique").on(
            table.monitorKey,
            table.fingerprint
        ),
        index("incidents_active_monitor_seen_idx")
            .on(table.monitorKey, table.lastSeenAt)
            .where(sql`${table.state} = 'active'`),
        index("incidents_last_seen_id_idx").on(table.lastSeenAt, table.id),
    ]
);
