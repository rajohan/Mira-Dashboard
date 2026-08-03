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

describe("greenfield monitoring schema", () => {
    test("enforces incident and notification lifecycle invariants", () => {
        const database = openFreshMigratedDatabase();

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
                        started_at,
                        state
                    ) VALUES (2, 'run-1', 'ops-check', 1000, 'running')`
                )
            ).toThrow("monitor_runs_complete_snapshot_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO monitor_runs (
                        complete_snapshot,
                        id,
                        monitor_key,
                        started_at,
                        state
                    ) VALUES (1, 'run-2', 'ops-check', 'not-a-timestamp', 'running')`
                )
            ).toThrow();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("uses the declared partial indexes for live incident views", () => {
        const database = openFreshMigratedDatabase();

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
        } finally {
            database.sqlite.close(true);
        }
    });
});
