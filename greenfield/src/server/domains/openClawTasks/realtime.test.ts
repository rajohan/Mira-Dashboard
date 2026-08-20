import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createOpenClawTasksRealtimePublisher } from "./realtime.ts";

describe("OpenClaw task realtime publisher", () => {
    test("persists only an exact payload-free snapshot marker", async () => {
        const database = await openFreshMigratedDatabase();
        try {
            let wakes = 0;
            const publisher = createOpenClawTasksRealtimePublisher(
                database.orm,
                testImmediateDatabaseWriteAdmission,
                () => 1000,
                () => {
                    wakes += 1;
                    return Promise.reject(new Error("best-effort wake failed"));
                }
            );
            await publisher.publishSnapshotRequired();

            expect(
                database.orm
                    .select()
                    .from(realtimeEvents)
                    .orderBy(asc(realtimeEvents.id))
                    .all()
            ).toEqual([
                expect.objectContaining({
                    entityId: "current",
                    entityType: "openclaw-task",
                    occurredAt: new Date(1000),
                    operation: "snapshot-required",
                    payloadJson: '{"kind":"snapshot-required"}',
                    topic: "openclaw.tasks",
                }),
            ]);
            expect(wakes).toBe(1);
        } finally {
            database.sqlite.close(true);
        }
    });
});
