import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { applyVerifiedMigrations } from "../../database/migrations/applyVerifiedMigrations.ts";
import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../database/migrations/freshDatabaseFixture.ts";
import { loadVerifiedMigrations } from "../../database/migrations/loadVerifiedMigrations.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    RealtimeCursorError,
    RealtimeEventPump,
    type RealtimeEventPumpScheduler,
    type RealtimeEventPumpTimerHandle,
} from "./eventPump.ts";
import {
    createRealtimeEventStore,
    type RealtimeEventStore,
    type StoredRealtimeEvent,
} from "./eventStore.ts";

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

interface ScheduledTask {
    readonly callback: () => void;
    readonly delayMs: number;
}

class ManualScheduler implements RealtimeEventPumpScheduler {
    readonly #tasks = new Map<number, ScheduledTask>();
    #nextHandle = 1;

    get pendingDelays(): readonly number[] {
        return [...this.#tasks.values()].map((task) => task.delayMs);
    }

    clearTimeout(handle: RealtimeEventPumpTimerHandle): void {
        this.#tasks.delete(handle as number);
    }

    setTimeout(callback: () => void, delayMs: number): number {
        const handle = this.#nextHandle++;
        this.#tasks.set(handle, { callback, delayMs });
        return handle;
    }

    runNext(expectedDelayMs?: number): void {
        const entry = this.#tasks.entries().next().value;
        if (entry === undefined) {
            throw new Error("Expected one scheduled realtime poll");
        }
        const [handle, task] = entry;
        if (expectedDelayMs !== undefined) {
            expect(task.delayMs).toBe(expectedDelayMs);
        }
        this.#tasks.delete(handle);
        task.callback();
    }
}

function insertEvent(
    database: Pick<FreshDatabase, "orm"> | { orm: SQLiteBunDatabase },
    options: {
        occurredAtMs: number;
        payloadJson?: string;
        topic?: string;
    }
): number {
    return database.orm
        .insert(realtimeEvents)
        .values({
            entityId: `entity-${options.occurredAtMs}`,
            entityType: "qualification",
            expiresAt: new Date(options.occurredAtMs + 60_000),
            occurredAt: new Date(options.occurredAtMs),
            operation: "updated",
            payloadJson:
                options.payloadJson ??
                JSON.stringify({ occurredAtMs: options.occurredAtMs }),
            topic: options.topic ?? "topic.a",
        })
        .returning({ id: realtimeEvents.id })
        .get().id;
}

function storedEvent(id: number, topic = "topic.a"): StoredRealtimeEvent {
    return {
        entityId: `entity-${id}`,
        entityType: "qualification",
        expiresAt: new Date(id * 1000 + 60_000),
        id,
        occurredAt: new Date(id * 1000),
        operation: "updated",
        payloadJson: JSON.stringify({ id }),
        topic,
    };
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof Error) {
            return error;
        }
        throw new TypeError("Promise rejected with a non-Error value", {
            cause: error,
        });
    }
    throw new Error("Expected promise to reject");
}

async function openSharedDatabases(): Promise<{
    close(): void;
    reader: { orm: SQLiteBunDatabase; sqlite: Database };
    writer: { orm: SQLiteBunDatabase; sqlite: Database };
}> {
    const directory = mkdtempSync(path.join(tmpdir(), "mira-realtime-pump-"));
    const databasePath = path.join(directory, "shared.sqlite");
    const readerSqlite = new Database(databasePath, { create: true, strict: true });
    readerSqlite.run("PRAGMA foreign_keys = ON");
    const readerOrm = drizzle({ client: readerSqlite });

    try {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        applyVerifiedMigrations(readerSqlite, migrations, {
            appliedAt: new Date("2026-08-04T14:00:00.000Z"),
            releaseId: "0".repeat(40),
        });
        const writerSqlite = new Database(databasePath, { strict: true });
        writerSqlite.run("PRAGMA foreign_keys = ON");
        const writerOrm = drizzle({ client: writerSqlite });
        return {
            close(): void {
                writerSqlite.close(true);
                readerSqlite.close(true);
                rmSync(directory, { force: true, recursive: true });
            },
            reader: { orm: readerOrm, sqlite: readerSqlite },
            writer: { orm: writerOrm, sqlite: writerSqlite },
        };
    } catch (error) {
        readerSqlite.close(true);
        rmSync(directory, { force: true, recursive: true });
        throw error;
    }
}

