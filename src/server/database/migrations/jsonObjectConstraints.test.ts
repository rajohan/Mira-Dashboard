import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

const rejectedJsonDocuments = ["[]", '"string"', "42", "null", "not-json"];
const excessiveJsonDepth = `${'{"nested":'.repeat(14)}null${"}".repeat(14)}`;
const rejectedBoundedJsonDocuments = [
    '{"number":9007199254740992}',
    '{"number":-9007199254740992}',
    '{"number":1e400}',
    excessiveJsonDepth,
];
const validIncidentFingerprint = "d".repeat(64);

describe("database object JSON constraints", () => {
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
                ) VALUES ('{}', '${validIncidentFingerprint}', 1000, 'incident-valid', 'system', 1000, 'ops-check', 'warning', 'active', 'Valid incident')`
            );
            database.sqlite.run(
                `INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    submission_sha256,
                    started_at,
                    state
                ) VALUES (1, 'run-valid', 'ops-check', '${"a".repeat(64)}', 1000, 'running')`
            );
            database.sqlite.run(
                `INSERT INTO incident_observations (
                    details_json,
                    generation,
                    incident_id,
                    kind,
                    monitor_run_id,
                    observed_at,
                    severity,
                    title
                ) VALUES ('{}', 1, 'incident-valid', 'system', 'run-valid', 1000, 'warning', 'Valid observation')`
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
                        [document, validIncidentFingerprint, `incident-invalid-${index}`]
                    )
                ).toThrow("incidents_details_json_check");

                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO incident_observations (
                            details_json,
                            generation,
                            incident_id,
                            kind,
                            monitor_run_id,
                            observed_at,
                            severity,
                            title
                        ) VALUES (?, 1, 'incident-valid', 'system', 'run-valid', 1000, 'warning', 'Invalid observation')`,
                        [document]
                    )
                ).toThrow("incident_observations_details_json_check");
            }
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects monitoring JSON that cannot cross the bounded read boundary", async () => {
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
                ) VALUES ('{}', '${validIncidentFingerprint}', 1000, 'incident-valid', 'system', 1000, 'ops-check', 'warning', 'active', 'Valid incident')`
            );
            database.sqlite.run(
                `INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    submission_sha256,
                    started_at,
                    state
                ) VALUES (1, 'run-valid', 'ops-check', '${"a".repeat(64)}', 1000, 'running')`
            );
            database.sqlite.run(
                `INSERT INTO incident_observations (
                    details_json,
                    generation,
                    incident_id,
                    kind,
                    monitor_run_id,
                    observed_at,
                    severity,
                    title
                ) VALUES ('{}', 1, 'incident-valid', 'system', 'run-valid', 1000, 'warning', 'Valid observation')`
            );

            for (const [index, document] of rejectedBoundedJsonDocuments.entries()) {
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
                        [`report-bounded-invalid-${index}`, document]
                    )
                ).toThrow("reports metadata must be bounded monitoring JSON");

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
                            index.toString(16).repeat(64),
                            `incident-bounded-invalid-${index}`,
                        ]
                    )
                ).toThrow("incidents details must be bounded monitoring JSON");

                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO incident_observations (
                            details_json,
                            generation,
                            incident_id,
                            kind,
                            monitor_run_id,
                            observed_at,
                            severity,
                            title
                        ) VALUES (?, 1, 'incident-valid', 'system', 'run-valid', 1000, 'warning', 'Invalid observation')`,
                        [document]
                    )
                ).toThrow(
                    "incident observations details must be bounded monitoring JSON"
                );
            }

            const unsafeNumber = '{"number":9007199254740992}';
            expect(() =>
                database.sqlite.run(
                    "UPDATE reports SET metadata_json = ? WHERE id = 'report-valid'",
                    [unsafeNumber]
                )
            ).toThrow("reports metadata must be bounded monitoring JSON");
            expect(() =>
                database.sqlite.run(
                    "UPDATE incidents SET details_json = ? WHERE id = 'incident-valid'",
                    [unsafeNumber]
                )
            ).toThrow("incidents details must be bounded monitoring JSON");
            expect(() =>
                database.sqlite.run(
                    "UPDATE incident_observations SET details_json = ? WHERE incident_id = 'incident-valid'",
                    [unsafeNumber]
                )
            ).toThrow("incident observations details must be bounded monitoring JSON");
        } finally {
            database.sqlite.close(true);
        }
    });
});
