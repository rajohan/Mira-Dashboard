import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Fiber, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";

import {
    DatabaseRuntimeLockTimeoutError,
    DatabaseRuntimeStartupError,
} from "./databaseErrors.ts";
import {
    databaseRuntimePolicy,
    retryDatabaseStartupOperation,
} from "./databasePolicy.ts";
import {
    DatabaseRuntimeService,
    databaseRuntimeLayer,
    type DatabaseRuntimeLayerOptions,
} from "./databaseService.ts";

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

afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

describe("database runtime service", () => {
    test("initializes a fresh strict WAL database through one native Drizzle handle", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const { service } = await buildRuntime(options(stateDirectory));

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
