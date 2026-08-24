import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    lowercaseUuidTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { jobRuns } from "./jobRuns.ts";
import { workerInstances } from "./workerInstances.ts";

/** Singleton cross-process admission fence armed only by a running host-restart claim. */
export const hostRestartClaimFence = sqliteTable(
    "host_restart_claim_fence",
    {
        armedAt: integer("armed_at", { mode: "timestamp_ms" }).notNull(),
        bootIdentity: text("boot_identity").notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        id: integer("id").notNull().primaryKey(),
        jobRunId: text("job_run_id")
            .notNull()
            .references(() => jobRuns.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
        leaseToken: text("lease_token").notNull(),
        workerInstanceId: text("worker_instance_id")
            .notNull()
            .references(() => workerInstances.id, {
                onDelete: "restrict",
                onUpdate: "restrict",
            }),
    },
    (table) => [
        check(
            "host_restart_claim_fence_boot_identity_check",
            lowercaseUuidTextCheck(table.bootIdentity)
        ),
        check("host_restart_claim_fence_id_check", sql`${table.id} = 1`),
        check(
            "host_restart_claim_fence_lease_token_check",
            uuidV7TextCheck(table.leaseToken)
        ),
        check(
            "host_restart_claim_fence_time_check",
            sql`${timestampMillisecondsCheck(table.armedAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.armedAt}`
        ),
    ]
);
