import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Fiber, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";

import { applyVerifiedMigrations } from "../migrations/applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "../migrations/loadVerifiedMigrations.ts";
import {
    DatabaseRuntimeLockTimeoutError,
    DatabaseRuntimePathError,
    DatabaseRuntimeStartupError,
    DatabaseRuntimeWriteAdmissionTimeoutError,
    DatabaseRuntimeWriteContentionError,
} from "./databaseErrors.ts";
import {
    databaseRuntimePolicy,
    retryDatabaseStartupOperation,
    retryDatabaseWriteOperation,
} from "./databasePolicy.ts";
import {
    DatabaseRuntimeService,
    databaseCandidateMigrationLayer,
    databaseRuntimeLayer,
    type DatabaseRuntimeLayerOptions,
} from "./databaseService.ts";
import {
    initializeDatabaseRuntime,
    normalizeDatabaseRuntimeOptions,
} from "./databaseStartup.ts";

const migrationsDirectory = path.resolve(import.meta.dir, "../../../../migrations");
const releaseId = "0".repeat(40);
const temporaryDirectories: string[] = [];
const runtimes: Array<{ dispose(): Promise<void> }> = [];

async function privateTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-db-runtime-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
        return new Error("Expected promise rejection");
    } catch (error) {
        return error;
    }
}

function bindCallable(member: unknown, receiver: object): unknown {
    if (typeof member !== "function") return member;
    return (...arguments_: unknown[]): unknown =>
        Reflect.apply(member, receiver, arguments_) as unknown;
}

function options(
    stateDirectory: string,
    startupMode: DatabaseRuntimeLayerOptions["startupMode"] = "initialize-empty"
): DatabaseRuntimeLayerOptions {
    return {
        migrationsDirectory,
        releaseId,
        startupMode,
        stateDirectory,
    };
}

async function buildRuntime(runtimeOptions: DatabaseRuntimeLayerOptions) {
    const runtime = ManagedRuntime.make(databaseRuntimeLayer(runtimeOptions));
    runtimes.push(runtime);
    await runtime.context();
    const service = await runtime.runPromise(DatabaseRuntimeService);
    return { runtime, service };
}

async function migrateCandidate(
    stateDirectory: string,
    candidateReleaseId = releaseId
): Promise<void> {
    const runtime = ManagedRuntime.make(
        databaseCandidateMigrationLayer({
            migrationsDirectory,
            releaseId: candidateReleaseId,
            stateDirectory,
        })
    );
    runtimes.push(runtime);
    await runtime.context();
    await runtime.dispose();
}

afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

