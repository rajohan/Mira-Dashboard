import { describe, expect, test } from "bun:test";

import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import type { JobWorkerCoordinator } from "./coordinator.ts";
import type { JobRepository } from "./repository.ts";
import {
    createDashboardWorkerRuntime,
    type DashboardWorkerRuntimeDependencies,
    type DashboardWorkerRuntimeOptions,
} from "./workerRuntime.ts";

const noSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

const runtimeOptions: DashboardWorkerRuntimeOptions = {
    database: {
        migrationsDirectory: "/srv/mira-dashboard/releases/test/migrations",
        releaseId: "a".repeat(40),
        startupMode: "validate-only",
        stateDirectory: "/srv/mira-dashboard/state",
    },
    pid: 123,
    releaseId: "a".repeat(40),
    sideEffects: {
        forQueue: () => noSideEffects,
        forRun: () => noSideEffects,
        forSchedule: () => noSideEffects,
    },
    workerInstanceId: Bun.randomUUIDv7(),
};

function deferred<T>() {
    let resolveDeferred: ((value: T | PromiseLike<T>) => void) | undefined;
    let rejectDeferred: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
    });
    return {
        promise,
        reject(error: unknown) {
            rejectDeferred?.(error);
        },
        resolve(value: T) {
            resolveDeferred?.(value);
        },
    };
}

function runtimeFixture(initializationFailure?: Error) {
    const events: string[] = [];
    const coordinatorCompletion = deferred<void>();
    const forceSignals: Array<AbortSignal | undefined> = [];
    const coordinator: JobWorkerCoordinator = Object.freeze({
        completion: coordinatorCompletion.promise,
        dispose(forceSignal?: AbortSignal) {
            events.push("coordinator-dispose");
            forceSignals.push(forceSignal);
            coordinatorCompletion.resolve();
            return Promise.resolve();
        },
        initialize() {
            events.push("coordinator-initialize");
            return initializationFailure === undefined
                ? Promise.resolve()
                : Promise.reject(initializationFailure);
        },
    });
    const repository = Object.freeze({}) as JobRepository;
    const dependencies = {
        createCoordinator(options) {
            events.push("coordinator-create");
            expect(options.repository).toBe(repository);
            return coordinator;
        },
        createDatabaseRuntime() {
            return Object.freeze({
                dispose() {
                    events.push("database-dispose");
                    return Promise.resolve();
                },
                initialize() {
                    events.push("database-initialize");
                    return Promise.resolve({
                        database: Object.freeze({}) as SQLiteBunDatabase,
                        writeAdmission: Object.freeze({
                            run() {
                                return Promise.reject(
                                    new Error("Write admission is unused")
                                );
                            },
                        }) satisfies ImmediateDatabaseWriteAdmission,
                    });
                },
            });
        },
        createRepository() {
            events.push("repository-create");
            return repository;
        },
    } satisfies DashboardWorkerRuntimeDependencies;
    return {
        coordinatorCompletion,
        dependencies,
        events,
        forceSignals,
    };
}

describe("Dashboard worker runtime", () => {
    test("owns database then coordinator and disposes them in reverse order", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            runtimeOptions,
            fixture.dependencies
        );
        const force = new AbortController();

        await runtime.initialize();
        await runtime.dispose(force.signal);

        expect(fixture.events).toEqual([
            "database-initialize",
            "repository-create",
            "coordinator-create",
            "coordinator-initialize",
            "coordinator-dispose",
            "database-dispose",
        ]);
        expect(fixture.forceSignals).toEqual([force.signal]);
        expect(await runtime.completion).toBeUndefined();
    });

    test("exposes an unexpected coordinator failure through completion", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            runtimeOptions,
            fixture.dependencies
        );
        const failure = new Error("coordinator failed");

        await runtime.initialize();
        fixture.coordinatorCompletion.reject(failure);

        expect(await runtime.completion.catch((error: unknown) => error)).toBe(failure);
        await runtime.dispose();
    });

    test("preserves initialization failure and still releases the database", async () => {
        const failure = new Error("coordinator initialization failed");
        const fixture = runtimeFixture(failure);
        const runtime = createDashboardWorkerRuntime(
            runtimeOptions,
            fixture.dependencies
        );
        const completion = runtime.completion.catch((error: unknown) => error);

        expect(await runtime.initialize().catch((error: unknown) => error)).toBe(failure);
        expect(await completion).toBe(failure);
        expect(fixture.events).toContain("database-dispose");
    }, 1000);
});
