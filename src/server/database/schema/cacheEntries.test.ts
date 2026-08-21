import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { cacheEntries } from "./cacheEntries.ts";
import { jobRuns } from "./jobRuns.ts";

describe("cache entry Drizzle schema", () => {
    test("stores separate attempt outcome and last-known-good projection state", () => {
        const config = getTableConfig(cacheEntries);
        expect(config.columns.map((column) => column.name)).toEqual([
            "consecutive_failures",
            "expires_at",
            "failure_code",
            "failure_message",
            "key",
            "last_attempt_at",
            "last_attempt_duration_ms",
            "last_attempt_number",
            "last_attempt_run_id",
            "last_attempt_status",
            "last_success_at",
            "metadata_json",
            "payload_json",
            "schema_id",
            "source",
            "updated_at",
        ]);
        expect(config.checks.map((constraint) => constraint.name).toSorted()).toEqual([
            "cache_entries_attempt_number_check",
            "cache_entries_attempt_run_id_check",
            "cache_entries_attempt_status_check",
            "cache_entries_duration_check",
            "cache_entries_failure_code_check",
            "cache_entries_failure_message_check",
            "cache_entries_failure_state_check",
            "cache_entries_key_check",
            "cache_entries_metadata_json_check",
            "cache_entries_payload_json_check",
            "cache_entries_projection_check",
            "cache_entries_schema_id_check",
            "cache_entries_source_check",
            "cache_entries_success_state_check",
            "cache_entries_time_check",
        ]);
        expect(config.indexes).toHaveLength(1);
        expect(config.indexes[0]?.config.name).toBe(
            "cache_entries_status_expires_key_idx"
        );
        expect(
            config.indexes[0]?.config.columns.map((column) =>
                "name" in column ? column.name : undefined
            )
        ).toEqual(["last_attempt_status", "expires_at", "key"]);

        const runReference = config.foreignKeys[0]?.reference();
        expect(runReference?.foreignTable).toBe(jobRuns);
        expect(runReference?.columns[0]?.name).toBe("last_attempt_run_id");
        expect(config.foreignKeys[0]?.onDelete).toBe("restrict");
        expect(config.foreignKeys[0]?.onUpdate).toBe("restrict");
    });
});