describe("database runtime service", () => {
    test("initializes and revalidates an isolated delivery candidate without rewriting history", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        await migrateCandidate(stateDirectory);

        const databasePath = path.join(stateDirectory, "mira-dashboard.db");
        let database = new Database(databasePath, { strict: true });
        expect(
            database
                .query<{ count: number; releaseId: string }, []>(`
                    SELECT COUNT(*) AS count, MIN(release_id) AS releaseId
                    FROM schema_migrations
                `)
                .get()
        ).toEqual({ count: 1, releaseId });
        database.close(true);

        await migrateCandidate(stateDirectory, "1".repeat(40));
        database = new Database(databasePath, { strict: true });
        expect(
            database
                .query<{ count: number; releaseId: string }, []>(`
                    SELECT COUNT(*) AS count, MIN(release_id) AS releaseId
                    FROM schema_migrations
                `)
                .get()
        ).toEqual({ count: 1, releaseId });
        database.close(true);
    });

    test("rejects a drifted delivery candidate without changing normal startup modes", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const databasePath = path.join(stateDirectory, "mira-dashboard.db");
        const database = new Database(databasePath, { create: true, strict: true });
        database.run("CREATE TABLE unreviewed (id INTEGER PRIMARY KEY) STRICT");
        database.close(true);
        await chmod(databasePath, 0o600);

        expect(await rejectionOf(migrateCandidate(stateDirectory))).toBeInstanceOf(
            DatabaseRuntimeStartupError
        );
        expect(() =>
            normalizeDatabaseRuntimeOptions({
                ...options(stateDirectory),
                startupMode: "migrate-candidate" as never,
            })
        ).toThrow(DatabaseRuntimeStartupError);
    });

    test("initializes a fresh strict WAL database through one native Drizzle handle", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { runtime, service } = await buildRuntime(options(stateDirectory));

        expect(service.diagnostics).toEqual({
            appliedMigrations: 1,
            connection: {
                busyTimeoutMs: 0,
                checksEnforced: true,
                foreignKeysEnabled: true,
                journalMode: "wal",
                synchronousLevel: 2,
                trustedSchemaEnabled: false,
                walAutoCheckpointPages: 1000,
            },
            databaseFileName: "mira-dashboard.db",
            migrationCount: 1,
            startupMode: "initialize-empty",
        });
        expect(service.orm.$client).toBeInstanceOf(Database);
        expect(service.orm.$client.filename).toBe(
            path.join(stateDirectory, "mira-dashboard.db")
        );
        const databaseStat = await stat(service.orm.$client.filename);
        expect(databaseStat.mode & 0o777).toBe(0o600);
        expect(service.orm.$client.query("PRAGMA foreign_keys").get()).toEqual({
            foreign_keys: 1,
        });
        expect(
            service.orm.$client.query("PRAGMA ignore_check_constraints").get()
        ).toEqual({ ignore_check_constraints: 0 });
        expect(service.orm.$client.query("PRAGMA journal_mode").get()).toEqual({
            journal_mode: "wal",
        });
        expect(service.orm.$client.query("PRAGMA synchronous").get()).toEqual({
            synchronous: 2,
        });
        expect(service.orm.$client.query("PRAGMA trusted_schema").get()).toEqual({
            trusted_schema: 0,
        });

        const observation = await runtime.runPromise(service.observeDiagnostics);
        expect(observation).toMatchObject({
            databaseFileName: "mira-dashboard.db",
            sqlite: {
                permissions: {
                    dataDirectory: "0700",
                    database: "0600",
                    secure: true,
                },
            },
        });
        expect(observation.sqlite.databaseBytes).toBeGreaterThan(0);
        expect(observation.sqlite.freeBytes).toBe(
            observation.sqlite.freePages * observation.sqlite.pageSizeBytes
        );
        expect(observation.sqlite.storageBytes).toBe(
            observation.sqlite.databaseBytes +
                observation.sqlite.walBytes +
                observation.sqlite.shmBytes
        );
    });

    test("validates an already-current database without applying migrations", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const first = await buildRuntime(options(stateDirectory));
        await first.runtime.dispose();

        const second = await buildRuntime(options(stateDirectory, "validate-only"));
        expect(second.service.diagnostics.appliedMigrations).toBe(0);
        expect(second.service.diagnostics.startupMode).toBe("validate-only");
        expect(
            second.service.orm.$client
                .query<{ count: number }, []>(
                    "SELECT COUNT(*) AS count FROM schema_migrations"
                )
                .get()
        ).toEqual({ count: 1 });
    });

    test("fails live storage observation closed after permission drift", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { runtime, service } = await buildRuntime(options(stateDirectory));
        const databasePath = service.orm.$client.filename;
        await chmod(databasePath, 0o644);

        try {
            expect(
                await rejectionOf(runtime.runPromise(service.observeDiagnostics))
            ).toBeInstanceOf(DatabaseRuntimePathError);
        } finally {
            await chmod(databasePath, 0o600);
        }
    });

    test("validates an already-current database while another process owns the writer slot", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const initialized = await buildRuntime(options(stateDirectory));
        const databasePath = initialized.service.orm.$client.filename;
        await initialized.runtime.dispose();
        const competingWriter = new Database(databasePath, { strict: true });
        competingWriter.run("PRAGMA busy_timeout = 0");
        competingWriter.run("BEGIN IMMEDIATE");

        try {
            const validated = await buildRuntime(
                options(stateDirectory, "validate-only")
            );
            expect(validated.service.diagnostics.appliedMigrations).toBe(0);
        } finally {
            competingWriter.run("ROLLBACK");
            competingWriter.close(true);
        }
    });

    test("serializes two concurrent empty-database startups through SQLite admission", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const [first, second] = await Promise.all([
            buildRuntime(options(stateDirectory)),
            buildRuntime(options(stateDirectory)),
        ]);

        expect(
            [
                first.service.diagnostics.appliedMigrations,
                second.service.diagnostics.appliedMigrations,
            ].toSorted((left, right) => left - right)
        ).toEqual([0, 1]);
        expect(
            first.service.orm.$client
                .query<{ count: number }, []>(
                    "SELECT COUNT(*) AS count FROM schema_migrations"
                )
                .get()
        ).toEqual({ count: 1 });
        expect(first.service.orm.$client.filename).toBe(
            second.service.orm.$client.filename
        );
    });

    test("validate-only rechecks empty state after a concurrent initializer commits", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const databasePath = path.join(stateDirectory, "mira-dashboard.db");
        await writeFile(databasePath, "", { mode: 0o600 });
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });
        const initializer = new Database(databasePath, { strict: true });
        initializer.run("PRAGMA foreign_keys = ON");
        initializer.run("PRAGMA ignore_check_constraints = OFF");
        initializer.run("PRAGMA journal_mode = WAL");
        initializer.run("PRAGMA busy_timeout = 0");
        initializer.run("BEGIN IMMEDIATE");
        const validator = new Database(databasePath, { strict: true });
        const initialSchemaRead = Promise.withResolvers<unknown>();
        let initialSchemaReadRecorded = false;

        try {
            applyVerifiedMigrations(initializer, migrations, { releaseId });
            const validationBoundary = new Proxy(validator, {
                get(target, property) {
                    if (property === "query") {
                        return ((sql: string) => {
                            const statement = target.query(sql);
                            if (
                                !initialSchemaReadRecorded &&
                                sql.includes("SELECT 1 AS present")
                            ) {
                                return new Proxy(statement, {
                                    get(statementTarget, statementProperty) {
                                        if (statementProperty === "get") {
                                            return () => {
                                                const observation: unknown =
                                                    statementTarget.get();
                                                initialSchemaReadRecorded = true;
                                                initialSchemaRead.resolve(observation);
                                                return observation;
                                            };
                                        }
                                        const member: unknown = Reflect.get(
                                            statementTarget,
                                            statementProperty,
                                            statementTarget
                                        );
                                        return bindCallable(member, statementTarget);
                                    },
                                });
                            }
                            return statement;
                        }) as Database["query"];
                    }
                    const member: unknown = Reflect.get(target, property, target);
                    return bindCallable(member, target);
                },
            });
            const normalizedOptions = normalizeDatabaseRuntimeOptions(
                options(stateDirectory, "validate-only")
            );
            const startup = initializeDatabaseRuntime(
                validationBoundary,
                migrations,
                normalizedOptions
            );
            const validation = Effect.runPromise(startup);
            void validation.catch(() => null);
            expect(await initialSchemaRead.promise).toBeNull();
            expect(initializer.inTransaction).toBeTrue();
            initializer.run("COMMIT");
            const diagnostics = await validation;

            expect(diagnostics.appliedMigrations).toBe(0);
            expect(diagnostics.startupMode).toBe("validate-only");
        } finally {
            if (initializer.inTransaction) initializer.run("ROLLBACK");
            validator.close(true);
            initializer.close(true);
        }
    });

    test("validate-only rejects an absent database without creating it", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const runtime = ManagedRuntime.make(
            databaseRuntimeLayer(options(stateDirectory, "validate-only"))
        );
        runtimes.push(runtime);

        expect(await rejectionOf(runtime.context())).toMatchObject({
            _tag: "DatabaseRuntimeStartupError",
            reason: "database-empty",
        });
        const databasePath = path.join(stateDirectory, "mira-dashboard.db");
        const statFailure = await rejectionOf(stat(databasePath));
        expect(statFailure).toMatchObject({ code: "ENOENT" });
    });

    test("rejects artifact and schema tampering with redacted tagged failures", async () => {
        const artifactDirectory = await privateTemporaryDirectory();
        const invalidArtifactRuntime = ManagedRuntime.make(
            databaseRuntimeLayer({
                ...options(artifactDirectory),
                migrationsDirectory: path.join(artifactDirectory, "missing"),
            })
        );
        runtimes.push(invalidArtifactRuntime);
        expect(await rejectionOf(invalidArtifactRuntime.context())).toMatchObject({
            _tag: "DatabaseRuntimeStartupError",
            reason: "artifact-invalid",
        });

        const stateDirectory = await privateTemporaryDirectory();
        const initialized = await buildRuntime(options(stateDirectory));
        const databasePath = initialized.service.orm.$client.filename;
        await initialized.runtime.dispose();
        const tamper = new Database(databasePath, { strict: true });
        tamper.run("CREATE TABLE unreviewed_runtime_table (id INTEGER PRIMARY KEY)");
        tamper.close(true);

        const validation = ManagedRuntime.make(
            databaseRuntimeLayer(options(stateDirectory, "validate-only"))
        );
        runtimes.push(validation);
        expect(await rejectionOf(validation.context())).toBeInstanceOf(
            DatabaseRuntimeStartupError
        );
    });

    test("preserves a startup failure before checkpoint policy is established", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        await writeFile(
            path.join(stateDirectory, "mira-dashboard.db"),
            "not a SQLite database",
            { mode: 0o600 }
        );
        const runtime = ManagedRuntime.make(
            databaseRuntimeLayer(options(stateDirectory, "validate-only"))
        );
        runtimes.push(runtime);

        const failure = await rejectionOf(runtime.context());
        expect(failure).toBeInstanceOf(DatabaseRuntimeStartupError);
        expect(failure).toMatchObject({ reason: "database-startup-failed" });
    });

    test("runs a passive checkpoint while a second WAL connection remains open", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { runtime, service } = await buildRuntime(options(stateDirectory));
        const second = new Database(service.orm.$client.filename, { strict: true });
        second.run("PRAGMA journal_mode = WAL");
        second.run("CREATE TABLE checkpoint_probe (id INTEGER PRIMARY KEY)");
        second.run("INSERT INTO checkpoint_probe (id) VALUES (1)");

        const diagnostics = await runtime.runPromise(service.checkpointPassive);
        expect([0, 1]).toContain(diagnostics.busy);
        expect(diagnostics.logFrames).toBeGreaterThanOrEqual(1);
        expect(diagnostics.checkpointedFrames).toBeGreaterThanOrEqual(0);
        expect(second.query("SELECT id FROM checkpoint_probe").all()).toEqual([
            { id: 1 },
        ]);
        second.close(true);
    });

    test("retries real cross-connection write admission before entering the callback", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { runtime, service } = await buildRuntime(options(stateDirectory));
        const competingWriter = new Database(service.orm.$client.filename, {
            strict: true,
        });
        competingWriter.run("PRAGMA busy_timeout = 0");
        competingWriter.run("BEGIN IMMEDIATE");
        const firstAdmissionAttempt = Promise.withResolvers<void>();
        let admissionAttempts = 0;
        let callbackCalls = 0;
        const admittedWrite = runtime.runPromise(
            service.runImmediateWrite((markTransactionStarted) => {
                admissionAttempts += 1;
                firstAdmissionAttempt.resolve();
                return service.orm.$client
                    .transaction(() => {
                        markTransactionStarted();
                        callbackCalls += 1;
                        return "committed" as const;
                    })
                    .immediate();
            })
        );

        try {
            await firstAdmissionAttempt.promise;
            expect(admissionAttempts).toBeGreaterThanOrEqual(1);
            expect(callbackCalls).toBe(0);
            competingWriter.run("ROLLBACK");

            expect(await admittedWrite).toBe("committed");
            expect(callbackCalls).toBe(1);
        } finally {
            if (competingWriter.inTransaction) competingWriter.run("ROLLBACK");
            competingWriter.close(true);
        }
    });

    test("checkpoints before strict close and makes the retained handle unusable", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { runtime, service } = await buildRuntime(options(stateDirectory));
        const retainedHandle = service.orm.$client;
        retainedHandle.run("CREATE TABLE finalizer_probe (id INTEGER PRIMARY KEY)");
        retainedHandle.run("INSERT INTO finalizer_probe (id) VALUES (1)");

        await runtime.dispose();
        expect(() => retainedHandle.query("SELECT 1").get()).toThrow();

        const verification = new Database(retainedHandle.filename, {
            readonly: true,
            strict: true,
        });
        expect(verification.query("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
        });
        verification.close(true);
    });
});

