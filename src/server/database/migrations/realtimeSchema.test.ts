import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "./freshDatabaseFixture.ts";

interface QueryPlanRow {
    detail: string;
}

describe("realtime event schema", () => {
    test("requires an entity identity at the storage boundary", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(`
                INSERT INTO realtime_events (
                    entity_id,
                    entity_type,
                    expires_at,
                    occurred_at,
                    operation,
                    payload_json,
                    topic
                ) VALUES (
                    'incident-1',
                    'incident',
                    2000,
                    1000,
                    'created',
                    '{"incidentId":"incident-1"}',
                    'incidents'
                )
            `);

            expect(() =>
                database.sqlite.run(`
                    INSERT INTO realtime_events (
                        entity_type,
                        expires_at,
                        occurred_at,
                        operation,
                        payload_json,
                        topic
                    ) VALUES (
                        'incident',
                        2001,
                        1001,
                        'updated',
                        '{"incidentId":"incident-1"}',
                        'incidents'
                    )
                `)
            ).toThrow("NOT NULL constraint failed: realtime_events.entity_id");

            expect(() =>
                database.sqlite.run(`
                    INSERT INTO realtime_events (
                        entity_id,
                        entity_type,
                        expires_at,
                        occurred_at,
                        operation,
                        payload_json,
                        topic
                    ) VALUES (
                        'incident-2',
                        'incident',
                        1000,
                        1000,
                        'updated',
                        '{"incidentId":"incident-2"}',
                        'incidents'
                    )
                `)
            ).toThrow("realtime_events_expiry_order_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("supports the planned bounded retention scan with the expiry index", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const plan = database.sqlite
                .query<QueryPlanRow, [number]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM realtime_events
                    WHERE expires_at <= ?
                    ORDER BY expires_at, id
                    LIMIT 100
                `)
                .all(2000);

            expect(
                plan.some((row) => row.detail.includes("realtime_events_expires_id_idx"))
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
