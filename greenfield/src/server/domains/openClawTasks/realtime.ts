import { addMilliseconds, toDate } from "date-fns";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    openClawTasksRealtimeRoutingSchema,
    openClawTasksRealtimeTopic,
    openClawTasksSnapshotRequiredPayloadSchema,
} from "../../../contracts/openClawTasksRealtime.ts";
import { realtimeEventRetentionMilliseconds } from "../../../contracts/realtime.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type OpenClawTasksTransaction = Parameters<TransactionCallback>[0];

export interface OpenClawTasksRealtimePublisher {
    /** Appends only a payload-free invalidation marker to the durable outbox. */
    readonly publishSnapshotRequired: (at?: Date) => Promise<void>;
}

/**
 * Creates the sole audited OpenClaw task provider-event to outbox bridge.
 * @param database Owned SQLite database.
 * @param writeAdmission Immediate-transaction admission controller.
 * @param nowMs Current-time source.
 * @param wakeEventPump Post-commit durable outbox wakeup.
 * @returns The payload-free task invalidation publisher.
 */
export function createOpenClawTasksRealtimePublisher(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission,
    nowMs: () => number = Date.now,
    wakeEventPump: () => Promise<void> = () => Promise.resolve()
): OpenClawTasksRealtimePublisher {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: OpenClawTasksTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    return Object.freeze({
        async publishSnapshotRequired(at = toDate(nowMs())) {
            await writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction) => {
                        markTransactionStarted();
                        v.parse(openClawTasksRealtimeRoutingSchema, {
                            entityType: "openclaw-task",
                            operation: "snapshot-required",
                            topic: openClawTasksRealtimeTopic,
                        });
                        const payload = v.parse(
                            openClawTasksSnapshotRequiredPayloadSchema,
                            { kind: "snapshot-required" }
                        );
                        transaction
                            .insert(realtimeEvents)
                            .values(
                                v.parse(realtimeEventInsertSchema, {
                                    entityId: "current",
                                    entityType: "openclaw-task",
                                    expiresAt: addMilliseconds(
                                        at,
                                        realtimeEventRetentionMilliseconds
                                    ),
                                    occurredAt: at,
                                    operation: "snapshot-required",
                                    payloadJson: JSON.stringify(payload),
                                    topic: openClawTasksRealtimeTopic,
                                })
                            )
                            .run();
                    },
                    { behavior: "immediate" }
                )
            );
            try {
                await wakeEventPump();
            } catch {
                // The durable invalidation is authoritative; the pump's bounded
                // idle poll will observe it even when this immediate wake fails.
            }
        },
    });
}
