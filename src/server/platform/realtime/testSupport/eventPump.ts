import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addMinutes, parseISO, secondsToMilliseconds, toDate } from "date-fns";
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { applyVerifiedMigrations } from "../../../database/migrations/applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "../../../database/migrations/loadVerifiedMigrations.ts";
import { realtimeEvents } from "../../../database/schema/realtime.ts";
import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../../test/support/freshDatabase.ts";
import type { RealtimeEventStore, StoredRealtimeEvent } from "../eventStore.ts";

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

export function insertEvent(
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
            expiresAt: addMinutes(options.occurredAtMs, 1),
            occurredAt: toDate(options.occurredAtMs),
            operation: "updated",
            payloadJson:
                options.payloadJson ??
                JSON.stringify({ occurredAtMs: options.occurredAtMs }),
            topic: options.topic ?? "topic.a",
        })
        .returning({ id: realtimeEvents.id })
        .get().id;
}

export function storedEvent(id: number, topic = "topic.a"): StoredRealtimeEvent {
    const occurredAtMs = secondsToMilliseconds(id);
    return {
        entityId: `entity-${id}`,
        entityType: "qualification",
        expiresAt: addMinutes(occurredAtMs, 1),
        id,
        occurredAt: toDate(occurredAtMs),
        operation: "updated",
        payloadJson: JSON.stringify({ id }),
        topic,
    };
}

export async function captureRejection(promise: Promise<unknown>): Promise<Error> {
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

export async function waitForCondition(
    condition: () => boolean,
    description: string
): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
        if (condition()) {
            return;
        }
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    if (condition()) {
        return;
    }
    throw new Error(`Timed out waiting for ${description}`);
}

export function createGatedSubscriptionStoreRead(gatedReadNumber: number): {
    readonly readSubscriptionStore: <A>(read: () => A, signal: AbortSignal) => Promise<A>;
    readonly started: Promise<void>;
    release(): void;
} {
    let readCount = 0;
    let releaseGate: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
    });

    return {
        async readSubscriptionStore<A>(read: () => A, signal: AbortSignal): Promise<A> {
            const result = read();
            readCount += 1;
            if (readCount === gatedReadNumber) {
                signalStarted?.();
                await new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const finish = (complete: () => void): void => {
                        if (settled) return;
                        settled = true;
                        signal.removeEventListener("abort", abort);
                        complete();
                    };
                    const abort = (): void => {
                        const reason =
                            signal.reason instanceof Error
                                ? signal.reason
                                : new Error("Gated subscription store read aborted", {
                                      cause: signal.reason,
                                  });
                        finish(() => reject(reason));
                    };
                    if (signal.aborted) {
                        abort();
                        return;
                    }
                    signal.addEventListener("abort", abort, { once: true });
                    void gate.then(() => {
                        finish(resolve);
                        return true;
                    });
                });
            }
            return result;
        },
        release(): void {
            releaseGate?.();
        },
        started,
    };
}

export const dataFreeStore: RealtimeEventStore = Object.freeze({
    readBatch(): never {
        throw new Error("Expected validation before reading a realtime batch");
    },
    readCursorBounds(): never {
        throw new Error("Expected validation before reading realtime cursor bounds");
    },
    readCursorWindow(): never {
        throw new Error("Expected validation before reading the realtime cursor window");
    },
});

export const emptyRealtimeEventStore: RealtimeEventStore = Object.freeze({
    readBatch: () => ({
        bounds: {
            latestIssuedId: 0,
            newestRetainedId: null,
            oldestRetainedId: null,
        },
        events: [],
    }),
    readCursorBounds: () => ({
        latestIssuedId: 0,
        newestRetainedId: null,
        oldestRetainedId: null,
    }),
    readCursorWindow: () => ({
        latestIssuedId: 0,
        newestRetainedId: null,
        oldestRetainedId: null,
        retainedEvents: 0,
    }),
});

export async function openSharedDatabases(): Promise<{
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
            appliedAt: parseISO("2026-08-04T14:00:00.000Z"),
            releaseId: "0".repeat(40),
        });
        const writerSqlite = new Database(databasePath, { strict: true });
        writerSqlite.run("PRAGMA foreign_keys = ON");
        readerSqlite.run("PRAGMA journal_mode = WAL");
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
