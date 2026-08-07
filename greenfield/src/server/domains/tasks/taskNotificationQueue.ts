import * as v from "valibot";

import {
    taskNotificationClaimMaximum,
    type ClaimedTaskNotification,
    type TaskNotificationQueue,
} from "../../../shared/taskNotifications.ts";
import { compareStrings } from "../../../shared/validation.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import type { RuntimeOwnedDatabase } from "../../database/runtime/databaseService.ts";
import { taskNotificationOutboxSelectSchema } from "../../database/validation/taskNotificationOutbox.ts";

interface RawTaskNotificationRow {
    attempt_count: number;
    available_at: number;
    created_at: number;
    delivered_at: number | null;
    event_id: string;
    lease_expires_at: number | null;
    lease_owner: string | null;
    message: string;
}

function parseClaim(row: RawTaskNotificationRow): ClaimedTaskNotification {
    const parsed = v.parse(taskNotificationOutboxSelectSchema, {
        attemptCount: row.attempt_count,
        availableAt: new Date(row.available_at),
        createdAt: new Date(row.created_at),
        deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at),
        eventId: row.event_id,
        leaseExpiresAt:
            row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
        leaseOwner: row.lease_owner,
        message: row.message,
    });
    return Object.freeze({
        attemptCount: parsed.attemptCount,
        createdAtMs: parsed.createdAt.getTime(),
        eventId: parsed.eventId,
        message: parsed.message,
    });
}

function orderedClaims(
    rows: RawTaskNotificationRow[]
): readonly ClaimedTaskNotification[] {
    return Object.freeze(
        rows
            .toSorted((left, right) => {
                if (left.created_at < right.created_at) return -1;
                if (left.created_at > right.created_at) return 1;
                return compareStrings(left.event_id, right.event_id);
            })
            .map((row) => parseClaim(row))
    );
}

/**
 * Creates the admitted SQLite queue used by the task-notification worker.
 * Claim, acknowledgement, and retry transitions each run in one IMMEDIATE transaction.
 * @param database Process-owned runtime database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Validated durable task-notification queue.
 */
export function createTaskNotificationQueue(
    database: RuntimeOwnedDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): TaskNotificationQueue {
    type TransactionCallback = Parameters<RuntimeOwnedDatabase["transaction"]>[0];
    const write = <T>(operation: () => T): Promise<T> =>
        writeAdmission.run((markTransactionStarted) => {
            const callback = (() => {
                markTransactionStarted();
                return operation();
            }) as TransactionCallback;
            return database.transaction(callback, { behavior: "immediate" }) as T;
        });

    const queue: TaskNotificationQueue = {
        claim(input) {
            return write(() =>
                orderedClaims(
                    database.$client
                        .query<RawTaskNotificationRow, [string, number, number, number]>(`
                            UPDATE task_notification_outbox
                            SET attempt_count = attempt_count + 1,
                                lease_owner = ?,
                                lease_expires_at = ?
                            WHERE event_id IN (
                                SELECT event_id
                                FROM task_notification_outbox
                                WHERE delivered_at IS NULL
                                  AND available_at <= ?
                                  AND (lease_owner IS NULL OR lease_expires_at <= ?)
                                  AND attempt_count < 9007199254740991
                                ORDER BY available_at, created_at, event_id
                                LIMIT ${taskNotificationClaimMaximum}
                            )
                            RETURNING
                                attempt_count,
                                available_at,
                                created_at,
                                delivered_at,
                                event_id,
                                lease_expires_at,
                                lease_owner,
                                message
                        `)
                        .all(
                            input.workerId,
                            input.leaseExpiresAtMs,
                            input.nowMs,
                            input.nowMs
                        )
                )
            );
        },
        markDelivered(input) {
            return write(
                () =>
                    database.$client
                        .query<never, [number, string, string, number]>(`
                            UPDATE task_notification_outbox
                            SET delivered_at = ?,
                                lease_owner = NULL,
                                lease_expires_at = NULL
                            WHERE event_id = ?
                              AND lease_owner = ?
                              AND delivered_at IS NULL
                              AND lease_expires_at > ?
                        `)
                        .run(
                            input.deliveredAtMs,
                            input.eventId,
                            input.workerId,
                            input.deliveredAtMs
                        ).changes === 1
            );
        },
        retryLater(input) {
            return write(
                () =>
                    database.$client
                        .query<never, [number, string, string, number]>(`
                            UPDATE task_notification_outbox
                            SET available_at = ?,
                                lease_owner = NULL,
                                lease_expires_at = NULL
                            WHERE event_id = ?
                              AND lease_owner = ?
                              AND delivered_at IS NULL
                              AND lease_expires_at > ?
                        `)
                        .run(
                            input.availableAtMs,
                            input.eventId,
                            input.workerId,
                            input.settledAtMs
                        ).changes === 1
            );
        },
    };
    return Object.freeze(queue);
}
