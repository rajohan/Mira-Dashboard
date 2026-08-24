import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { timestampMillisecondsCheck } from "./checks.ts";
import { jobActorCheck } from "./jobChecks.ts";

/** Required singleton controlling cross-process admission of new worker claims. */
export const jobWorkerControl = sqliteTable(
    "job_worker_control",
    {
        claimingPaused: integer("claiming_paused", { mode: "boolean" }).notNull(),
        id: integer("id").notNull().primaryKey(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        updatedById: text("updated_by_id"),
        updatedByKind: text("updated_by_kind", {
            enum: ["automation", "user"],
        }),
        version: integer("version").notNull(),
    },
    (table) => [
        check(
            "job_worker_control_actor_check",
            sql`(${table.updatedByKind} IS NULL AND ${table.updatedById} IS NULL) OR (${table.updatedByKind} IS NOT NULL AND ${table.updatedById} IS NOT NULL AND ${jobActorCheck(table.updatedByKind, table.updatedById)})`
        ),
        check(
            "job_worker_control_claiming_paused_check",
            sql`${table.claimingPaused} IN (0, 1)`
        ),
        check("job_worker_control_id_check", sql`${table.id} = 1`),
        check(
            "job_worker_control_updated_at_check",
            timestampMillisecondsCheck(table.updatedAt)
        ),
        check(
            "job_worker_control_version_check",
            sql`${table.version} BETWEEN 1 AND 9007199254740991`
        ),
    ]
);