describe("database startup retry policy", () => {
    test("times out persistent SQLITE_BUSY using the Effect clock", async () => {
        let attempts = 0;
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* retryDatabaseStartupOperation(() => {
                attempts += 1;
                throw Object.assign(new Error("not exposed"), { code: "SQLITE_BUSY" });
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(databaseRuntimePolicy.migrationLockTimeoutMs);
            return yield* Fiber.join(fiber).pipe(Effect.flip);
        }).pipe(Effect.provide(TestClock.layer()));

        const failure = await Effect.runPromise(program);
        expect(failure).toBeInstanceOf(DatabaseRuntimeLockTimeoutError);
        expect(attempts).toBeGreaterThan(1);
    });

    test("interrupts queued retry sleep without running further attempts", async () => {
        let attempts = 0;
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* retryDatabaseStartupOperation(() => {
                attempts += 1;
                throw Object.assign(new Error("not exposed"), { code: "SQLITE_LOCKED" });
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            const attemptsBeforeInterruption = attempts;
            yield* Fiber.interrupt(fiber);
            yield* TestClock.adjust(databaseRuntimePolicy.migrationLockTimeoutMs * 2);
            return attemptsBeforeInterruption;
        }).pipe(Effect.provide(TestClock.layer()));

        const attemptsBeforeInterruption = await Effect.runPromise(program);
        expect(attemptsBeforeInterruption).toBeGreaterThanOrEqual(1);
        expect(attempts).toBe(attemptsBeforeInterruption);
    });
});

