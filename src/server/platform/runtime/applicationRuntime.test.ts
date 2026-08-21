import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addMilliseconds, secondsToMilliseconds } from "date-fns";
import { maxTime } from "date-fns/constants";
import { Effect, Layer, Logger, Stream } from "effect";

import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import {
    captureFailure,
    rejectOnAbort,
    withTestTimeout,
} from "../../test/support/promise.ts";
import { createTestStructuredLogger } from "../../test/support/requestContext.ts";
import { createStructuredLogger } from "../observability/structuredLogger.ts";
import type { RealtimeEventDelivery } from "../realtime/eventPump.ts";
import {
    isRealtimeEventStreamError,
    RealtimeEventPumpService,
    RealtimeEventStoreStreamError,
} from "../realtime/eventPumpService.ts";
import type { RenewableStreamLease } from "../realtime/renewableStreamLease.ts";
import {
    ApplicationListenerStopError,
    ApplicationListenerStopTimeoutError,
    createApplicationRuntime,
    createDashboardApplicationRuntime,
} from "./applicationRuntime.ts";

const delivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: "monitoring.reports",
    },
    id: "1",
    kind: "change",
};

const stableLease: RenewableStreamLease = {
    expiresAtMs: maxTime,
    renew: () => Promise.resolve(stableLease),
};

const testStructuredLogger = createTestStructuredLogger();

function createInertApplicationRuntime() {
    const service = RealtimeEventPumpService.of({
        metricsSnapshot: Effect.die("Realtime metrics are not used"),
        stream: () => Stream.empty,
        wake: Effect.void,
    });
    return createApplicationRuntime({
        logger: testStructuredLogger,
        realtimeEventPumpLayer: Layer.succeed(RealtimeEventPumpService, service),
    });
}

