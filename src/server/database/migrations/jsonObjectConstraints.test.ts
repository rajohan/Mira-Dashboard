import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "./freshDatabaseFixture.ts";

const rejectedJsonDocuments = ["[]", '"string"', "42", "null", "not-json"];

describe("greenfield object JSON constraints", () => {
    test("keeps raw SQLite writes aligned with the Valibot object contract", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(
                `INSERT INTO reports (
                    body_markdown,
                    id,
                    kind,
                    metadata_json,
                    occurred_at,
                    source,
                    title
                ) VALUES ('Body', 'report-valid', 'heartbeat', '{}', 1000, 'openclaw', 'Valid report')`
            );
            database.sqlite.run(
                `INSERT INTO incidents (
                    details_json,
                    fingerprint,
                    first_seen_at,
                    id,
                    kind,
                    last_seen_at,
                    monitor_key,
                    severity,
                    state,
                    title
                ) VALUES ('{}', 'valid-fingerprint', 1000, 'incident-valid', 'system', 1000, 'ops-check', 'warning', 'active', 'Valid incident')`
            );
            database.sqlite.run(
                `INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    started_at,
                    state
                ) VALUES (1, 'run-valid', 'ops-check', 1000, 'running')`
            );
            database.sqlite.run(
                `INSERT INTO incident_observations (
                    details_json,
                    generation,
                    incident_id,
                    monitor_run_id,
                    observed_at
                ) VALUES ('{}', 1, 'incident-valid', 'run-valid', 1000)`
            );

            for (const [index, document] of rejectedJsonDocuments.entries()) {
                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO reports (
                            body_markdown,
                            id,
                            kind,
                            metadata_json,
                            occurred_at,
                            source,
                            title
                        ) VALUES ('Body', ?, 'heartbeat', ?, 1000, 'openclaw', 'Invalid report')`,
                        [`report-invalid-${index}`, document]
                    )
                ).toThrow("reports_metadata_json_check");

                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO incidents (
                            details_json,
                            fingerprint,
                            first_seen_at,
                            id,
                            kind,
                            last_seen_at,
                            monitor_key,
                            severity,
                            state,
                            title
                        ) VALUES (?, ?, 1000, ?, 'system', 1000, 'ops-check', 'warning', 'active', 'Invalid incident')`,
                        [
                            document,
                            `invalid-fingerprint-${index}`,
                            `incident-invalid-${index}`,
                        ]
                    )
                ).toThrow("incidents_details_json_check");

                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO incident_observations (
                            details_json,
                            generation,
                            incident_id,
                            monitor_run_id,
                            observed_at
                        ) VALUES (?, 1, 'incident-valid', 'run-valid', 1000)`,
                        [document]
                    )
                ).toThrow("incident_observations_details_json_check");
            }
        } finally {
            database.sqlite.close(true);
        }
    });
});