describe("database write admission policy", () => {
    test("retries only pre-callback busy admission and runs the callback once", async () => {
        let attempts = 0;
        let callbackCalls = 0;

        const value = await Effect.runPromise(
            retryDatabaseWriteOperation((markTransactionStarted) => {
                attempts += 1;
                if (attempts === 1) {
                    throw Object.assign(new Error("not exposed"), {
                        code: "SQLITE_BUSY",
                    });
                }
                markTransactionStarted();
                callbackCalls += 1;
                return 42;
            })
        );

        expect(value).toBe(42);
        expect(attempts).toBe(2);
        expect(callbackCalls).toBe(1);
    });

    test("times out persistent pre-callback contention with the Effect clock", async () => {
        let attempts = 0;
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* retryDatabaseWriteOperation(() => {
                attempts += 1;
                throw Object.assign(new Error("not exposed"), {
                    code: "SQLITE_LOCKED_SHAREDCACHE",
                });
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(databaseRuntimePolicy.writeAdmissionTimeoutMs);
            return yield* Fiber.join(fiber).pipe(Effect.flip);
        }).pipe(Effect.provide(TestClock.layer()));

        const failure = await Effect.runPromise(program);
        expect(failure).toBeInstanceOf(DatabaseRuntimeWriteAdmissionTimeoutError);
        expect(attempts).toBeGreaterThan(1);
    });

    test("interrupts queued write admission without running another attempt", async () => {
        let attempts = 0;
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* retryDatabaseWriteOperation(() => {
                attempts += 1;
                throw Object.assign(new Error("not exposed"), {
                    code: "SQLITE_BUSY",
                });
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            const attemptsBeforeInterruption = attempts;
            yield* Fiber.interrupt(fiber);
            yield* TestClock.adjust(databaseRuntimePolicy.writeAdmissionTimeoutMs * 2);
            return attemptsBeforeInterruption;
        }).pipe(Effect.provide(TestClock.layer()));

        const attemptsBeforeInterruption = await Effect.runPromise(program);
        expect(attemptsBeforeInterruption).toBeGreaterThanOrEqual(1);
        expect(attempts).toBe(attemptsBeforeInterruption);
    });

    test("never replays contention after the transaction callback begins", async () => {
        let attempts = 0;
        const failure = await rejectionOf(
            Effect.runPromise(
                retryDatabaseWriteOperation((markTransactionStarted) => {
                    attempts += 1;
                    markTransactionStarted();
                    throw Object.assign(new Error("not exposed"), {
                        code: "SQLITE_BUSY_SNAPSHOT",
                    });
                })
            )
        );

        expect(failure).toBeInstanceOf(DatabaseRuntimeWriteContentionError);
        expect(attempts).toBe(1);
    });

    test("preserves non-contention callback failures without replay", async () => {
        const sentinel = new Error("domain failure");
        let attempts = 0;
        const failure = await rejectionOf(
            Effect.runPromise(
                retryDatabaseWriteOperation((markTransactionStarted) => {
                    attempts += 1;
                    markTransactionStarted();
                    throw sentinel;
                })
            )
        );

        expect(failure).toBe(sentinel);
        expect(attempts).toBe(1);
    });
});
