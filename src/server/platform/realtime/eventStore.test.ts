import { describe, expect, test } from "bun:test";

import { lte } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createRealtimeEventStore, realtimeEventStoreLimits } from "./eventStore.ts";
import { insertEvent, openSharedDatabases } from "./testSupport/eventPump.ts";

describe("realtime event store", () => {
    test("reads cursor bounds and filtered pages without exceeding the page limit", async () => {
        const database = await openFreshMigratedDatabase();
        const store = createRealtimeEventStore(database.orm);

        try {
            expect(store.readCursorWindow()).toEqual({
                latestIssuedId: 0,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 0,
            });

            const firstId = insertEvent(database, { occurredAtMs: 1000 });
            const secondId = insertEvent(database, {
                occurredAtMs: 2000,
                topic: "topic.b",
            });
            const thirdId = insertEvent(database, { occurredAtMs: 3000 });
            expect([firstId, secondId, thirdId]).toEqual([1, 2, 3]);
            expect(store.readCursorWindow()).toEqual({
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: 1,
                retainedEvents: 3,
            });

            const firstBatch = store.readBatch({
                afterId: 0,
                limit: 1,
                throughId: 3,
                topics: ["topic.a"],
            });
            const secondBatch = store.readBatch({
                afterId: firstBatch.events[0]!.id,
                limit: 1,
                throughId: 3,
                topics: ["topic.a"],
            });
            expect(firstBatch).toMatchObject({
                bounds: {
                    latestIssuedId: 3,
                    newestRetainedId: 3,
                    oldestRetainedId: 1,
                },
            });
            expect(firstBatch.events.map((event) => event.id)).toEqual([1]);
            expect(secondBatch.events.map((event) => event.id)).toEqual([3]);
            expect(
                store.readBatch({
                    afterId: 3,
                    limit: realtimeEventStoreLimits.maximumPageEvents,
                    topics: Array.from(
                        { length: realtimeEventStoreLimits.maximumTopicsPerPage },
                        (_, index) => `topic.${index}`
                    ),
                }).events
            ).toEqual([]);

            database.orm.delete(realtimeEvents).where(lte(realtimeEvents.id, 2)).run();
            expect(store.readCursorWindow()).toEqual({
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: 3,
                retainedEvents: 1,
            });

            database.orm.delete(realtimeEvents).run();
            expect(store.readCursorWindow()).toEqual({
                latestIssuedId: 3,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 0,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps cursor bounds and page rows on one SQLite read snapshot", async () => {
        const databases = await openSharedDatabases();
        const runReadTransaction = databases.reader.orm.transaction.bind(
            databases.reader.orm
        ) as unknown as <T>(
            callback: (transaction: SQLiteBunDatabase) => T,
            config: { behavior: "deferred" }
        ) => T;
        let interleavingDeletes = 0;
        const instrumentedDatabase = {
            transaction<T>(
                callback: (transaction: SQLiteBunDatabase) => T,
                config: { behavior: "deferred" }
            ): T {
                return runReadTransaction((transaction) => {
                    const instrumentedTransaction = new Proxy(transaction, {
                        get(target, property): unknown {
                            if (property === "all") {
                                const queryAll = target.all.bind(target) as (
                                    ...parameters: unknown[]
                                ) => unknown;
                                return (...parameters: unknown[]) => {
                                    const result = queryAll(...parameters);
                                    if (interleavingDeletes === 0) {
                                        databases.writer.orm
                                            .delete(realtimeEvents)
                                            .where(lte(realtimeEvents.id, 1))
                                            .run();
                                        interleavingDeletes += 1;
                                    }
                                    return result;
                                };
                            }
                            const member = Reflect.get(
                                target,
                                property,
                                target
                            ) as unknown;
                            return typeof member === "function"
                                ? (member.bind(target) as unknown)
                                : member;
                        },
                    });
                    return callback(instrumentedTransaction);
                }, config);
            },
        } as unknown as SQLiteBunDatabase;

        try {
            insertEvent(databases.writer, { occurredAtMs: 1000 });
            insertEvent(databases.writer, { occurredAtMs: 2000 });
            insertEvent(databases.writer, { occurredAtMs: 3000 });
            const store = createRealtimeEventStore(instrumentedDatabase);

            const batch = store.readBatch({ afterId: 0, limit: 1 });
            expect(interleavingDeletes).toBe(1);
            expect(batch.bounds).toEqual({
                latestIssuedId: 3,
                newestRetainedId: 3,
                oldestRetainedId: 1,
            });
            expect(batch.events.map((event) => event.id)).toEqual([1]);
            expect(
                databases.writer.orm
                    .select({ id: realtimeEvents.id })
                    .from(realtimeEvents)
                    .all()
                    .map((row) => row.id)
            ).toEqual([2, 3]);
        } finally {
            databases.close();
        }
    });

    test("validates immutable rows read from SQLite", async () => {
        const database = await openFreshMigratedDatabase();
        const store = createRealtimeEventStore(database.orm);

        try {
            database.sqlite.run("PRAGMA ignore_check_constraints = ON");
            database.sqlite.run(`
                INSERT INTO realtime_events (
                    entity_id,
                    entity_type,
                    expires_at,
                    occurred_at,
                    operation,
                    payload_json,
                    topic
                ) VALUES ('entity-1', 'test-entity', 2000, 1000, 'updated', 'not-json', 'topic.a')
            `);
            database.sqlite.run("PRAGMA ignore_check_constraints = OFF");

            expect(() => store.readBatch({ afterId: 0, limit: 16 })).toThrow(
                "Expected valid JSON text"
            );
            expect(() => store.readBatch({ afterId: 0, limit: 16, topics: [] })).toThrow(
                "Realtime page topics cannot be empty"
            );

            let transactionCalls = 0;
            const validationOnlyStore = createRealtimeEventStore({
                transaction(): never {
                    transactionCalls += 1;
                    throw new Error("Invalid options reached SQLite");
                },
            } as unknown as SQLiteBunDatabase);

            const invalidOptions: readonly {
                expectedMessage: string;
                options: Parameters<typeof validationOnlyStore.readBatch>[0];
            }[] = [
                {
                    expectedMessage:
                        "Realtime page cursor must be a nonnegative safe integer",
                    options: { afterId: -1, limit: 1 },
                },
                {
                    expectedMessage:
                        "Realtime page cursor must be a nonnegative safe integer",
                    options: { afterId: 1.5, limit: 1 },
                },
                {
                    expectedMessage:
                        "Realtime page boundary must be a nonnegative safe integer",
                    options: { afterId: 0, limit: 1, throughId: -1 },
                },
                {
                    expectedMessage: "Realtime page boundary cannot precede its cursor",
                    options: { afterId: 2, limit: 1, throughId: 1 },
                },
                {
                    expectedMessage:
                        "Realtime page limit must be a positive safe integer",
                    options: { afterId: 0, limit: 0 },
                },
                {
                    expectedMessage: "Realtime page limit exceeds its store budget",
                    options: {
                        afterId: 0,
                        limit: realtimeEventStoreLimits.maximumPageEvents + 1,
                    },
                },
                {
                    expectedMessage: "Realtime page topic count exceeds its store budget",
                    options: {
                        afterId: 0,
                        limit: 1,
                        topics: Array.from(
                            {
                                length: realtimeEventStoreLimits.maximumTopicsPerPage + 1,
                            },
                            (_, index) => `topic.${index}`
                        ),
                    },
                },
                {
                    expectedMessage: "Realtime topic is invalid",
                    options: { afterId: 0, limit: 1, topics: [" topic.a"] },
                },
                {
                    expectedMessage: "Realtime topic is invalid",
                    options: {
                        afterId: 0,
                        limit: 1,
                        topics: [
                            "t".repeat(
                                realtimeEventStoreLimits.maximumTopicCharacters + 1
                            ),
                        ],
                    },
                },
            ];
            for (const { expectedMessage, options } of invalidOptions) {
                expect(() => validationOnlyStore.readBatch(options)).toThrow(RangeError);
                expect(() => validationOnlyStore.readBatch(options)).toThrow(
                    expectedMessage
                );
            }
            expect(transactionCalls).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });
});
