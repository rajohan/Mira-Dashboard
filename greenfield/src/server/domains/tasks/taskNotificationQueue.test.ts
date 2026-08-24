import { describe, expect, test } from "bun:test";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createTaskNotificationQueue } from "./taskNotificationQueue.ts";

const taskId = "019fd200-0000-7000-8000-000000000001";
const actorId = "019fd200-0000-7000-8000-000000000002";
const firstEventId = "019fd200-0000-7000-8000-000000000003";
const secondEventId = "019fd200-0000-7000-8000-000000000004";
const firstWorkerId = "019fd200-0000-7000-8000-000000000005";
const secondWorkerId = "019fd200-0000-7000-8000-000000000006";

const directWriteAdmission: ImmediateDatabaseWriteAdmission = {
    run: (operation) => Promise.resolve(operation(() => {})),
};

function insertNotification(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>,
    input: {
        readonly availableAt: number;
        readonly createdAt: number;
        readonly eventId: string;
        readonly message: string;
    }
): void {
    database.sqlite.run(
        `INSERT INTO task_events (
            actor_id, actor_kind, created_at, event_type, id, payload_json, task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [actorId, "user", input.createdAt, "created", input.eventId, "{}", taskId]
    );
    database.sqlite.run(
        `INSERT INTO task_notification_outbox (
            available_at, created_at, event_id, message
        ) VALUES (?, ?, ?, ?)`,
        [input.availableAt, input.createdAt, input.eventId, input.message]
    );
}

describe("task notification queue", () => {
    test("claims eligible messages in order and recovers an expired lease", async () => {
        const database = await openFreshMigratedDatabase();
        const queue = createTaskNotificationQueue(database.orm, directWriteAdmission);

        try {
            insertNotification(database, {
                availableAt: 1000,
                createdAt: 1000,
                eventId: firstEventId,
                message: "First task notification",
            });
            insertNotification(database, {
                availableAt: 2000,
                createdAt: 2000,
                eventId: secondEventId,
                message: "Second task notification",
            });

            expect(
                await queue.claim({
                    leaseExpiresAtMs: 5000,
                    nowMs: 1500,
                    workerId: firstWorkerId,
                })
            ).toEqual([
                {
                    attemptCount: 1,
                    createdAtMs: 1000,
                    eventId: firstEventId,
                    message: "First task notification",
                },
            ]);
            expect(
                await queue.claim({
                    leaseExpiresAtMs: 5000,
                    nowMs: 1500,
                    workerId: secondWorkerId,
                })
            ).toEqual([]);
            expect(
                await queue.claim({
                    leaseExpiresAtMs: 7000,
                    nowMs: 5000,
                    workerId: secondWorkerId,
                })
            ).toEqual([
                {
                    attemptCount: 2,
                    createdAtMs: 1000,
                    eventId: firstEventId,
                    message: "First task notification",
                },
            ]);
            expect(
                await queue.claim({
                    leaseExpiresAtMs: 7000,
                    nowMs: 5000,
                    workerId: firstWorkerId,
                })
            ).toEqual([
                {
                    attemptCount: 1,
                    createdAtMs: 2000,
                    eventId: secondEventId,
                    message: "Second task notification",
                },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("releases retryable work and only lets the current live owner acknowledge", async () => {
        const database = await openFreshMigratedDatabase();
        const queue = createTaskNotificationQueue(database.orm, directWriteAdmission);

        try {
            insertNotification(database, {
                availableAt: 1000,
                createdAt: 1000,
                eventId: firstEventId,
                message: "Retry task notification",
            });
            await queue.claim({
                leaseExpiresAtMs: 5000,
                nowMs: 1000,
                workerId: firstWorkerId,
            });

            expect(
                await queue.retryLater({
                    availableAtMs: 3000,
                    eventId: firstEventId,
                    settledAtMs: 2000,
                    workerId: secondWorkerId,
                })
            ).toBeFalse();
            expect(
                await queue.retryLater({
                    availableAtMs: 3000,
                    eventId: firstEventId,
                    settledAtMs: 5000,
                    workerId: firstWorkerId,
                })
            ).toBeFalse();
            expect(
                await queue.retryLater({
                    availableAtMs: 3000,
                    eventId: firstEventId,
                    settledAtMs: 2000,
                    workerId: firstWorkerId,
                })
            ).toBeTrue();
            expect(
                await queue.claim({
                    leaseExpiresAtMs: 7000,
                    nowMs: 2999,
                    workerId: secondWorkerId,
                })
            ).toEqual([]);
            await queue.claim({
                leaseExpiresAtMs: 7000,
                nowMs: 3000,
                workerId: secondWorkerId,
            });
            expect(
                await queue.markDelivered({
                    deliveredAtMs: 4000,
                    eventId: firstEventId,
                    workerId: firstWorkerId,
                })
            ).toBeFalse();
            expect(
                await queue.markDelivered({
                    deliveredAtMs: 4000,
                    eventId: firstEventId,
                    workerId: secondWorkerId,
                })
            ).toBeTrue();
            expect(
                await queue.markDelivered({
                    deliveredAtMs: 4001,
                    eventId: firstEventId,
                    workerId: secondWorkerId,
                })
            ).toBeFalse();
        } finally {
            database.sqlite.close(true);
        }
    });
});