describe("application Effect runtime", () => {
    test("retains sanitized database diagnostics behind the composition accessor", async () => {
        const stateDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-diagnostics-runtime-")
        );
        await chmod(stateDirectory, 0o700);
        const runtime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: testStructuredLogger,
        });

        try {
            await runtime.initialize();
            const first = await runtime.database.diagnostics();
            const second = await runtime.database.diagnostics();

            expect(first).toMatchObject({
                appliedMigrations: first.migrationCount,
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
                migrationCount: first.migrationCount,
                sqlite: {
                    permissions: {
                        dataDirectory: "0700",
                        database: "0600",
                        secure: true,
                    },
                },
                startupMode: "initialize-empty",
            });
            expect(first.sqlite.databaseBytes).toBeGreaterThan(0);
            expect(first.sqlite.pageCount).toBeGreaterThan(0);
            expect(first.sqlite.pageSizeBytes).toBeGreaterThanOrEqual(512);
            expect(first.sqlite.freePages).toBeLessThanOrEqual(first.sqlite.pageCount);
            expect(first.sqlite.freeBytes).toBe(
                first.sqlite.freePages * first.sqlite.pageSizeBytes
            );
            expect(first.sqlite.storageBytes).toBe(
                first.sqlite.databaseBytes + first.sqlite.walBytes + first.sqlite.shmBytes
            );
            expect(second.sqlite.permissions).toEqual(first.sqlite.permissions);
            expect(JSON.stringify(first)).not.toContain(stateDirectory);
        } finally {
            try {
                await runtime.dispose();
            } finally {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        }
    });

    test("installs the supplied structured logger without the default Effect logger", async () => {
        const lines: string[] = [];
        const logger = createStructuredLogger({
            identity: {
                bun: "test-bun",
                pid: 1,
                processRole: "web",
                release: "test-release",
                service: "mira-dashboard",
            },
            sink: {
                write(line) {
                    lines.push(line);
                },
            },
        });
        let activeLoggerCount = 0;
        let includesDefaultLogger = true;
        const service = RealtimeEventPumpService.of({
            metricsSnapshot: Effect.die("Realtime metrics are not used"),
            stream: () =>
                Stream.fromEffect(
                    Effect.gen(function* () {
                        const activeLoggers = yield* Effect.service(
                            Logger.CurrentLoggers
                        );
                        activeLoggerCount = activeLoggers.size;
                        includesDefaultLogger = activeLoggers.has(Logger.defaultLogger);
                        yield* Effect.logInfo("ignored runtime logger message").pipe(
                            Effect.annotateLogs({
                                component: "application-runtime",
                                event: "runtime.logger.connected",
                            })
                        );
                        return delivery;
                    })
                ),
            wake: Effect.void,
        });
        const runtime = createApplicationRuntime({
            logger,
            realtimeEventPumpLayer: Layer.succeed(RealtimeEventPumpService, service),
        });

        try {
            await runtime.initialize();
            expect(runtime.logger).toBe(logger);
            const deliveries = await runtime.services.realtimeEvents.stream(
                { afterId: "0" },
                stableLease
            );

            expect(await Array.fromAsync(deliveries)).toEqual([delivery]);
            expect(activeLoggerCount).toBe(1);
            expect(includesDefaultLogger).toBe(false);
            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
                component: "application-runtime",
                event: "runtime.logger.connected",
                level: "info",
            });
            expect(lines[0]).not.toContain("ignored runtime logger message");
        } finally {
            await runtime.dispose();
        }
    });

    test("coordinates graceful listener completion on the shared runtime", async () => {
        const runtime = createInertApplicationRuntime();
        const stopCalls: boolean[] = [];

        try {
            await runtime.initialize();
            await runtime.shutdownListener({
                forceSignal: new AbortController().signal,
                gracefulShutdownTimeoutMs: 100,
                stop(force) {
                    stopCalls.push(force);
                    return Promise.resolve();
                },
            });

            expect(stopCalls).toEqual([false]);
        } finally {
            await runtime.dispose();
        }
    });

    test("escalates an active graceful listener stop when force is requested", async () => {
        const runtime = createInertApplicationRuntime();
        const controller = new AbortController();
        const gracefulStarted = Promise.withResolvers<void>();
        const gracefulStop = Promise.withResolvers<void>();
        const forceCompleted = Promise.withResolvers<void>();
        const stopCalls: boolean[] = [];
        let shutdownSettled = false;

        try {
            const shutdown = runtime.shutdownListener({
                forceSignal: controller.signal,
                gracefulShutdownTimeoutMs: 100,
                stop(force) {
                    stopCalls.push(force);
                    if (force) {
                        forceCompleted.resolve();
                        return Promise.resolve();
                    } else {
                        gracefulStarted.resolve();
                        return gracefulStop.promise;
                    }
                },
            });
            void shutdown.then(() => (shutdownSettled = true));
            await gracefulStarted.promise;
            controller.abort();
            await forceCompleted.promise;
            await Promise.resolve();

            expect(shutdownSettled).toBe(false);
            gracefulStop.resolve();
            await shutdown;

            expect(stopCalls).toEqual([false, true]);
        } finally {
            await runtime.dispose();
        }
    });

    test("preserves a graceful listener failure after best-effort force", async () => {
        const runtime = createInertApplicationRuntime();
        const gracefulFailure = new Error("simulated graceful listener failure");
        const forceFailure = new Error("simulated force listener failure");
        const stopCalls: boolean[] = [];

        try {
            const failure = await captureFailure(() =>
                runtime.shutdownListener({
                    forceSignal: new AbortController().signal,
                    gracefulShutdownTimeoutMs: 100,
                    stop(force) {
                        stopCalls.push(force);
                        return Promise.reject(force ? forceFailure : gracefulFailure);
                    },
                })
            );

            expect(failure).toBeInstanceOf(ApplicationListenerStopError);
            expect(failure).toMatchObject({
                cause: gracefulFailure,
                operation: "graceful",
            });
            expect(stopCalls).toEqual([false, true]);
        } finally {
            await runtime.dispose();
        }
    });

    test("tags a forced listener stop that exceeds its deadline", async () => {
        const runtime = createInertApplicationRuntime();
        const controller = new AbortController();
        controller.abort();

        try {
            const failure = await captureFailure(() =>
                runtime.shutdownListener({
                    forceSignal: controller.signal,
                    gracefulShutdownTimeoutMs: 1,
                    stop: () => new Promise<void>(() => {}),
                })
            );

            expect(failure).toBeInstanceOf(ApplicationListenerStopTimeoutError);
            expect(failure).toMatchObject({ operation: "force", timeoutMs: 1 });
        } finally {
            await runtime.dispose();
        }
    });

    test("gives forced stop a fresh budget after graceful draining expires", async () => {
        const runtime = createInertApplicationRuntime();
        const gracefulStop = Promise.withResolvers<void>();
        const stopCalls: boolean[] = [];

        try {
            await runtime.shutdownListener({
                forceSignal: new AbortController().signal,
                gracefulShutdownTimeoutMs: 30,
                stop(force) {
                    stopCalls.push(force);
                    if (!force) return gracefulStop.promise;
                    return Bun.sleep(5).then(() => gracefulStop.resolve());
                },
            });

            expect(stopCalls).toEqual([false, true]);
        } finally {
            await runtime.dispose();
        }
    });

    test("gives graceful settlement a fresh budget after forced stop", async () => {
        const runtime = createInertApplicationRuntime();
        const gracefulStop = Promise.withResolvers<void>();
        const stopCalls: boolean[] = [];

        try {
            await runtime.shutdownListener({
                forceSignal: new AbortController().signal,
                gracefulShutdownTimeoutMs: 30,
                stop(force) {
                    stopCalls.push(force);
                    if (!force) return gracefulStop.promise;
                    void Bun.sleep(5).then(() => gracefulStop.resolve());
                    return Promise.resolve();
                },
            });

            expect(stopCalls).toEqual([false, true]);
        } finally {
            await runtime.dispose();
        }
    });

    test("tags missing graceful settlement after a successful force stop", async () => {
        const runtime = createInertApplicationRuntime();
        const controller = new AbortController();
        const gracefulStarted = Promise.withResolvers<void>();
        const stopCalls: boolean[] = [];

        try {
            const shutdown = runtime.shutdownListener({
                forceSignal: controller.signal,
                gracefulShutdownTimeoutMs: 1,
                stop(force) {
                    stopCalls.push(force);
                    if (!force) gracefulStarted.resolve();
                    return force ? Promise.resolve() : new Promise<void>(() => {});
                },
            });
            await gracefulStarted.promise;
            controller.abort();
            const failure = await captureFailure(() => shutdown);

            expect(failure).toBeInstanceOf(ApplicationListenerStopTimeoutError);
            expect(failure).toMatchObject({
                operation: "graceful-settlement",
                timeoutMs: 1,
            });
            expect(stopCalls).toEqual([false, true]);
        } finally {
            await runtime.dispose();
        }
    });

    test("builds one shared layer and disposes its scope exactly once", async () => {
        let acquisitions = 0;
        let releases = 0;
        let observedSignal: AbortSignal | undefined;
        const layer = Layer.effect(
            RealtimeEventPumpService,
            Effect.acquireRelease(
                Effect.sync(() => {
                    acquisitions += 1;
                    return RealtimeEventPumpService.of({
                        metricsSnapshot: Effect.die("metrics are not used in this test"),
                        stream: (options) => {
                            observedSignal = options.signal;
                            return Stream.make(delivery);
                        },
                        wake: Effect.void,
                    });
                }),
                () =>
                    Effect.sync(() => {
                        releases += 1;
                    })
            )
        );
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: layer,
        });
        const controller = new AbortController();

        await runtime.initialize();
        await runtime.initialize();
        expect(acquisitions).toBe(1);
        expect(Object.isFrozen(runtime)).toBe(true);
        expect(Object.isFrozen(runtime.services)).toBe(true);
        expect(Object.isFrozen(runtime.services.realtimeEvents)).toBe(true);
        expect(Object.isFrozen(runtime.services.systemMetrics)).toBe(true);

        const values = await Array.fromAsync(
            await runtime.services.realtimeEvents.stream(
                {
                    afterId: "0",
                    signal: controller.signal,
                },
                stableLease
            )
        );
        expect(values).toEqual([delivery]);
        expect(observedSignal).toBe(controller.signal);

        await runtime.dispose();
        await runtime.dispose();
        expect(releases).toBe(1);
    });

    test("preserves typed failures across the async-iterator boundary", async () => {
        const expected = new RealtimeEventStoreStreamError({
            message: "simulated event-store failure",
        });
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => Stream.fail(expected),
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: layer,
        });
        let observed: unknown;

        try {
            const deliveries = await runtime.services.realtimeEvents.stream(
                { afterId: "0" },
                stableLease
            );
            await Array.fromAsync(deliveries);
        } catch (error) {
            observed = error;
        } finally {
            await runtime.dispose();
        }

        expect(observed).toBe(expected);
        expect(isRealtimeEventStreamError(observed)).toBe(true);
    });

    test("completes without opening the source for a pre-aborted signal", async () => {
        let sourcePulls = 0;
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () =>
                    Stream.fromEffect(
                        Effect.sync(() => {
                            sourcePulls += 1;
                            return delivery;
                        })
                    ),
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: layer,
        });
        const controller = new AbortController();
        controller.abort();

        try {
            const deliveries = await runtime.services.realtimeEvents.stream(
                { afterId: "0", signal: controller.signal },
                stableLease
            );

            expect(await Array.fromAsync(deliveries)).toEqual([]);
            expect(sourcePulls).toBe(0);
        } finally {
            await runtime.dispose();
        }
    });

    test("releases a subscription scope when an async consumer stops early", async () => {
        let acquisitions = 0;
        let releases = 0;
        const scopedDelivery = Effect.acquireRelease(
            Effect.sync(() => {
                acquisitions += 1;
                return delivery;
            }),
            () =>
                Effect.sync(() => {
                    releases += 1;
                })
        );
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => Stream.scoped(Stream.fromEffect(scopedDelivery)),
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: layer,
        });
        const deliveries = await runtime.services.realtimeEvents.stream(
            { afterId: "0" },
            stableLease
        );

        try {
            for await (const value of deliveries) {
                expect(value).toBe(delivery);
                break;
            }

            expect(acquisitions).toBe(1);
            expect(releases).toBe(1);
        } finally {
            await runtime.dispose();
        }
    });

    test("interrupts a quiet pull and its renewal when the client aborts", async () => {
        const leaseDurationMs = secondsToMilliseconds(1);
        const testTimeoutMs = secondsToMilliseconds(3);
        const sourceStarted = Promise.withResolvers<void>();
        const renewalStarted = Promise.withResolvers<AbortSignal>();
        let sourceReleases = 0;
        const sourceLease = Effect.acquireRelease(
            Effect.sync(() => {
                sourceStarted.resolve();
            }),
            () =>
                Effect.sync(() => {
                    sourceReleases += 1;
                })
        );
        const pendingSource = sourceLease.pipe(Effect.flatMap(() => Effect.never));
        const source = Stream.scoped(Stream.fromEffect(pendingSource));
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => source,
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: layer,
        });
        const controller = new AbortController();
        let iterator: AsyncIterator<RealtimeEventDelivery> | undefined;

        try {
            await runtime.initialize();
            const lease: RenewableStreamLease = {
                expiresAtMs: addMilliseconds(new Date(), leaseDurationMs).getTime(),
                renew(signal) {
                    renewalStarted.resolve(signal);
                    return rejectOnAbort<RenewableStreamLease>(
                        signal,
                        "Realtime lease renewal aborted"
                    );
                },
            };
            const deliveries = await runtime.services.realtimeEvents.stream(
                {
                    afterId: "0",
                    signal: controller.signal,
                },
                lease
            );
            iterator = deliveries[Symbol.asyncIterator]();
            const next = iterator.next();

            await withTestTimeout(
                sourceStarted.promise,
                testTimeoutMs,
                "quiet source pull did not start"
            );
            const renewalSignal = await withTestTimeout(
                renewalStarted.promise,
                testTimeoutMs,
                "quiet source pull was not revalidated"
            );
            controller.abort();
            const result = await withTestTimeout(
                next,
                testTimeoutMs,
                "client abort did not stop the realtime iterator"
            );

            expect(result.done).toBe(true);
            expect(renewalSignal.aborted).toBe(true);
            expect(sourceReleases).toBe(1);
        } finally {
            controller.abort();
            await iterator?.return?.();
            await runtime.dispose();
        }
    });
});
