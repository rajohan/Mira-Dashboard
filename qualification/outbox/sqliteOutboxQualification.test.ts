import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import {
    sqliteOutboxQualification,
    summarizeOutboxLatencies,
} from "./sqliteOutboxQualification.ts";
import {
    appendQualificationOutboxBatch,
    classifyQualificationSqliteError,
    countQualificationRows,
    initializeQualificationOutboxDatabase,
    openQualificationOutboxDatabase,
    QualificationSqliteContentionError,
    readQualificationJournalMode,
} from "./sqliteOutboxStore.ts";

function temporaryDirectoryResource() {
    return Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "mira-dashboard-sqlite-test-"))),
        (directoryPath) =>
            Effect.promise(() =>
                rm(directoryPath, { force: true, recursive: true })
            ).pipe(Effect.orDie)
    );
}

function databaseResource(databasePath: string, readonly = false) {
    return Effect.acquireRelease(
        Effect.sync(() => openQualificationOutboxDatabase(databasePath, { readonly })),
        (database) => Effect.sync(() => database.close(true))
    );
}

describe("file-backed Bun SQLite qualification", () => {
    test("qualifies WAL reader/writer snapshots and writer contention", async () => {
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const directoryPath = yield* temporaryDirectoryResource();
                    const databasePath = path.join(directoryPath, "wal.sqlite");
                    const writer = yield* databaseResource(databasePath);
                    yield* Effect.sync(() =>
                        initializeQualificationOutboxDatabase(writer)
                    );
                    const reader = yield* databaseResource(databasePath, true);
                    const competingWriter = yield* databaseResource(databasePath);

                    yield* Effect.sync(() => {
                        appendQualificationOutboxBatch(writer, "reader-before", 1, 1000);
                        reader.run("BEGIN");
                    });
                    const snapshotBeforeWrite = yield* Effect.sync(() =>
                        countQualificationRows(reader, "qualification_outbox_events")
                    );
                    yield* Effect.sync(() =>
                        appendQualificationOutboxBatch(writer, "reader-after", 1, 2000)
                    );
                    const stableReaderSnapshot = yield* Effect.sync(() =>
                        countQualificationRows(reader, "qualification_outbox_events")
                    );
                    const refreshedReaderSnapshot = yield* Effect.sync(() => {
                        reader.run("COMMIT");
                        return countQualificationRows(
                            reader,
                            "qualification_outbox_events"
                        );
                    });

                    const contention = yield* Effect.sync(() => {
                        writer.run("BEGIN IMMEDIATE");
                        let competingWriterAcquired = false;
                        let classifiedError: ReturnType<
                            typeof classifyQualificationSqliteError
                        >;
                        try {
                            competingWriter.run("BEGIN IMMEDIATE");
                            competingWriterAcquired = true;
                        } catch (error) {
                            classifiedError = classifyQualificationSqliteError(error);
                        } finally {
                            if (competingWriterAcquired) {
                                competingWriter.run("ROLLBACK");
                            }
                            writer.run("ROLLBACK");
                        }
                        if (competingWriterAcquired) {
                            throw new Error(
                                "Competing writer unexpectedly acquired WAL lock"
                            );
                        }
                        return classifiedError;
                    });

                    return {
                        contention,
                        journalMode: readQualificationJournalMode(writer),
                        refreshedReaderSnapshot,
                        snapshotBeforeWrite,
                        stableReaderSnapshot,
                    };
                })
            )
        );

        expect(result.contention).toBeInstanceOf(QualificationSqliteContentionError);
        expect(result.journalMode).toBe("wal");
        expect(result.refreshedReaderSnapshot).toBe(2);
        expect(result.snapshotBeforeWrite).toBe(1);
        expect(result.stableReaderSnapshot).toBe(1);
        expect(result.contention?.code).toBe("SQLITE_BUSY");
        const lockedError = Object.assign(new Error("shared cache locked"), {
            code: "SQLITE_LOCKED_SHAREDCACHE",
        });
        const classifiedLockedError = classifyQualificationSqliteError(lockedError);
        expect(classifiedLockedError).toBeInstanceOf(QualificationSqliteContentionError);
    });

    test("qualifies nested savepoints and deterministic native disposal", async () => {
        let releasedDatabase:
            | ReturnType<typeof openQualificationOutboxDatabase>
            | undefined;
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const directoryPath = yield* temporaryDirectoryResource();
                    const databasePath = path.join(directoryPath, "savepoints.sqlite");
                    const database = yield* databaseResource(databasePath);
                    releasedDatabase = database;
                    yield* Effect.sync(() => {
                        initializeQualificationOutboxDatabase(database);
                        database.run(
                            "CREATE TABLE qualification_savepoints (id INTEGER PRIMARY KEY NOT NULL) STRICT"
                        );
                    });

                    const nested = database.transaction(() => {
                        database.run("INSERT INTO qualification_savepoints VALUES (2)");
                        throw new Error("rollback nested savepoint");
                    });
                    yield* Effect.sync(() =>
                        database
                            .transaction(() => {
                                database.run(
                                    "INSERT INTO qualification_savepoints VALUES (1)"
                                );
                                try {
                                    nested();
                                } catch (error) {
                                    if (!(error instanceof Error)) throw error;
                                }
                                database.run(
                                    "INSERT INTO qualification_savepoints VALUES (3)"
                                );
                            })
                            .immediate()
                    );

                    const statement = database.prepare<{ id: number }, []>(
                        "SELECT id FROM qualification_savepoints ORDER BY id"
                    );
                    const rows = statement.all();
                    statement.finalize();
                    const finalizedStatementThrows = yield* Effect.sync(() => {
                        try {
                            statement.all();
                            return false;
                        } catch {
                            return true;
                        }
                    });
                    return { finalizedStatementThrows, rows };
                })
            )
        );

        expect(result).toEqual({
            finalizedStatementThrows: true,
            rows: [{ id: 1 }, { id: 3 }],
        });
        expect(releasedDatabase).toBeDefined();
        expect(() => releasedDatabase?.query("SELECT 1").get()).toThrow();
    });
});

