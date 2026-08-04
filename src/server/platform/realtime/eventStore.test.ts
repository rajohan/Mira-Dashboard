import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { lte } from "drizzle-orm";
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { applyVerifiedMigrations } from "../../database/migrations/applyVerifiedMigrations.ts";
import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../database/migrations/freshDatabaseFixture.ts";
import { loadVerifiedMigrations } from "../../database/migrations/loadVerifiedMigrations.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { createRealtimeEventStore } from "./eventStore.ts";

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

function insertEvent(
    database: Pick<FreshDatabase, "orm"> | { orm: SQLiteBunDatabase },
    topic: string,
    occurredAtMs: number
): number {
    return database.orm
        .insert(realtimeEvents)
        .values({
            entityId: `entity-${occurredAtMs}`,
            entityType: "qualification",
            expiresAt: new Date(occurredAtMs + 60_000),
            occurredAt: new Date(occurredAtMs),
            operation: "updated",
            payloadJson: JSON.stringify({ occurredAtMs }),
            topic,
        })
        .returning({ id: realtimeEvents.id })
        .get().id;
}

async function openSharedDatabases(): Promise<{
    close(): void;
    reader: { orm: SQLiteBunDatabase; sqlite: Database };
    writer: { orm: SQLiteBunDatabase; sqlite: Database };
}> {
    const directory = mkdtempSync(path.join(tmpdir(), "mira-realtime-store-"));
    const databasePath = path.join(directory, "shared.sqlite");
    const readerSqlite = new Database(databasePath, { create: true, strict: true });
    readerSqlite.run("PRAGMA foreign_keys = ON");
    const readerOrm = drizzle({ client: readerSqlite });

    try {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        applyVerifiedMigrations(readerSqlite, migrations, {
            appliedAt: new Date("2026-08-04T15:00:00.000Z"),
            releaseId: "0".repeat(40),
        });
        readerSqlite.run("PRAGMA journal_mode = WAL");
        const writerSqlite = new Database(databasePath, { strict: true });
        writerSqlite.run("PRAGMA foreign_keys = ON");
        writerSqlite.run("PRAGMA journal_mode = WAL");
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

            const firstId = insertEvent(database, "topic.a", 1000);
            const secondId = insertEvent(database, "topic.b", 2000);
            const thirdId = insertEvent(database, "topic.a", 3000);
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
            insertEvent(databases.reader, "topic.a", 1000);
            insertEvent(databases.reader, "topic.a", 2000);
            insertEvent(databases.reader, "topic.a", 3000);
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
                ) VALUES ('entity-1', 'qualification', 2000, 1000, 'updated', 'not-json', 'topic.a')
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
            expect(() => validationOnlyStore.readBatch({ afterId: 0, limit: 0 })).toThrow(
                "Realtime page limit must be a positive safe integer"
            );
            expect(transactionCalls).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });
});
