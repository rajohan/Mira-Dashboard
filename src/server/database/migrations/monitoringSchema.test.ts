import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "./freshDatabaseFixture.ts";

interface QueryPlanRow {
    detail: string;
}

const insertIncidentSql = `
    INSERT INTO incidents (
        details_json,
        fingerprint,
        first_seen_at,
        generation,
        id,
        kind,
        last_seen_at,
        monitor_key,
        occurrence_count,
        severity,
        state,
        title
    ) VALUES (?, ?, 1000, 1, ?, 'system', 1000, ?, 1, 'warning', 'active', 'Disk pressure')
`;

describe("monitoring schema", () => {
    test("enforces incident and notification lifecycle invariants", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(insertIncidentSql, [
                "{}",
                "filesystem:root:pressure",
                "incident-1",
                "ops-check",
            ]);

            expect(() =>
                database.sqlite.run(insertIncidentSql, [
                    "{}",
                    "filesystem:root:pressure",
                    "incident-2",
                    "ops-check",
                ])
            ).toThrow();
            expect(() =>
                database.sqlite.run(insertIncidentSql, [
                    "{}",
                    "memory:pressure",
                    null,
                    "ops-check",
                ])
            ).toThrow("NOT NULL constraint failed: incidents.id");
            expect(() =>
                database.sqlite.run(insertIncidentSql, [
                    "not-json",
                    "cpu:pressure",
                    "incident-3",
                    "ops-check",
                ])
            ).toThrow("incidents_details_json_check");

            database.sqlite.run(
                `INSERT INTO notifications (
                    channel,
                    id,
                    incident_generation,
                    incident_id,
                    kind,
                    message,
                    occurred_at,
                    severity,
                    title
                ) VALUES ('dashboard', ?, 1, 'incident-1', 'incident-opened', 'Disk pressure', 1000, 'warning', 'Disk pressure')`,
                ["notification-1"]
            );

            expect(() =>
                database.sqlite.run(
                    `INSERT INTO notifications (
                        channel,
                        id,
                        incident_generation,
                        incident_id,
                        kind,
                        message,
                        occurred_at,
                        severity,
                        title
                    ) VALUES ('dashboard', ?, 1, 'incident-1', 'incident-opened', 'Duplicate', 1001, 'warning', 'Duplicate')`,
                    ["notification-2"]
                )
            ).toThrow();

            expect(() =>
                database.sqlite.run(
                    `INSERT INTO monitor_runs (
                        complete_snapshot,
                        id,
                        monitor_key,
                        submission_sha256,
                        started_at,
                        state
                    ) VALUES (2, 'run-1', 'ops-check', '${"a".repeat(64)}', 1000, 'running')`
                )
            ).toThrow("monitor_runs_complete_snapshot_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO monitor_runs (
                        complete_snapshot,
                        id,
                        monitor_key,
                        submission_sha256,
                        started_at,
                        state
                    ) VALUES (1, 'run-2', 'ops-check', '${"a".repeat(64)}', 'not-a-timestamp', 'running')`
                )
            ).toThrow();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces incident temporal invariants", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(insertIncidentSql, [
                "{}",
                "filesystem:root:pressure",
                "incident-1",
                "ops-check",
            ]);

            expect(() =>
                database.sqlite.run(
                    "UPDATE incidents SET last_seen_at = 999 WHERE id = 'incident-1'"
                )
            ).toThrow("incidents_seen_order_check");
            expect(() =>
                database.sqlite.run(
                    "UPDATE incidents SET resolved_at = 999, state = 'resolved' WHERE id = 'incident-1'"
                )
            ).toThrow("incidents_resolution_order_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces monitor-run completion and checksum invariants", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO monitor_runs (
                        completed_at,
                        complete_snapshot,
                        id,
                        monitor_key,
                        submission_sha256,
                        started_at,
                        state
                    ) VALUES (999, 1, 'run-out-of-order', 'ops-check', '${"a".repeat(64)}', 1000, 'succeeded')
                `)
            ).toThrow("monitor_runs_completion_order_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO monitor_runs (
                        complete_snapshot,
                        id,
                        monitor_key,
                        submission_sha256,
                        started_at,
                        state
                    ) VALUES (1, 'run-invalid-checksum', 'ops-check', '${"A".repeat(64)}', 1000, 'running')
                `)
            ).toThrow("monitor_runs_submission_sha256_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces observation severity", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(insertIncidentSql, [
                "{}",
                "filesystem:root:pressure",
                "incident-1",
                "ops-check",
            ]);
            database.sqlite.run(`
                INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    submission_sha256,
                    started_at,
                    state
                ) VALUES (1, 'run-valid', 'ops-check', '${"a".repeat(64)}', 1000, 'running')
            `);
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO incident_observations (
                        details_json,
                        generation,
                        incident_id,
                        kind,
                        monitor_run_id,
                        observed_at,
                        severity,
                        title
                    ) VALUES ('{}', 1, 'incident-1', 'system', 'run-valid', 1000, 'unknown', 'Invalid severity')
                `)
            ).toThrow("incident_observations_severity_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces observation uniqueness", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(insertIncidentSql, [
                "{}",
                "filesystem:root:pressure",
                "incident-1",
                "ops-check",
            ]);
            database.sqlite.run(`
                INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    submission_sha256,
                    started_at,
                    state
                ) VALUES (1, 'run-valid', 'ops-check', '${"a".repeat(64)}', 1000, 'running')
            `);
            const insertObservation = `
                INSERT INTO incident_observations (
                    details_json,
                    generation,
                    incident_id,
                    kind,
                    monitor_run_id,
                    observed_at,
                    severity,
                    title
                ) VALUES ('{}', 1, 'incident-1', 'system', 'run-valid', 1000, 'warning', 'Disk pressure')
            `;
            database.sqlite.run(insertObservation);
            expect(() => database.sqlite.run(insertObservation)).toThrow(
                "UNIQUE constraint failed"
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("uses the declared partial indexes for monitoring reads", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const incidentPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM incidents
                    WHERE monitor_key = ?
                      AND state = 'active'
                    ORDER BY last_seen_at DESC
                `)
                .all("ops-check");
            const notificationPlan = database.sqlite
                .query<QueryPlanRow, []>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM notifications
                    WHERE read_at IS NULL
                    ORDER BY occurred_at DESC
                `)
                .all();
            const monitorRunPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM monitor_runs
                    WHERE monitor_key = ?
                      AND complete_snapshot = 1
                      AND state = 'succeeded'
                      AND completed_at IS NOT NULL
                    ORDER BY completed_at DESC, id DESC
                    LIMIT 1
                `)
                .all("ops-check");

            expect(
                incidentPlan.some((row) =>
                    row.detail.includes("incidents_active_monitor_seen_idx")
                )
            ).toBeTrue();
            expect(
                notificationPlan.some((row) =>
                    row.detail.includes("notifications_unread_occurred_idx")
                )
            ).toBeTrue();
            expect(
                monitorRunPlan.some((row) =>
                    row.detail.includes("monitor_runs_monitor_completed_id_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
