import { sql } from "drizzle-orm";
import {
    check,
    foreignKey,
    integer,
    primaryKey,
    sqliteTable,
    text,
} from "drizzle-orm/sqlite-core";

import {
    chatExternalRunsPerSessionMaximum,
    chatRuntimeSnapshotMaximumBytes,
} from "../../../contracts/chatModel.ts";
import { chatTranscriptGenerations } from "./chatTranscriptGenerations.ts";
import { boundedControlSafeTextCheck, timestampMillisecondsCheck } from "./checks.ts";
import { boundedJsonObjectCheck } from "./jobChecks.ts";

/**
 * Eight individually bounded external projections plus bounded replay metadata.
 * Persisting the complete session envelope remains an independently enforced limit.
 */
export const chatExternalRuntimeSnapshotMaximumBytes =
    chatExternalRunsPerSessionMaximum * chatRuntimeSnapshotMaximumBytes + 1024 * 1024;

/** Durable provider-origin projection for one current Gateway transcript. */
export const chatExternalRuntimeSnapshots = sqliteTable(
    "chat_external_runtime_snapshots",
    {
        gatewayScope: text("gateway_scope").notNull(),
        observationEpoch: integer("observation_epoch").notNull(),
        schemaVersion: integer("schema_version").notNull().default(1),
        sessionKey: text("session_key").notNull(),
        snapshotBytes: integer("snapshot_bytes").notNull(),
        snapshotJson: text("snapshot_json").notNull(),
        transcriptGeneration: integer("transcript_generation").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        primaryKey({
            columns: [table.gatewayScope, table.sessionKey],
            name: "chat_external_runtime_snapshots_pk",
        }),
        foreignKey({
            columns: [table.gatewayScope, table.sessionKey],
            foreignColumns: [
                chatTranscriptGenerations.gatewayScope,
                chatTranscriptGenerations.sessionKey,
            ],
            name: "chat_external_runtime_snapshots_transcript_fk",
        })
            .onDelete("cascade")
            .onUpdate("restrict"),
        check(
            "chat_external_runtime_snapshots_gateway_scope_check",
            boundedControlSafeTextCheck(table.gatewayScope, 64)
        ),
        check(
            "chat_external_runtime_snapshots_session_key_check",
            boundedControlSafeTextCheck(table.sessionKey, 512)
        ),
        check(
            "chat_external_runtime_snapshots_transcript_generation_check",
            sql`${table.transcriptGeneration} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "chat_external_runtime_snapshots_observation_epoch_check",
            sql`${table.observationEpoch} BETWEEN 0 AND 9007199254740991`
        ),
        check(
            "chat_external_runtime_snapshots_schema_version_check",
            sql`${table.schemaVersion} = 1`
        ),
        check(
            "chat_external_runtime_snapshots_payload_check",
            sql`${boundedJsonObjectCheck(table.snapshotJson, chatExternalRuntimeSnapshotMaximumBytes)} AND ${table.snapshotBytes} = length(CAST(${table.snapshotJson} AS BLOB))`
        ),
        check(
            "chat_external_runtime_snapshots_updated_at_check",
            timestampMillisecondsCheck(table.updatedAt)
        ),
    ]
);
