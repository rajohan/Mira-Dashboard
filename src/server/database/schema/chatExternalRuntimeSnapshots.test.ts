import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import {
    chatExternalRuntimeSnapshotMaximumBytes,
    chatExternalRuntimeSnapshots,
} from "./chatExternalRuntimeSnapshots.ts";
import { chatTranscriptGenerations } from "./chatTranscriptGenerations.ts";
import * as databaseSchema from "./drizzleSchema.ts";

describe("external chat runtime snapshot Drizzle schema", () => {
    test("declares one bounded snapshot per Gateway session", () => {
        const config = getTableConfig(chatExternalRuntimeSnapshots);

        expect(config.name).toBe("chat_external_runtime_snapshots");
        expect(config.columns.map((column) => column.name)).toEqual([
            "gateway_scope",
            "observation_epoch",
            "schema_version",
            "session_key",
            "snapshot_bytes",
            "snapshot_json",
            "transcript_generation",
            "updated_at",
        ]);
        expect(config.primaryKeys).toHaveLength(1);
        expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
            "gateway_scope",
            "session_key",
        ]);
        expect(config.checks.map(({ name }) => name).toSorted()).toEqual([
            "chat_external_runtime_snapshots_gateway_scope_check",
            "chat_external_runtime_snapshots_observation_epoch_check",
            "chat_external_runtime_snapshots_payload_check",
            "chat_external_runtime_snapshots_schema_version_check",
            "chat_external_runtime_snapshots_session_key_check",
            "chat_external_runtime_snapshots_transcript_generation_check",
            "chat_external_runtime_snapshots_updated_at_check",
        ]);

        const reference = config.foreignKeys[0]?.reference();
        expect(reference?.foreignTable).toBe(chatTranscriptGenerations);
        expect(reference?.columns.map((column) => column.name)).toEqual([
            "gateway_scope",
            "session_key",
        ]);
        expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
            "gateway_scope",
            "session_key",
        ]);
        expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
        expect(config.foreignKeys[0]?.onUpdate).toBe("restrict");
    });

    test("exports the table and keeps a finite whole-session payload budget", () => {
        expect(databaseSchema.chatExternalRuntimeSnapshots).toBe(
            chatExternalRuntimeSnapshots
        );
        expect(chatExternalRuntimeSnapshotMaximumBytes).toBe(5 * 1024 * 1024);
    });
});
