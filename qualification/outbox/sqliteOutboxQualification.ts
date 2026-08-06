import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Schedule, Scope } from "effect";

import {
    parseSqliteOutboxChildStatus,
    type SqliteOutboxChildStatus,
} from "./sqliteOutboxProtocol.ts";
import {
    createQualificationOutboxBackup,
    initializeQualificationOutboxDatabase,
    openQualificationOutboxDatabase,
    readQualificationDeliveryLatencies,
    readQualificationIntegrityCheck,
    readQualificationJournalMode,
    readQualificationOutboxSnapshot,
    type QualificationOutboxSnapshot,
} from "./sqliteOutboxStore.ts";

const childModulePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "sqliteOutboxChild.ts"
);
const childStatusMaximumBytes = 16 * 1024;
const childDeadline = "5 seconds";
const statusPollingSchedule = Schedule.spaced("5 millis").pipe(
    Schedule.upTo({ times: 1000 })
);

type QualificationChildProcess = Bun.Subprocess<"ignore", "ignore", "ignore">;

export class QualificationChildProcessError extends Data.TaggedError(
    "QualificationChildProcessError"
)<{
    readonly exitCode?: number;
    readonly operation: string;
}> {}

export class QualificationDeadlineError extends Data.TaggedError(
    "QualificationDeadlineError"
)<{
    readonly operation: string;
}> {}

class QualificationStatusPendingError extends Data.TaggedError(
    "QualificationStatusPendingError"
)<{
    readonly cause?: unknown;
}> {}

export interface OutboxLatencySummary {
    readonly maximumMs: number;
    readonly medianMs: number;
    readonly p95Ms: number;
    readonly sampleCount: number;
}

export interface SqliteOutboxQualificationReport {
    readonly crashedClaimEventIds: readonly number[];
    readonly crashedWorkerSignal: NodeJS.Signals | null;
    readonly finalSnapshot: QualificationOutboxSnapshot;
    readonly integrityCheck: string;
    readonly journalMode: string;
    readonly latency: OutboxLatencySummary;
    readonly producerCounts: readonly number[];
    readonly restoredIntegrityCheck: string;
    readonly restoredSnapshot: QualificationOutboxSnapshot;
    readonly workerClaimCounts: readonly number[];
    readonly workerDeliveryCounts: readonly number[];
}

function percentile(sortedValues: readonly number[], fraction: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil(sortedValues.length * fraction) - 1;
    return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))] ?? 0;
}

/**
 * Summarizes logical delivery latency without imposing wall-clock CI thresholds.
 * Performance qualification can publish the same shape from capped CLI runs.
 * @param values Logical delivery-latency samples.
 * @returns Deterministic percentile summary with no wall-clock pass threshold.
 */
export function summarizeOutboxLatencies(
    values: readonly number[]
): OutboxLatencySummary {
    const sorted = values.toSorted((left, right) => left - right);
    return Object.freeze({
        maximumMs: sorted.at(-1) ?? 0,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        sampleCount: sorted.length,
    });
}

function childDeadlineFailure(operation: string): QualificationDeadlineError {
    return new QualificationDeadlineError({ operation });
}

function awaitChildExit(
    child: QualificationChildProcess,
    operation: string
): Effect.Effect<number, QualificationChildProcessError | QualificationDeadlineError> {
    return Effect.tryPromise({
        catch: () => new QualificationChildProcessError({ operation }),
        try: () => child.exited,
    }).pipe(
        Effect.timeoutOrElse({
            duration: childDeadline,
            orElse: () => Effect.fail(childDeadlineFailure(operation)),
        })
    );
}

function stopChild(
    child: QualificationChildProcess,
    operation: string
): Effect.Effect<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
    const graceful = Effect.sync(() => child.kill("SIGTERM")).pipe(
        Effect.andThen(awaitChildExit(child, `${operation}:sigterm`))
    );
    return graceful.pipe(
        Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () =>
                Effect.sync(() => child.kill("SIGKILL")).pipe(
                    Effect.andThen(awaitChildExit(child, `${operation}:sigkill`))
                ),
        }),
        Effect.asVoid,
        Effect.orDie
    );
}

