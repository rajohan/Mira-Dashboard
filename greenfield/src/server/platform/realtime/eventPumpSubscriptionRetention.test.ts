import { describe, expect, test } from "bun:test";

import { minutesToMilliseconds, secondsToMilliseconds } from "date-fns";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { createRealtimeEventStore, type RealtimeEventStore } from "./eventStore.ts";
import { insertEvent, waitForCondition } from "./testSupport/eventPump.ts";

describe("realtime event pump", () => {
    test("advances retention to a sparse filtered replay match predecessor", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();

        try {
            for (let index = 1; index <= 4; index += 1) {
                insertEvent(database, {
                    occurredAtMs: secondsToMilliseconds(index),
                    topic: "topic.b",
                });
            }
            insertEvent(database, { occurredAtMs: 5000, topic: "topic.a" });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
                topics: ["topic.a"],
            });

            expect(await subscription.next()).toMatchObject({
                value: { id: "5", kind: "change" },
            });
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(4);

            const liveDelivery = subscription.next();
            await waitForCondition(
                () => pump.metricsSnapshot().oldestRequiredCursor === 5,
                "the sparse filtered replay cursor to advance"
            );
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(5);

            abortController.abort();
            const aborted = await liveDelivery;
            expect(aborted.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("advances a filtered retention cursor without passing an unacknowledged match", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();
        const subscription = pump.subscribe({
            afterId: "0",
            signal: abortController.signal,
            topics: ["topic.a"],
        });

        try {
            const matchingDelivery = subscription.next();
            expect(pump.poll()).toBe("active");

            insertEvent(database, { occurredAtMs: 1000, topic: "topic.b" });
            pump.wake();
            expect(pump.poll()).toBe("active");
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(1);

            insertEvent(database, { occurredAtMs: 2000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 3000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 4000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 5000, topic: "topic.a" });
            insertEvent(database, { occurredAtMs: 6000, topic: "topic.b" });
            pump.wake();
            expect(pump.poll()).toBe("active");
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(4);
            expect(pump.metricsSnapshot().topicFilteredDeliveries).toBe(5);

            expect(await matchingDelivery).toMatchObject({
                value: { id: "5", kind: "change" },
            });
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(4);

            const nextDelivery = subscription.next();
            await waitForCondition(
                () => pump.metricsSnapshot().oldestRequiredCursor === 6,
                "the filtered live cursor to advance"
            );
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(6);

            abortController.abort();
            const aborted = await nextDelivery;
            expect(aborted.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("samples retained rows once per cadence outside count-free batches", async () => {
        let batchReads = 0;
        let boundsReads = 0;
        let nowMs = secondsToMilliseconds(1);
        let windowReads = 0;
        const store: RealtimeEventStore = {
            readBatch() {
                batchReads += 1;
                return {
                    bounds: {
                        latestIssuedId: 0,
                        newestRetainedId: null,
                        oldestRetainedId: null,
                    },
                    events: [],
                };
            },
            readCursorBounds() {
                boundsReads += 1;
                return {
                    latestIssuedId: 0,
                    newestRetainedId: null,
                    oldestRetainedId: null,
                };
            },
            readCursorWindow() {
                windowReads += 1;
                return {
                    latestIssuedId: 0,
                    newestRetainedId: null,
                    oldestRetainedId: null,
                    retainedEvents: 0,
                };
            },
        };
        const pump = new RealtimeEventPump({
            nowMs: () => nowMs,
            retainedEventCountSampleIntervalMs: minutesToMilliseconds(1),
            store,
        });
        const abortController = new AbortController();

        try {
            expect(pump.poll()).toBe("idle");
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 1000,
            });

            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });
            const delivery = subscription.next();
            expect(pump.poll()).toBe("active");
            expect({ batchReads, boundsReads, windowReads }).toEqual({
                batchReads: 1,
                boundsReads: 1,
                windowReads: 1,
            });

            abortController.abort();
            const aborted = await delivery;
            expect(aborted.done).toBeTrue();

            expect(pump.poll()).toBe("idle");
            expect({ boundsReads, windowReads }).toEqual({
                boundsReads: 2,
                windowReads: 1,
            });

            nowMs = secondsToMilliseconds(61);
            expect(pump.poll()).toBe("idle");
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 61_000,
            });
            expect(windowReads).toBe(2);

            nowMs = 0;
            expect(pump.poll()).toBe("idle");
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 61_000,
            });
            expect(windowReads).toBe(2);
        } finally {
            pump.close();
        }
    });
});
