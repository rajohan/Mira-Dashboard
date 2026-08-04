import { describe, expect, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { createRealtimeEventStore } from "./eventStore.ts";
import { captureRejection, insertEvent } from "./testSupport/eventPump.ts";

describe("realtime event pump", () => {
    test("surfaces a live queue failure before yielding more replay", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            maximumPageEvents: 2,
            maximumSubscriberQueueEvents: 2,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            insertEvent(database, { occurredAtMs: 3000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await subscription.next()).toMatchObject({
                value: { id: "1", kind: "change" },
            });

            insertEvent(database, { occurredAtMs: 4000 });
            insertEvent(database, { occurredAtMs: 5000 });
            insertEvent(database, { occurredAtMs: 6000 });
            pump.wake();
            expect(pump.poll()).toBe("immediate");
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                droppedSlowSubscribers: 0,
                maximumObservedQueueDepth: 2,
            });
            expect(pump.poll()).toBe("idle");

            const failure = await captureRejection(subscription.next());
            expect(failure.message).toBe(
                "Realtime event subscriber exceeded its queue budget"
            );
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                droppedSlowSubscribers: 1,
                maximumObservedQueueDepth: 2,
            });
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("lets abort and close win over a terminal failure after the last replay row", async () => {
        for (const cancellation of ["abort", "close"] as const) {
            const database = await openFreshMigratedDatabase();
            const pump = new RealtimeEventPump({
                maximumPageEvents: 2,
                maximumSubscriberQueueEvents: 2,
                store: createRealtimeEventStore(database.orm),
            });
            const abortController = new AbortController();

            try {
                insertEvent(database, { occurredAtMs: 1000 });
                const subscription = pump.subscribe({
                    afterId: "0",
                    signal: abortController.signal,
                });
                expect(await subscription.next()).toMatchObject({
                    value: { id: "1", kind: "change" },
                });

                insertEvent(database, { occurredAtMs: 2000 });
                insertEvent(database, { occurredAtMs: 3000 });
                insertEvent(database, { occurredAtMs: 4000 });
                pump.wake();
                expect(pump.poll()).toBe("immediate");
                expect(pump.poll()).toBe("idle");

                if (cancellation === "abort") {
                    abortController.abort();
                } else {
                    pump.close();
                }
                const cancelled = await subscription.next();
                expect(cancelled.done).toBeTrue();
            } finally {
                pump.close();
                database.sqlite.close(true);
            }
        }
    });

    test("lets abort and close win over resolved and rejected live queue reads", async () => {
        for (const outcome of ["resolved", "rejected"] as const) {
            for (const cancellation of ["abort", "close"] as const) {
                const database = await openFreshMigratedDatabase();
                const pump = new RealtimeEventPump({
                    maximumEventDeliveryBytes: 512,
                    store: createRealtimeEventStore(database.orm),
                });
                const abortController = new AbortController();

                try {
                    const subscription = pump.subscribe({
                        afterId: "0",
                        signal: abortController.signal,
                    });
                    const delivery = subscription.next();
                    expect(pump.poll()).toBe("active");

                    insertEvent(database, {
                        occurredAtMs: 1000,
                        payloadJson:
                            outcome === "resolved"
                                ? "{}"
                                : JSON.stringify({ value: "x".repeat(1024) }),
                        topic: "topic.a",
                    });
                    pump.wake();
                    expect(pump.poll()).toBe(outcome === "resolved" ? "active" : "idle");

                    if (cancellation === "abort") {
                        abortController.abort();
                    } else {
                        pump.close();
                    }
                    const cancelled = await delivery;
                    expect(cancelled.done).toBeTrue();
                } finally {
                    pump.close();
                    database.sqlite.close(true);
                }
            }
        }
    });

    test("drops a slow subscriber at the exact queue budget", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            maximumPageEvents: 3,
            maximumSubscriberQueueEvents: 3,
            store: createRealtimeEventStore(database.orm),
        });
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });

        try {
            const firstEvent = subscription.next();
            expect(pump.poll()).toBe("active");
            for (let index = 1; index <= 5; index += 1) {
                insertEvent(database, {
                    occurredAtMs: secondsToMilliseconds(index),
                });
            }
            pump.wake();
            expect(pump.poll()).toBe("immediate");
            expect(pump.poll()).toBe("idle");

            const deliveredFirstEvent = await firstEvent;
            expect(deliveredFirstEvent.value).toMatchObject({ id: "1" });
            const overflow = await captureRejection(subscription.next());
            expect(overflow.message).toBe(
                "Realtime event subscriber exceeded its queue budget"
            );
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                droppedSlowSubscribers: 1,
                maximumObservedQueueDepth: 3,
            });
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("isolates an oversized live delivery from irrelevant topics", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            maximumEventDeliveryBytes: 256,
            store: createRealtimeEventStore(database.orm),
        });
        const irrelevantAbortController = new AbortController();
        const irrelevantSubscription = pump.subscribe({
            afterId: "0",
            signal: irrelevantAbortController.signal,
            topics: ["topic.a"],
        });
        const selectedSubscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
            topics: ["topic.b"],
        });

        try {
            const irrelevantDelivery = irrelevantSubscription.next();
            const selectedDelivery = selectedSubscription.next();
            expect(pump.poll()).toBe("active");

            insertEvent(database, {
                occurredAtMs: 1000,
                payloadJson: JSON.stringify({ value: "x".repeat(512) }),
                topic: "topic.b",
            });
            pump.wake();
            expect(pump.poll()).toBe("active");
            const selectedFailure = await captureRejection(selectedDelivery);
            expect(selectedFailure).toBeInstanceOf(RangeError);
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                deliveryPreparationFailures: 1,
                oldestRequiredCursor: 1,
                pollFailures: 0,
                topicFilteredDeliveries: 1,
            });

            insertEvent(database, { occurredAtMs: 2000, topic: "topic.a" });
            pump.wake();
            expect(pump.poll()).toBe("active");
            expect(await irrelevantDelivery).toMatchObject({
                value: { id: "2", kind: "change" },
            });

            irrelevantAbortController.abort();
            const aborted = await irrelevantSubscription.next();
            expect(aborted.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("bounds the full serialized delivery and cleans up the subscriber", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            maximumEventDeliveryBytes: 256,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, {
                occurredAtMs: 1000,
                payloadJson: JSON.stringify({ value: "x".repeat(128) }),
                topic: "x".repeat(128),
            });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            const oversized = await captureRejection(subscription.next());
            expect(oversized).toBeInstanceOf(RangeError);
            expect(oversized.message).toBe(
                "Realtime event delivery exceeds 256 UTF-8 bytes"
            );
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                deliveryPreparationFailures: 1,
                pollFailures: 0,
            });
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });
});
