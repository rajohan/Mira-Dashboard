import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { TaskNotificationQueue } from "../../../shared/taskNotifications.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import type { RuntimeOwnedDatabase } from "../../database/runtime/databaseService.ts";
import type { PersistentGatewayTaskNotificationTransport } from "../../platform/gateway/persistentGatewayTransport.ts";
import { testMoltbookCollector } from "../../test/support/moltbook.ts";
import type { CacheRepository } from "../cache/repository.ts";
import type { JobWorkerCoordinator } from "./coordinator.ts";
import type { JobRepository } from "./repository.ts";
import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
    type DashboardWorkerRuntimeDependencies,
    type DashboardWorkerRuntimeOptions,
} from "./workerRuntime.ts";

const noSideEffects = Object.freeze({
    auditEvents: Object.freeze([]),
    realtimeEvents: Object.freeze([]),
});

const baseRuntimeOptions = {
    database: {
        migrationsDirectory: "/srv/mira-dashboard/releases/test/migrations",
        releaseId: "a".repeat(40),
        startupMode: "validate-only",
        stateDirectory: "/srv/mira-dashboard/state",
    },
    logMaintenance: Object.freeze({
        run: () => Promise.resolve(undefined),
    }),
    moltbook: testMoltbookCollector,
    openClawGateway: Object.freeze({
        restart: () => Promise.resolve(),
    }),
    pid: 123,
    releaseId: "a".repeat(40),
    sideEffects: {
        forQueue: () => noSideEffects,
        forRun: () => noSideEffects,
        forRunEvent: () => noSideEffects,
        forSchedule: () => noSideEffects,
        forScheduleEvent: () => noSideEffects,
    },
    workerInstanceId: Bun.randomUUIDv7(),
} satisfies Omit<
    DashboardWorkerRuntimeOptions,
    "persistentGatewayTransport" | "taskNotificationLoop"
>;

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
    const cacheRepository = Object.freeze({}) as CacheRepository;
    const notificationQueue = Object.freeze({
        claim: () => Promise.resolve([]),
        markDelivered: () => Promise.resolve(true),
        retryLater: () => Promise.resolve(true),
    } satisfies TaskNotificationQueue);
    const taskNotificationSender = Object.freeze({
        send: () => Promise.resolve(),
    });
    let dieNotificationLoop: ((error: unknown) => void) | undefined;
    const persistentGatewayTransport = Object.freeze({
        start() {
            events.push("gateway-start");
        },
        stop() {
            events.push("gateway-stop");
            return Promise.resolve();
        },
        taskNotificationSender,
    } satisfies PersistentGatewayTaskNotificationTransport);
    const options: DashboardWorkerRuntimeOptions = {
        ...baseRuntimeOptions,
        persistentGatewayTransport,
        taskNotificationLoop(loopDependencies) {
            expect(loopDependencies).toEqual({
                queue: notificationQueue,
                sender: taskNotificationSender,
                workerId: baseRuntimeOptions.workerInstanceId,
            });
            return Effect.callback<never, unknown>((resume) => {
                events.push("notification-loop-start");
                dieNotificationLoop = (error) => resume(Effect.die(error));
                return Effect.sync(() => {
                    events.push("notification-claim-settled");
                });
            });
        },
    };
    const dependencies = {
        createCacheRepository() {
            events.push("cache-repository-create");
            return cacheRepository;
        },
        createCoordinator(options) {
            events.push("coordinator-create");
            expect(options.repository).toBe(repository);
            expect(options.commitCacheAttempt).toBeFunction();
            expect(options.findAction?.("maintenance.rotate-logs")).toBeDefined();
            const actionKeys = options.actionDefinitions?.map(
                (definition) => definition.actionKey
            );
            if (actionKeys === undefined) {
                throw new Error("Worker action definitions were not provided");
            }
            expect(new Set(actionKeys).size).toBe(actionKeys.length);
            expect(
                actionKeys.filter((key) => key === "openclaw.gateway.restart")
            ).toHaveLength(1);
            expect(options.findAction?.("openclaw.gateway.restart")).toMatchObject({
                cancellationPolicy: "never",
                resourceClass: "exclusive",
                retrySafe: false,
            });
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
                        database: Object.freeze({}) as RuntimeOwnedDatabase,
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
        createTaskNotificationQueue(database) {
            events.push("notification-queue-create");
            expect(database).toBeDefined();
            return notificationQueue;
        },
    } satisfies DashboardWorkerRuntimeDependencies;
    return {
        coordinatorCompletion,
        dependencies,
        events,
        dieNotificationLoop(error: unknown) {
            const die = dieNotificationLoop;
            if (die === undefined) {
                throw new Error("Task notification loop has not started");
            }
            die(error);
        },
        forceSignals,
        options,
    };
}

