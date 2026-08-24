import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { incidents } from "./incidents.ts";
import { monitorRuns } from "./monitorRuns.ts";

/** Historical evidence for each incident observation and generation. */
export const incidentObservations = sqliteTable(
    "incident_observations",
    {
        detailsJson: text("details_json").notNull().default("{}"),
        generation: integer("generation").notNull(),
        id: integer("id").primaryKey({ autoIncrement: true }),
        incidentId: text("incident_id")
            .notNull()
            .references(() => incidents.id, { onDelete: "cascade" }),
        monitorRunId: text("monitor_run_id")
            .notNull()
            .references(() => monitorRuns.id, { onDelete: "cascade" }),
        observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check(
            "incident_observations_details_json_check",
            sql`CASE WHEN json_valid(${table.detailsJson}) THEN json_type(${table.detailsJson}) = 'object' ELSE 0 END`
        ),
        check("incident_observations_generation_check", sql`${table.generation} >= 1`),
        index("incident_observations_incident_observed_id_idx").on(
            table.incidentId,
            table.observedAt,
            table.id
        ),
        index("incident_observations_run_idx").on(table.monitorRunId, table.id),
    ]
);
