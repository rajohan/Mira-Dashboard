import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { createRealtimeEventStore, type RealtimeEventStore } from "./eventStore.ts";
import {
    createGatedSubscriptionStoreRead,
    insertEvent,
    storedEvent,
    waitForCondition,
} from "./testSupport/eventPump.ts";

describe("realtime event pump", () => {
    test("revalidates retention in the same snapshot as every replay batch", async () => {
        let batchReads = 0;
        const store: RealtimeEventStore = {
            readBatch() {
                batchReads += 1;
                return {
                    bounds: {
                        latestIssuedId: 2,
                        newestRetainedId: 2,
                        oldestRetainedId: 2,
                    },
                    events: [storedEvent(2)],
                };
            },
            readCursorBounds() {
                return {
                    latestIssuedId: 2,
                    newestRetainedId: 2,
                    oldestRetainedId: 1,
                };
            },
            readCursorWindow() {
                return {
                    latestIssuedId: 2,
                    newestRetainedId: 2,
                    oldestRetainedId: 1,
                    retainedEvents: 2,
                };
            },
        };
        const pump = new RealtimeEventPump({ store });
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });

        try {
            expect(await subscription.next()).toEqual({
                done: false,
                value: {
                    id: "2",
                    kind: "resync-required",
                    reason: "cursor-outside-retention",
                },
            });
            expect(batchReads).toBe(1);
            const completed = await subscription.next();
            expect(completed.done).toBeTrue();
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                forcedResyncs: 1,
                oldestRetainedId: 2,
            });
        } finally {
            pump.close();
        }
    });

    test("hands replay to live delivery without a race gap", async () => {
        const database = await openFreshMigratedDatabase();
        let pollRequests = 0;
        const pump = new RealtimeEventPump({
            requestPoll: () => {
                pollRequests += 1;
            },
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });

            const firstReplay = await subscription.next();
            expect(firstReplay.value).toMatchObject({
                id: "1",
                kind: "change",
            });
            insertEvent(database, { occurredAtMs: 3000 });
            pump.wake();
            const secondReplay = await subscription.next();
            expect(secondReplay.value).toMatchObject({
                id: "2",
                kind: "change",
            });

            const liveEvent = subscription.next();
            expect(pump.poll()).toBe("active");
            const deliveredLiveEvent = await liveEvent;
            expect(deliveredLiveEvent.value).toMatchObject({
                id: "3",
                kind: "change",
            });
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                latestIssuedId: 3,
                maximumCatchUpBatchSize: 2,
                wakeups: 1,
            });
            expect(pollRequests).toBe(2);

            abortController.abort();
            const aborted = await subscription.next();
            expect(aborted.done).toBeTrue();
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("does not regress observed bounds when an older replay read resumes", async () => {
        const database = await openFreshMigratedDatabase();
        const gatedRead = createGatedSubscriptionStoreRead(2);
        const pump = new RealtimeEventPump({
            readSubscriptionStore: gatedRead.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });
            const firstReplay = subscription.next();
            await gatedRead.started;

            insertEvent(database, { occurredAtMs: 3000 });
            expect(pump.poll()).toBe("active");
            expect(pump.metricsSnapshot().latestIssuedId).toBe(3);

            gatedRead.release();
            expect(await firstReplay).toMatchObject({
                done: false,
                value: { id: "1", kind: "change" },
            });
            expect(pump.metricsSnapshot().latestIssuedId).toBe(3);

            abortController.abort();
            const completed = await subscription.next();
            expect(completed.done).toBeTrue();
        } finally {
            gatedRead.release();
            abortController.abort();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("merges an async opening boundary with live polls completed before attach", async () => {
        const database = await openFreshMigratedDatabase();
        const store = createRealtimeEventStore(database.orm);
        const secondBounds = createGatedSubscriptionStoreRead(2);
        const pump = new RealtimeEventPump({
            readSubscriptionStore: secondBounds.readSubscriptionStore,
            store,
        });
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            const first = pump.subscribe({
                afterId: "1",
                signal: firstAbort.signal,
            });
            const firstLive = first.next();
            await waitForCondition(
                () => pump.metricsSnapshot().activeSubscribers === 1,
                "first subscriber to attach before the opening race"
            );

            const second = pump.subscribe({
                afterId: "1",
                signal: secondAbort.signal,
            });
            const secondReplay = second.next();
            await secondBounds.started;

            insertEvent(database, { occurredAtMs: 2000 });
            expect(pump.poll()).toBe("active");
            expect(await firstLive).toMatchObject({
                done: false,
                value: { id: "2", kind: "change" },
            });

            secondBounds.release();
            expect(await secondReplay).toMatchObject({
                done: false,
                value: { id: "2", kind: "change" },
            });

            firstAbort.abort();
            secondAbort.abort();
            const firstCompleted = await first.next();
            const secondCompleted = await second.next();
            expect(firstCompleted.done).toBeTrue();
            expect(secondCompleted.done).toBeTrue();
        } finally {
            secondBounds.release();
            firstAbort.abort();
            secondAbort.abort();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("uses the merged attach-time tail for a stale opening resync", async () => {
        const database = await openFreshMigratedDatabase();
        const secondBounds = createGatedSubscriptionStoreRead(2);
        const pump = new RealtimeEventPump({
            readSubscriptionStore: secondBounds.readSubscriptionStore,
            store: createRealtimeEventStore(database.orm),
        });
        const firstAbort = new AbortController();

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            database.sqlite.run("DELETE FROM realtime_events WHERE id = 1");

            const first = pump.subscribe({
                afterId: "2",
                signal: firstAbort.signal,
            });
            const firstLive = first.next();
            await waitForCondition(
                () => pump.metricsSnapshot().activeSubscribers === 1,
                "first subscriber to attach before the stale resync race"
            );

            const second = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            const secondResync = second.next();
            await secondBounds.started;

            insertEvent(database, { occurredAtMs: 3000 });
            expect(pump.poll()).toBe("active");
            expect(await firstLive).toMatchObject({
                done: false,
                value: { id: "3", kind: "change" },
            });

            secondBounds.release();
            expect(await secondResync).toMatchObject({
                done: false,
                value: { id: "3", kind: "resync-required" },
            });
            const secondCompleted = await second.next();
            expect(secondCompleted.done).toBeTrue();

            firstAbort.abort();
            const firstCompleted = await first.next();
            expect(firstCompleted.done).toBeTrue();
        } finally {
            secondBounds.release();
            firstAbort.abort();
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("filters replay deliveries by topic", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();

        try {
            insertEvent(database, { occurredAtMs: 1000, topic: "topic.a" });
            insertEvent(database, { occurredAtMs: 2000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 3000, topic: "topic.a" });
            const filtered = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
                topics: ["topic.a"],
            });
            const firstFiltered = await filtered.next();
            const secondFiltered = await filtered.next();
            expect(firstFiltered.value).toMatchObject({ id: "1" });
            expect(secondFiltered.value).toMatchObject({ id: "3" });
            abortController.abort();
            const filteredDone = await filtered.next();
            expect(filteredDone.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("emits one terminal resync control for a partially pruned cursor", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            insertEvent(database, { occurredAtMs: 3000 });
            database.sqlite.run("DELETE FROM realtime_events WHERE id <= 2");
            const resync = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await resync.next()).toEqual({
                done: false,
                value: {
                    id: "3",
                    kind: "resync-required",
                    reason: "cursor-outside-retention",
                },
            });
            const resyncDone = await resync.next();
            expect(resyncDone.done).toBeTrue();
            expect(pump.metricsSnapshot().forcedResyncs).toBe(1);
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("emits one terminal resync control for a fully pruned cursor", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, { occurredAtMs: 1000 });
            insertEvent(database, { occurredAtMs: 2000 });
            insertEvent(database, { occurredAtMs: 3000 });
            database.sqlite.run("DELETE FROM realtime_events");
            const fullyPruned = pump.subscribe({
                afterId: "2",
                signal: new AbortController().signal,
            });
            const fullyPrunedControl = await fullyPruned.next();
            expect(fullyPrunedControl.value).toEqual({
                id: "3",
                kind: "resync-required",
                reason: "cursor-outside-retention",
            });
            const fullyPrunedDone = await fullyPruned.next();
            expect(fullyPrunedDone.done).toBeTrue();
            expect(pump.metricsSnapshot().forcedResyncs).toBe(1);
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });
});
