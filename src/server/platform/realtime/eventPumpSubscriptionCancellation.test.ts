import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { BoundedAsyncQueueOverflowError } from "./boundedAsyncQueue.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { createRealtimeEventStore, type RealtimeEventStore } from "./eventStore.ts";
import {
    captureRejection,
    createGatedSubscriptionStoreRead,
    insertEvent,
    storedEvent,
} from "./testSupport/eventPump.ts";

const staleReplayStore: RealtimeEventStore = {
    readBatch: () => ({
        bounds: {
            latestIssuedId: 1,
            newestRetainedId: 1,
            oldestRetainedId: 1,
        },
        events: [storedEvent(1)],
    }),
    readCursorBounds: () => ({
        latestIssuedId: 2,
        newestRetainedId: 2,
        oldestRetainedId: 1,
    }),
    readCursorWindow: () => ({
        latestIssuedId: 2,
        newestRetainedId: 2,
        oldestRetainedId: 1,
        retainedEvents: 2,
    }),
};

describe("realtime event pump subscription cancellation", () => {
    test("interrupts an in-flight replay read when all subscribers fail", async () => {
        const database = await openFreshMigratedDatabase();
        const gatedRead = createGatedSubscriptionStoreRead(3);
        const pump = new RealtimeEventPump({
            maximumPageEvents: 1,
            maximumSubscriberQueueEvents: 1,
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await subscription.next()).toMatchObject({
                value: { id: "1", kind: "change" },
            });

            const pendingReplay = subscription.next();
            await gatedRead.started;
            const runnerFailure = new Error("Realtime event runner failed");
            pump.failSubscribers(runnerFailure);

            expect(await captureRejection(pendingReplay)).toBe(runnerFailure);
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            gatedRead.release();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("interrupts an in-flight replay read when the pump closes", async () => {
        const database = await openFreshMigratedDatabase();
        const gatedRead = createGatedSubscriptionStoreRead(3);
        const pump = new RealtimeEventPump({
            maximumPageEvents: 1,
            maximumSubscriberQueueEvents: 1,
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await subscription.next()).toMatchObject({
                value: { id: "1", kind: "change" },
            });

            const pendingReplay = subscription.next();
            await gatedRead.started;
            pump.close();

            expect(await pendingReplay).toEqual({ done: true, value: undefined });
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            gatedRead.release();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("prefers close after an in-flight replay read succeeds", async () => {
        const gatedRead = createGatedSubscriptionStoreRead(2);
        const pump = new RealtimeEventPump({
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: staleReplayStore,
        });

        try {
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            const pendingReplay = subscription.next();
            await gatedRead.started;

            gatedRead.release();
            queueMicrotask(() => pump.close());

            expect(await pendingReplay).toEqual({ done: true, value: undefined });
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            gatedRead.release();
            pump.close();
        }
    });

    test("prefers subscriber failure after an in-flight replay read succeeds", async () => {
        const gatedRead = createGatedSubscriptionStoreRead(2);
        const pump = new RealtimeEventPump({
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: staleReplayStore,
        });

        try {
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            const pendingReplay = subscription.next();
            await gatedRead.started;
            const runnerFailure = new Error("Realtime event runner failed");

            gatedRead.release();
            queueMicrotask(() => pump.failSubscribers(runnerFailure));

            expect(await captureRejection(pendingReplay)).toBe(runnerFailure);
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            gatedRead.release();
            pump.close();
        }
    });

    test("interrupts an in-flight replay read with a retention resync", async () => {
        const database = await openFreshMigratedDatabase();
        const gatedRead = createGatedSubscriptionStoreRead(3);
        const pump = new RealtimeEventPump({
            maximumPageEvents: 1,
            maximumSubscriberQueueEvents: 1,
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await subscription.next()).toMatchObject({
                value: { id: "1", kind: "change" },
            });

            const pendingReplay = subscription.next();
            await gatedRead.started;
            insertEvent(database, { occurredAtMs: 3000 });
            database.sqlite.run("DELETE FROM realtime_events");
            expect(pump.poll()).toBe("idle");

            expect(await pendingReplay).toEqual({
                done: false,
                value: {
                    id: "3",
                    kind: "resync-required",
                    reason: "cursor-outside-retention",
                },
            });
            const completed = await subscription.next();
            expect(completed.done).toBeTrue();
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                forcedResyncs: 1,
            });
        } finally {
            gatedRead.release();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("interrupts an in-flight replay read on live queue overflow", async () => {
        const database = await openFreshMigratedDatabase();
        const gatedRead = createGatedSubscriptionStoreRead(3);
        const pump = new RealtimeEventPump({
            maximumPageEvents: 1,
            maximumSubscriberQueueEvents: 1,
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await subscription.next()).toMatchObject({
                value: { id: "1", kind: "change" },
            });

            const pendingReplay = subscription.next();
            await gatedRead.started;
            insertEvent(database, { occurredAtMs: 3000 });
            insertEvent(database, { occurredAtMs: 4000 });
            expect(pump.poll()).toBe("immediate");
            expect(pump.poll()).toBe("idle");

            const overflow = await captureRejection(pendingReplay);
            expect(overflow).toBeInstanceOf(BoundedAsyncQueueOverflowError);
            expect(overflow.message).toBe(
                "Realtime event subscriber exceeded its queue budget"
            );
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                droppedSlowSubscribers: 1,
                maximumObservedQueueDepth: 1,
            });
        } finally {
            gatedRead.release();
            pump.close();
            database.sqlite.close(true);
        }
    });
});