describe("multi-process SQLite outbox qualification", () => {
    test("recovers terminated claims with no event gaps or duplicate deliveries", async () => {
        const report = await Effect.runPromise(sqliteOutboxQualification);
        const expectedEventIds = Array.from({ length: 42 }, (_, index) => index + 1);
        const expectedProducerSequences = [
            ...Array.from({ length: 19 }, (_, index) => `web-a:${index + 1}`),
            ...Array.from({ length: 23 }, (_, index) => `web-b:${index + 1}`),
        ];

        expect(report.journalMode).toBe("wal");
        expect(report.producerCounts.toSorted((left, right) => left - right)).toEqual([
            19, 23,
        ]);
        expect(report.crashedClaimEventIds).toHaveLength(7);
        expect(report.crashedWorkerSignal).toBe("SIGKILL");
        expect(report.workerClaimCounts.reduce((sum, count) => sum + count, 0)).toBe(42);
        expect(report.workerDeliveryCounts.reduce((sum, count) => sum + count, 0)).toBe(
            42
        );
        expect(report.finalSnapshot).toEqual({
            claimedCount: 0,
            deliveredCount: 42,
            deliveredEventIds: expectedEventIds,
            eventCount: 42,
            eventIds: expectedEventIds,
            pendingCount: 0,
            producerSequences: expectedProducerSequences,
        });
        expect(
            report.crashedClaimEventIds.every((eventId) =>
                report.finalSnapshot.deliveredEventIds.includes(eventId)
            )
        ).toBeTrue();
        expect(new Set(report.finalSnapshot.deliveredEventIds).size).toBe(42);
        expect(report.integrityCheck).toBe("ok");
        expect(report.restoredIntegrityCheck).toBe("ok");
        expect(report.restoredSnapshot).toEqual(report.finalSnapshot);
        expect(report.latency).toEqual({
            maximumMs: 29_000,
            medianMs: 28_000,
            p95Ms: 29_000,
            sampleCount: 42,
        });
    }, 15_000);

    test("summarizes latency evidence without a flaky wall-clock threshold", () => {
        expect(summarizeOutboxLatencies([])).toEqual({
            maximumMs: 0,
            medianMs: 0,
            p95Ms: 0,
            sampleCount: 0,
        });
        expect(summarizeOutboxLatencies([5, 1, 9, 3, 7])).toEqual({
            maximumMs: 9,
            medianMs: 5,
            p95Ms: 9,
            sampleCount: 5,
        });
    });
});
