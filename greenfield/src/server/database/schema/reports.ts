import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Immutable report documents, including heartbeat reports. */
export const reports = sqliteTable(
    "reports",
    {
        bodyMarkdown: text("body_markdown").notNull(),
        id: text("id").notNull().primaryKey(),
        kind: text("kind").notNull(),
        metadataJson: text("metadata_json").notNull().default("{}"),
        occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
        source: text("source").notNull(),
        sourceJobId: text("source_job_id"),
        status: text("status", { enum: ["error", "ok", "warning"] })
            .notNull()
            .default("ok"),
        summary: text("summary"),
        title: text("title").notNull(),
    },
    (table) => [
        check(
            "reports_metadata_json_check",
            sql`CASE WHEN json_valid(${table.metadataJson}) THEN json_type(${table.metadataJson}) = 'object' ELSE 0 END`
        ),
        check("reports_status_check", sql`${table.status} IN ('error', 'ok', 'warning')`),
        index("reports_kind_occurred_id_idx").on(table.kind, table.occurredAt, table.id),
        index("reports_source_job_occurred_id_idx").on(
            table.source,
            table.sourceJobId,
            table.occurredAt,
            table.id
        ),
    ]
);