describe("realtime event pump", () => {
    test("revalidates retention in the same snapshot as every replay batch", async () => {
        const scheduler = new ManualScheduler();
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
        const pump = new RealtimeEventPump({ scheduler, store });
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
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            scheduler,
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
            scheduler.runNext(0);
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

            abortController.abort();
            const aborted = await subscription.next();
            expect(aborted.done).toBeTrue();
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("filters topics and emits one terminal resync control outside retention", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            scheduler,
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
            expect(pump.metricsSnapshot().forcedResyncs).toBe(2);

            const ahead = pump.subscribe({
                afterId: "4",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(ahead.next())).toMatchObject({
                code: "ahead-of-tail",
                name: "RealtimeCursorError",
            } satisfies Partial<RealtimeCursorError>);
            const malformed = pump.subscribe({
                afterId: "01",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(malformed.next())).toMatchObject({
                code: "invalid",
                name: "RealtimeCursorError",
            } satisfies Partial<RealtimeCursorError>);
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("discovers a second-connection commit through the active adaptive poll", async () => {
        const databases = await openSharedDatabases();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            activePollIntervalMs: 250,
            idlePollIntervalMs: 5000,
            scheduler,
            store: createRealtimeEventStore(databases.reader.orm),
        });
        const abortController = new AbortController();

        try {
            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });
            const crossProcessEvent = subscription.next();
            scheduler.runNext(0);
            expect(scheduler.pendingDelays).toEqual([250]);

            insertEvent(databases.writer, { occurredAtMs: 1000 });
            scheduler.runNext(250);
            const deliveredCrossProcessEvent = await crossProcessEvent;
            expect(deliveredCrossProcessEvent.value).toMatchObject({
                id: "1",
                kind: "change",
            });
            expect(scheduler.pendingDelays).toEqual([250]);

            abortController.abort();
            const aborted = await subscription.next();
            expect(aborted.done).toBeTrue();
            scheduler.runNext(250);
            expect(scheduler.pendingDelays).toEqual([5000]);
        } finally {
            pump.close();
            databases.close();
        }
    });

    test("advances retention to a sparse filtered replay match predecessor", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            scheduler,
            store: createRealtimeEventStore(database.orm),
        });
        const abortController = new AbortController();

        try {
            for (let index = 1; index <= 4; index += 1) {
                insertEvent(database, {
                    occurredAtMs: index * 1000,
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
            await Promise.resolve();
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(5);

            abortController.abort();
            const aborted = await liveDelivery;
            expect(aborted.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("rebases a lagging global poll cursor after subscriber turnover", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            scheduler,
            store: createRealtimeEventStore(database.orm),
        });
        const firstAbortController = new AbortController();
        const firstSubscription = pump.subscribe({
            afterId: "0",
            signal: firstAbortController.signal,
        });

        try {
            const firstDelivery = firstSubscription.next();
            scheduler.runNext(0);
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
            scheduler.runNext(0);
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                forcedResyncs: 0,
                latestIssuedId: 3,
            });

            insertEvent(database, { occurredAtMs: 4000 });
            pump.wake();
            scheduler.runNext(0);
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

    test("advances a filtered retention cursor without passing an unacknowledged match", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            scheduler,
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
            scheduler.runNext(0);

            insertEvent(database, { occurredAtMs: 1000, topic: "topic.b" });
            pump.wake();
            scheduler.runNext(0);
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(1);

            insertEvent(database, { occurredAtMs: 2000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 3000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 4000, topic: "topic.b" });
            insertEvent(database, { occurredAtMs: 5000, topic: "topic.a" });
            insertEvent(database, { occurredAtMs: 6000, topic: "topic.b" });
            pump.wake();
            scheduler.runNext(0);
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(4);

            expect(await matchingDelivery).toMatchObject({
                value: { id: "5", kind: "change" },
            });
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(4);

            const nextDelivery = subscription.next();
            await Promise.resolve();
            expect(pump.metricsSnapshot().oldestRequiredCursor).toBe(6);

            abortController.abort();
            const aborted = await nextDelivery;
            expect(aborted.done).toBeTrue();
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("surfaces a live queue failure before yielding more replay", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            maximumSubscriberQueueEvents: 1,
            scheduler,
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
            pump.wake();
            scheduler.runNext(0);

            const failure = await captureRejection(subscription.next());
            expect(failure.message).toBe(
                "Realtime event subscriber exceeded its queue budget"
            );
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                droppedSlowSubscribers: 1,
                maximumObservedQueueDepth: 1,
            });
        } finally {
            pump.close();
            database.sqlite.close(true);
        }
    });

    test("lets abort and close win over a terminal failure after the last replay row", async () => {
        for (const cancellation of ["abort", "close"] as const) {
            const database = await openFreshMigratedDatabase();
            const scheduler = new ManualScheduler();
            const pump = new RealtimeEventPump({
                maximumSubscriberQueueEvents: 1,
                scheduler,
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
                pump.wake();
                scheduler.runNext(0);

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
                const scheduler = new ManualScheduler();
                const pump = new RealtimeEventPump({
                    maximumEventDeliveryBytes: 512,
                    scheduler,
                    store: createRealtimeEventStore(database.orm),
                });
                const abortController = new AbortController();

                try {
                    const subscription = pump.subscribe({
                        afterId: "0",
                        signal: abortController.signal,
                    });
                    const delivery = subscription.next();
                    scheduler.runNext(0);

                    insertEvent(database, {
                        occurredAtMs: 1000,
                        payloadJson: "{}",
                        topic: outcome === "resolved" ? "topic.a" : "x".repeat(1024),
                    });
                    pump.wake();
                    scheduler.runNext(0);

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

    test("samples retained rows once per cadence outside count-free batches", async () => {
        const scheduler = new ManualScheduler();
        let batchReads = 0;
        let boundsReads = 0;
        let nowMs = 1000;
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
            retainedEventCountSampleIntervalMs: 60_000,
            scheduler,
            store,
        });
        const abortController = new AbortController();

        try {
            pump.start();
            scheduler.runNext(0);
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 1000,
            });

            const subscription = pump.subscribe({
                afterId: "0",
                signal: abortController.signal,
            });
            const delivery = subscription.next();
            scheduler.runNext(0);
            expect({ batchReads, boundsReads, windowReads }).toEqual({
                batchReads: 1,
                boundsReads: 1,
                windowReads: 1,
            });

            abortController.abort();
            const aborted = await delivery;
            expect(aborted.done).toBeTrue();

            scheduler.runNext(250);
            expect({ boundsReads, windowReads }).toEqual({
                boundsReads: 2,
                windowReads: 1,
            });

            nowMs = 61_000;
            scheduler.runNext(5000);
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 61_000,
            });
            expect(windowReads).toBe(2);

            nowMs = 0;
            scheduler.runNext(5000);
            expect(pump.metricsSnapshot().retainedEventsSample).toEqual({
                count: 0,
                sampledAtMs: 61_000,
            });
            expect(windowReads).toBe(2);
        } finally {
            pump.close();
        }
    });

    test("drops a slow subscriber at the exact queue budget", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            maximumPageEvents: 4,
            maximumSubscriberQueueEvents: 2,
            scheduler,
            store: createRealtimeEventStore(database.orm),
        });
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });

        try {
            const firstEvent = subscription.next();
            scheduler.runNext(0);
            for (let index = 1; index <= 4; index += 1) {
                insertEvent(database, { occurredAtMs: index * 1000 });
            }
            pump.wake();
            scheduler.runNext(0);

            const deliveredFirstEvent = await firstEvent;
            expect(deliveredFirstEvent.value).toMatchObject({ id: "1" });
            const overflow = await captureRejection(subscription.next());
            expect(overflow.message).toBe(
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

    test("isolates an oversized live delivery from irrelevant topics", async () => {
        const database = await openFreshMigratedDatabase();
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            maximumEventDeliveryBytes: 256,
            scheduler,
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
            scheduler.runNext(0);

            insertEvent(database, {
                occurredAtMs: 1000,
                payloadJson: JSON.stringify({ value: "x".repeat(512) }),
                topic: "topic.b",
            });
            pump.wake();
            scheduler.runNext(0);
            const selectedFailure = await captureRejection(selectedDelivery);
            expect(selectedFailure).toBeInstanceOf(RangeError);
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                deliveryPreparationFailures: 1,
                oldestRequiredCursor: 1,
                pollFailures: 0,
            });

            insertEvent(database, { occurredAtMs: 2000, topic: "topic.a" });
            pump.wake();
            scheduler.runNext(0);
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
        const scheduler = new ManualScheduler();
        const pump = new RealtimeEventPump({
            maximumEventDeliveryBytes: 256,
            scheduler,
            store: createRealtimeEventStore(database.orm),
        });

        try {
            insertEvent(database, {
                occurredAtMs: 1000,
                payloadJson: "{}",
                topic: "x".repeat(512),
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
