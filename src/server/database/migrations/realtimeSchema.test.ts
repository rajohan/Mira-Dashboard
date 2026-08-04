import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "./freshDatabaseFixture.ts";

describe("greenfield realtime event schema", () => {
    test("requires an entity identity at the storage boundary", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(`
                INSERT INTO realtime_events (
                    entity_id,
                    entity_type,
                    occurred_at,
                    operation,
                    payload_json,
                    topic
                ) VALUES (
                    'incident-1',
                    'incident',
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
                        occurred_at,
                        operation,
                        payload_json,
                        topic
                    ) VALUES (
                        'incident',
                        1001,
                        'updated',
                        '{"incidentId":"incident-1"}',
                        'incidents'
                    )
                `)
            ).toThrow("NOT NULL constraint failed: realtime_events.entity_id");
        } finally {
            database.sqlite.close(true);
        }
    });
});