describe("Dashboard worker runtime", () => {
    test("emits created only for explicit run-creation actions", () => {
        const sideEffects = createSystemJobWorkerSideEffects();
        const at = new Date(1000);
        const eventRunId = Bun.randomUUIDv7();

        for (const action of ["jobs.run.enqueue", "jobs.run.enqueue-scheduled"]) {
            expect(
                sideEffects.forRun({
                    action,
                    at,
                    outcome: "accepted",
                    targetId: Bun.randomUUIDv7(),
                }).realtimeEvents[0]?.operation
            ).toBe("created");
        }
        expect(
            sideEffects.forRun({
                action: "jobs.run.enqueue-retry-observed",
                at,
                outcome: "accepted",
                targetId: Bun.randomUUIDv7(),
            }).realtimeEvents[0]?.operation
        ).toBe("updated");
        expect(
            sideEffects.forRunEvent({
                action: "jobs.run.event",
                at,
                outcome: "accepted",
                targetId: eventRunId,
            })
        ).toEqual({
            auditEvents: [],
            realtimeEvents: [
                expect.objectContaining({
                    entityId: eventRunId,
                    operation: "updated",
                    topic: "jobs.runs",
                }),
            ],
        });
        const scheduleId = "system.worker-smoke";
        expect(
            sideEffects.forScheduleEvent({
                action: "jobs.run.succeeded",
                at,
                outcome: "succeeded",
                targetId: scheduleId,
            })
        ).toEqual({
            auditEvents: [],
            realtimeEvents: [
                expect.objectContaining({
                    entityId: scheduleId,
                    operation: "updated",
                    topic: "schedules.records",
                }),
            ],
        });
    });

    test("starts after database initialization and settles notifications before shutdown", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            fixture.options,
            fixture.dependencies
        );
        const force = new AbortController();

        await runtime.initialize();
        await runtime.dispose(force.signal);

        expect(fixture.events).toEqual([
            "database-initialize",
            "repository-create",
            "cache-repository-create",
            "coordinator-create",
            "notification-queue-create",
            "coordinator-initialize",
            "gateway-start",
            "notification-loop-start",
            "notification-claim-settled",
            "coordinator-dispose",
            "gateway-stop",
            "database-dispose",
        ]);
        expect(fixture.forceSignals).toEqual([force.signal]);
        expect(await runtime.completion).toBeUndefined();
    });

    test("registers and disposes the worker-only workspace writer", async () => {
        const fixture = runtimeFixture();
        const options: DashboardWorkerRuntimeOptions = {
            ...fixture.options,
            workspaceFiles: Object.freeze({
                apply: () =>
                    Promise.resolve({
                        modifiedAtMs: 1,
                        revision: "a".repeat(64),
                        sizeBytes: 0,
                    }),
                removeSettledReplacementIntent: () => Promise.resolve(),
                dispose() {
                    fixture.events.push("workspace-files-dispose");
                },
            }),
        };
        const dependencies: DashboardWorkerRuntimeDependencies = {
            ...fixture.dependencies,
            createCoordinator(coordinatorOptions) {
                expect(
                    coordinatorOptions.findAction?.("workspace-files.apply-write")
                ).toBeDefined();
                expect(
                    coordinatorOptions.findAction?.("workspace-files.apply-replacement")
                ).toBeDefined();
                return fixture.dependencies.createCoordinator(coordinatorOptions);
            },
        };
        const runtime = createDashboardWorkerRuntime(options, dependencies);

        await runtime.initialize();
        await runtime.dispose();

        expect(fixture.events.indexOf("coordinator-dispose")).toBeLessThan(
            fixture.events.indexOf("workspace-files-dispose")
        );
        expect(fixture.events.indexOf("workspace-files-dispose")).toBeLessThan(
            fixture.events.indexOf("gateway-stop")
        );
    });

    test("forces teardown when durable notification release stalls", async () => {
        const fixture = runtimeFixture();
        const retryStarted = deferred<void>();
        const stuckRetry = new Promise<boolean>(() => {});
        const notificationQueue = Object.freeze({
            claim: () => Promise.resolve([]),
            markDelivered: () => Promise.resolve(true),
            retryLater: () => {
                fixture.events.push("notification-retry-start");
                retryStarted.resolve(undefined);
                return stuckRetry;
            },
        } satisfies TaskNotificationQueue);
        const options: DashboardWorkerRuntimeOptions = {
            ...fixture.options,
            taskNotificationLoop(dependencies) {
                return Effect.never.pipe(
                    Effect.onInterrupt(() =>
                        Effect.promise(() =>
                            dependencies.queue.retryLater({
                                availableAtMs: 5000,
                                eventId: "019fd300-0000-7000-8000-000000000001",
                                settledAtMs: 0,
                                workerId: baseRuntimeOptions.workerInstanceId,
                            })
                        ).pipe(Effect.asVoid)
                    )
                );
            },
        };
        const dependencies: DashboardWorkerRuntimeDependencies = {
            ...fixture.dependencies,
            createTaskNotificationQueue() {
                fixture.events.push("notification-queue-create");
                return notificationQueue;
            },
        };
        const runtime = createDashboardWorkerRuntime(options, dependencies);
        const force = new AbortController();

        await runtime.initialize();
        const disposal = runtime.dispose(force.signal);
        await retryStarted.promise;
        expect(fixture.events).not.toContain("coordinator-dispose");
        expect(
            await Promise.race([
                disposal.then(() => "settled" as const),
                Bun.sleep(10).then(() => "waiting" as const),
            ])
        ).toBe("waiting");

        force.abort(new DOMException("Forced process shutdown requested", "AbortError"));
        await disposal;

        expect(fixture.events.slice(-4)).toEqual([
            "notification-retry-start",
            "coordinator-dispose",
            "gateway-stop",
            "database-dispose",
        ]);
        expect(fixture.forceSignals).toEqual([force.signal]);
        expect(await runtime.completion).toBeUndefined();
    });

    test("stops uninitialized ownership without starting external work", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            fixture.options,
            fixture.dependencies
        );

        await runtime.dispose();

        expect(fixture.events).toEqual(["gateway-stop", "database-dispose"]);
        expect(await runtime.completion).toBeUndefined();
        expect(runtime.initialize()).rejects.toEqual(
            new Error("Dashboard worker runtime is disposed")
        );
    });

    test("exposes an unexpected coordinator failure through completion", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            fixture.options,
            fixture.dependencies
        );
        const failure = new Error("coordinator failed");

        await runtime.initialize();
        fixture.coordinatorCompletion.reject(failure);

        expect(await runtime.completion.catch((error: unknown) => error)).toBe(failure);
        await runtime.dispose();
    });

    test("exposes a task notification loop defect through completion", async () => {
        const fixture = runtimeFixture();
        const runtime = createDashboardWorkerRuntime(
            fixture.options,
            fixture.dependencies
        );
        const failure = new Error("task notification loop failed");

        await runtime.initialize();
        fixture.dieNotificationLoop(failure);

        expect(await runtime.completion.catch((error: unknown) => error)).toBe(failure);
        await runtime.dispose().catch(() => {});
        expect(fixture.events.indexOf("gateway-stop")).toBeLessThan(
            fixture.events.indexOf("database-dispose")
        );
    });

    test("preserves initialization failure and still releases the database", async () => {
        const failure = new Error("coordinator initialization failed");
        const fixture = runtimeFixture(failure);
        const runtime = createDashboardWorkerRuntime(
            fixture.options,
            fixture.dependencies
        );
        const completion = runtime.completion.catch((error: unknown) => error);

        expect(await runtime.initialize().catch((error: unknown) => error)).toBe(failure);
        expect(await completion).toBe(failure);
        expect(fixture.events.slice(-3)).toEqual([
            "coordinator-dispose",
            "gateway-stop",
            "database-dispose",
        ]);
        expect(fixture.events).not.toContain("gateway-start");
        expect(fixture.events).not.toContain("notification-loop-start");
    }, 1000);
});
