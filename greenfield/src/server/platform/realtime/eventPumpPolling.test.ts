import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { createRealtimeEventStore } from "./eventStore.ts";
import { insertEvent, openSharedDatabases } from "./testSupport/eventPump.ts";

describe("realtime event pump", () => {
    test("discovers a second-connection commit through explicit polling", async () => {
        const databases = await openSharedDatabases();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(databases.reader.orm),
        });
        const abortController = new AbortController();

        try {
            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });
            const crossProcessEvent = subscription.next();
            expect(pump.poll()).toBe("active");

            insertEvent(databases.writer, { occurredAtMs: 1000 });
            expect(pump.poll()).toBe("active");
            const deliveredCrossProcessEvent = await crossProcessEvent;
            expect(deliveredCrossProcessEvent.value).toMatchObject({
                id: "1",
                kind: "change",
            });

            abortController.abort();
            const aborted = await subscription.next();
            expect(aborted.done).toBeTrue();
            expect(pump.poll()).toBe("idle");
            expect(pump.metricsSnapshot()).toMatchObject({ polls: 3 });
        } finally {
            pump.close();
            databases.close();
        }
    });

    test("rebases a lagging global poll cursor after subscriber turnover", async () => {
        const database = await openFreshMigratedDatabase();
        const pump = new RealtimeEventPump({
            store: createRealtimeEventStore(database.orm),
        });
        const firstAbortController = new AbortController();
        const firstSubscription = pump.subscribe({
            afterId: "0",
            signal: firstAbortController.signal,
        });

        try {
            const firstDelivery = firstSubscription.next();
            expect(pump.poll()).toBe("active");
            for (let index = 1; index <= 3; index += 1) {
                insertEvent(database, { occurredAtMs: index * 1000 });
            }

            const secondAbortController = new AbortController();
            const secondSubscription = pump.subscribe({
                afterId: "3",
                signal: secondAbortController.signal,
            });
            const secondDelivery = secondSubscription.next();

            firstAbortController.abort();
            const firstDone = await firstDelivery;
            expect(firstDone.done).toBeTrue();
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(3);

            database.sqlite.run("DELETE FROM realtime_events");
            expect(pump.poll()).toBe("active");
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                forcedResyncs: 0,
                latestIssuedId: 3,
            });

            insertEvent(database, { occurredAtMs: 4000 });
            pump.wake();
            expect(pump.poll()).toBe("active");
            expect(await secondDelivery).toMatchObject({
                value: { id: "4", kind: "change" },
            });

            secondAbortController.abort();
            const secondDone = await secondSubscription.next();
            expect(secondDone.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });
});
