import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { timestampMillisecondsCheck, uuidV7TextCheck } from "./checks.ts";
import { boundedJobKeyCheck } from "./jobChecks.ts";
import { jobRuns } from "./jobRuns.ts";
import { workerInstances } from "./workerInstances.ts";

/** Cross-run exclusivity lease acquired atomically with one fenced run claim. */
export const resourceLeases = sqliteTable(
    "resource_leases",
    {
        acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        jobRunId: text("job_run_id")
            .notNull()
            .references(() => jobRuns.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
        leaseToken: text("lease_token").notNull(),
        renewedAt: integer("renewed_at", { mode: "timestamp_ms" }).notNull(),
        resourceKey: text("resource_key").notNull().primaryKey(),
        workerInstanceId: text("worker_instance_id")
            .notNull()
            .references(() => workerInstances.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
    },
    (table) => [
        check("resource_leases_lease_token_check", uuidV7TextCheck(table.leaseToken)),
        check(
            "resource_leases_resource_key_check",
            boundedJobKeyCheck(table.resourceKey, 128)
        ),
        check(
            "resource_leases_time_check",
            sql`${timestampMillisecondsCheck(table.acquiredAt)} AND ${timestampMillisecondsCheck(table.renewedAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.renewedAt} >= ${table.acquiredAt} AND ${table.expiresAt} > ${table.renewedAt}`
        ),
        index("resource_leases_expiry_key_idx").on(table.expiresAt, table.resourceKey),
        index("resource_leases_run_key_idx").on(table.jobRunId, table.resourceKey),
    ]
);