function spawnChild(
    operation: string,
    arguments_: readonly string[]
): Effect.Effect<QualificationChildProcess, QualificationChildProcessError, Scope.Scope> {
    return Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        return yield* Effect.acquireRelease(
            Effect.try({
                catch: () => new QualificationChildProcessError({ operation }),
                try: () =>
                    Bun.spawn([process.execPath, childModulePath, ...arguments_], {
                        killSignal: "SIGTERM",
                        signal,
                        stderr: "ignore",
                        stdin: "ignore",
                        stdout: "ignore",
                    }),
            }),
            (child) => stopChild(child, operation)
        );
    });
}

function readStatus(
    statusPath: string,
    operation: string
): Effect.Effect<SqliteOutboxChildStatus, QualificationDeadlineError> {
    const attempt = Effect.tryPromise({
        catch: (cause) => new QualificationStatusPendingError({ cause }),
        try: async () => {
            const statusFile = Bun.file(statusPath);
            if (!(await statusFile.exists())) throw new Error("status pending");
            if (statusFile.size > childStatusMaximumBytes) {
                throw new Error("status exceeds qualification bound");
            }
            const statusText = await statusFile.text();
            const statusValue: unknown = JSON.parse(statusText);
            return parseSqliteOutboxChildStatus(statusValue);
        },
    });
    return attempt.pipe(
        Effect.retry({ schedule: statusPollingSchedule }),
        Effect.catchTag("QualificationStatusPendingError", () =>
            Effect.fail(childDeadlineFailure(operation))
        ),
        Effect.timeoutOrElse({
            duration: childDeadline,
            orElse: () => Effect.fail(childDeadlineFailure(operation)),
        })
    );
}

function runOneShotChild(
    operation: string,
    statusPath: string,
    arguments_: readonly string[]
): Effect.Effect<
    SqliteOutboxChildStatus,
    QualificationChildProcessError | QualificationDeadlineError
> {
    return Effect.scoped(
        Effect.gen(function* () {
            const child = yield* spawnChild(operation, arguments_);
            const exitCode = yield* awaitChildExit(child, operation);
            if (exitCode !== 0) {
                return yield* Effect.fail(
                    new QualificationChildProcessError({ exitCode, operation })
                );
            }
            return yield* readStatus(statusPath, operation);
        })
    );
}

function claimAndTerminateChild(
    databasePath: string,
    statusPath: string
): Effect.Effect<
    {
        readonly child: QualificationChildProcess;
        readonly status: SqliteOutboxChildStatus;
    },
    QualificationChildProcessError | QualificationDeadlineError
> {
    return Effect.scoped(
        Effect.gen(function* () {
            const operation = "claim-before-termination";
            const child = yield* spawnChild(operation, [
                "claim-and-hold",
                databasePath,
                statusPath,
                "crash-worker",
                "10000",
                "20000",
                "7",
            ]);
            const status = yield* readStatus(statusPath, operation);
            yield* Effect.sync(() => child.kill("SIGKILL"));
            yield* awaitChildExit(child, `${operation}:crash`);
            return { child, status };
        })
    );
}

function databaseResource(databasePath: string, readonly = false) {
    return Effect.acquireRelease(
        Effect.sync(() => openQualificationOutboxDatabase(databasePath, { readonly })),
        (database) => Effect.sync(() => database.close(true))
    );
}

function temporaryWorkspace() {
    return Effect.acquireRelease(
        Effect.tryPromise({
            catch: () =>
                new QualificationChildProcessError({ operation: "temp-directory" }),
            try: () => mkdtemp(path.join(tmpdir(), "mira-dashboard-outbox-")),
        }),
        (workspacePath) =>
            Effect.tryPromise(() =>
                rm(workspacePath, { force: true, recursive: true })
            ).pipe(Effect.orDie)
    );
}

