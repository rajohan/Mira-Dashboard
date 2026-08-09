import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
    chatRunEventMaximum,
    chatRuntimeSnapshotMaximumBytes,
} from "../../../contracts/chatModel.ts";
import { chatRuns } from "./chatRuns.ts";
import { timestampMillisecondsCheck } from "./checks.ts";
import { boundedJsonObjectCheck } from "./jobChecks.ts";

/** Latest compact ordered projection used to recover one retained run quickly. */
export const chatRuntimeSnapshots = sqliteTable(
    "chat_runtime_snapshots",
    {
        chatRunId: text("chat_run_id")
            .notNull()
            .primaryKey()
            .references(() => chatRuns.id, {
                onDelete: "cascade",
                onUpdate: "restrict",
            }),
        firstSequence: integer("first_sequence").notNull(),
        schemaVersion: integer("schema_version").notNull().default(1),
        snapshotBytes: integer("snapshot_bytes").notNull(),
        snapshotJson: text("snapshot_json").notNull(),
        throughSequence: integer("through_sequence").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check(
            "chat_runtime_snapshots_schema_version_check",
            sql`${table.schemaVersion} = 1`
        ),
        check(
            "chat_runtime_snapshots_sequence_check",
            sql`${table.firstSequence} BETWEEN 1 AND ${sql.raw(String(chatRunEventMaximum))} AND ${table.throughSequence} BETWEEN ${table.firstSequence} AND ${sql.raw(String(chatRunEventMaximum))}`
        ),
        check(
            "chat_runtime_snapshots_payload_check",
            sql`${boundedJsonObjectCheck(table.snapshotJson, chatRuntimeSnapshotMaximumBytes)} AND ${table.snapshotBytes} = length(CAST(${table.snapshotJson} AS BLOB))`
        ),
        check(
            "chat_runtime_snapshots_updated_at_check",
            timestampMillisecondsCheck(table.updatedAt)
        ),
    ]
);