/**
 * Runs the file-backed multi-process outbox qualification in one Effect scope.
 * Logical lease timestamps keep recovery assertions deterministic in CI.
 */
export const sqliteOutboxQualification = Effect.scoped(
    Effect.gen(function* () {
        const workspacePath = yield* temporaryWorkspace();
        const databasePath = path.join(workspacePath, "qualification.sqlite");
        const backupPath = path.join(workspacePath, "qualification.backup.sqlite");
        const database = yield* databaseResource(databasePath);
        yield* Effect.sync(() => initializeQualificationOutboxDatabase(database));

        const producerSpecifications = [
            { count: 19, createdAt: 1000, id: "web-a" },
            { count: 23, createdAt: 2000, id: "web-b" },
        ] as const;
        const producerStatuses = yield* Effect.all(
            producerSpecifications.map((producer) => {
                const statusPath = path.join(
                    workspacePath,
                    `producer-${producer.id}.json`
                );
                return runOneShotChild("web-producer", statusPath, [
                    "produce",
                    databasePath,
                    statusPath,
                    producer.id,
                    String(producer.count),
                    String(producer.createdAt),
                ]);
            }),
            { concurrency: 2 }
        );
        const produced = producerStatuses.map((status) => {
            if (status.kind !== "produced") {
                throw new Error("Web child returned an unexpected status kind");
            }
            return status.count;
        });

        const terminated = yield* claimAndTerminateChild(
            databasePath,
            path.join(workspacePath, "terminated-claim.json")
        );
        if (terminated.status.kind !== "claimed") {
            return yield* Effect.die("Claim child returned an unexpected status kind");
        }
        const afterTermination = yield* Effect.sync(() =>
            readQualificationOutboxSnapshot(database)
        );
        if (afterTermination.claimedCount !== terminated.status.eventIds.length) {
            return yield* Effect.die(
                "Terminated worker claims were not durable before recovery"
            );
        }

        const workerSpecifications = ["worker-a", "worker-b"] as const;
        const workerStatuses = yield* Effect.all(
            workerSpecifications.map((workerId) => {
                const statusPath = path.join(workspacePath, `${workerId}.json`);
                return runOneShotChild("worker-drain", statusPath, [
                    "drain",
                    databasePath,
                    statusPath,
                    workerId,
                    "30000",
                    "5000",
                    "5",
                ]);
            }),
            { concurrency: 2 }
        );
        const drained = workerStatuses.map((status) => {
            if (status.kind !== "drained") {
                throw new Error("Worker child returned an unexpected status kind");
            }
            return status;
        });

        const finalSnapshot = yield* Effect.sync(() =>
            readQualificationOutboxSnapshot(database)
        );
        const journalMode = yield* Effect.sync(() =>
            readQualificationJournalMode(database)
        );
        const integrityCheck = yield* Effect.sync(() =>
            readQualificationIntegrityCheck(database)
        );
        const latency = yield* Effect.sync(() =>
            summarizeOutboxLatencies(readQualificationDeliveryLatencies(database))
        );
        yield* Effect.sync(() => createQualificationOutboxBackup(database, backupPath));

        const restoredDatabase = yield* databaseResource(backupPath, true);
        const restoredSnapshot = yield* Effect.sync(() =>
            readQualificationOutboxSnapshot(restoredDatabase)
        );
        const restoredIntegrityCheck = yield* Effect.sync(() =>
            readQualificationIntegrityCheck(restoredDatabase)
        );

        return Object.freeze({
            crashedClaimEventIds: Object.freeze([...terminated.status.eventIds]),
            crashedWorkerSignal: terminated.child.signalCode,
            finalSnapshot,
            integrityCheck,
            journalMode,
            latency,
            producerCounts: Object.freeze(produced),
            restoredIntegrityCheck,
            restoredSnapshot,
            workerClaimCounts: Object.freeze(
                drained.map((status) => status.claimedCount)
            ),
            workerDeliveryCounts: Object.freeze(
                drained.map((status) => status.deliveredCount)
            ),
        } satisfies SqliteOutboxQualificationReport);
    })
);
