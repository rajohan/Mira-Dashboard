import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { secondsToMilliseconds } from "date-fns";
import { Effect, Layer, Stream } from "effect";

import { createServer } from "../../../app/server.ts";
import { createStructuredLogger } from "../../platform/observability/structuredLogger.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { RealtimeEventPump } from "../../platform/realtime/eventPump.ts";
import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import {
    ApplicationListenerStopTimeoutError,
    createApplicationRuntime,
    createDashboardApplicationRuntime,
} from "../../platform/runtime/applicationRuntime.ts";
import { migrationsDirectory } from "../support/freshDatabase.ts";
import { captureFailure } from "../support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestServerSecurityServices,
    createTestStructuredLogger,
} from "../support/requestContext.ts";

function createPendingBunServer(resolveWhenForced = true): {
    readonly gracefulStarted: Promise<void>;
    readonly server: ReturnType<typeof Bun.serve>;
    readonly stopCalls: boolean[];
} {
    const gracefulStop = Promise.withResolvers<void>();
    const gracefulStarted = Promise.withResolvers<void>();
    const stopCalls: boolean[] = [];
    const server = {
        port: 3100,
        stop(force = false) {
            stopCalls.push(force);
            if (force && resolveWhenForced) {
                gracefulStop.resolve();
            } else if (!force) {
                gracefulStarted.resolve();
            }
            return gracefulStop.promise;
        },
        url: new URL("http://127.0.0.1:3100"),
    } as unknown as ReturnType<typeof Bun.serve>;
    return { gracefulStarted: gracefulStarted.promise, server, stopCalls };
}

function createShutdownTestRuntime(onDispose: () => void) {
    const service = RealtimeEventPumpService.of({
        metricsSnapshot: Effect.die("Shutdown tests do not use realtime metrics"),
        stream: () => Stream.empty,
        wake: Effect.void,
    });
    const scopedService = Effect.acquireRelease(Effect.succeed(service), () =>
        Effect.sync(onDispose)
    );
    const layer = Layer.effect(RealtimeEventPumpService, scopedService);
    return createApplicationRuntime({
        logger: createTestStructuredLogger(),
        realtimeEventPumpLayer: layer,
    });
}

describe("application server shutdown", () => {
    test("withdraws readiness before listener drain begins", async () => {
        const fake = createPendingBunServer();
        const readiness = createReadinessController();
        readiness.markReady();
        const observedReadiness: boolean[] = [];
        const originalStop = fake.server.stop.bind(fake.server);
        const serverWithObservedStop = {
            ...fake.server,
            stop(force = false) {
                observedReadiness.push(readiness.isReady());
                return originalStop(force);
            },
        } as ReturnType<typeof Bun.serve>;
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(serverWithObservedStop);

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime: createShutdownTestRuntime(() => {}),
                port: 3100,
                readiness,
            });

            const gracefulStop = server.stop();
            await fake.gracefulStarted;

            expect(readiness.isReady()).toBe(false);
            expect(observedReadiness).toEqual([false]);

            expect(server.stop(true)).toBe(gracefulStop);
            await gracefulStop;
        } finally {
            serveSpy.mockRestore();
        }
    });

    test("flushes the process logger after runtime disposal", async () => {
        const fake = createPendingBunServer();
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fake.server);
        const order: string[] = [];
        const logger = createStructuredLogger({
            identity: {
                bun: "1.4.0-test",
                pid: 123,
                processRole: "web",
                release: "server-shutdown-test",
                service: "mira-dashboard",
            },
            sink: {
                flush() {
                    order.push("logger-flush");
                },
                write() {},
            },
        });

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime: createTestApplicationRuntime({
                    dispose() {
                        order.push("runtime-dispose");
                        return Promise.resolve();
                    },
                    logger,
                }),
                port: 3100,
                readiness: createReadinessController(),
            });

            await server.stop(true);

            expect(order).toEqual(["runtime-dispose", "logger-flush"]);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test("closes listener, realtime, database, and logger in dependency order", async () => {
        const stateDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-shutdown-order-")
        );
        await chmod(stateDirectory, 0o700);
        const order: string[] = [];
        const fake = createPendingBunServer();
        const originalStop = fake.server.stop.bind(fake.server);
        const serverWithObservedStop = {
            ...fake.server,
            stop(force = false) {
                order.push("listener-stop");
                return originalStop(force);
            },
        } as ReturnType<typeof Bun.serve>;
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(serverWithObservedStop);
        const originalPumpClose = Object.getOwnPropertyDescriptor(
            RealtimeEventPump.prototype,
            "close"
        )?.value as (this: RealtimeEventPump) => void;
        const originalDatabaseClose = Object.getOwnPropertyDescriptor(
            Database.prototype,
            "close"
        )?.value as (this: Database, throwOnError?: boolean) => void;
        const databaseFilePath = path.join(stateDirectory, "mira-dashboard.db");
        const pumpCloseSpy = spyOn(
            RealtimeEventPump.prototype,
            "close"
        ).mockImplementation(function (this: RealtimeEventPump) {
            order.push("realtime-close");
            return originalPumpClose.call(this);
        });
        const databaseCloseSpy = spyOn(Database.prototype, "close").mockImplementation(
            function (this: Database, throwOnError?: boolean) {
                if (this.filename === databaseFilePath) order.push("database-close");
                return originalDatabaseClose.call(this, throwOnError);
            }
        );
        const logger = createStructuredLogger({
            identity: {
                bun: "1.4.0-test",
                pid: 123,
                processRole: "web",
                release: "server-database-shutdown-test",
                service: "mira-dashboard",
            },
            sink: {
                flush() {
                    order.push("logger-flush");
                },
                write() {},
            },
        });
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger,
        });

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime,
                port: 3100,
                readiness: createReadinessController(),
            });
            await server.stop(true);

            expect(order).toEqual([
                "listener-stop",
                "realtime-close",
                "database-close",
                "logger-flush",
            ]);
        } finally {
            try {
                await applicationRuntime.dispose();
            } finally {
                databaseCloseSpy.mockRestore();
                pumpCloseSpy.mockRestore();
                serveSpy.mockRestore();
                await rm(stateDirectory, { force: true, recursive: true });
            }
        }
    });

    test("forces immediately when the first stop request is forced", async () => {
        const fake = createPendingBunServer();
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fake.server);
        let disposals = 0;

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime: createShutdownTestRuntime(() => {
                    disposals += 1;
                }),
                authenticationLifecycle: createTestAuthenticationLifecycleService(),
                authenticateCredential: () => ({
                    authentication: { kind: "anonymous" },
                }),
                port: 3100,
                readiness: createReadinessController(),
            });
            const forcedStop = server.stop(true);

            expect(server.stop()).toBe(forcedStop);
            await forcedStop;
            expect(server.stop(true)).toBe(forcedStop);
            expect(fake.stopCalls).toEqual([true]);
            expect(disposals).toBe(1);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test.each([
        {
            forceAfterGracefulStart: false,
            timeoutMs: 1,
            trigger: "bounded deadline",
        },
        {
            forceAfterGracefulStart: true,
            timeoutMs: secondsToMilliseconds(30),
            trigger: "explicit force escalation",
        },
    ])("forces a pending graceful stop after $trigger", async (scenario) => {
        const fake = createPendingBunServer();
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fake.server);
        let disposals = 0;
        let stopCallsAtDisposal: readonly boolean[] = [];

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime: createShutdownTestRuntime(() => {
                    disposals += 1;
                    stopCallsAtDisposal = [...fake.stopCalls];
                }),
                authenticationLifecycle: createTestAuthenticationLifecycleService(),
                authenticateCredential: () => ({
                    authentication: { kind: "anonymous" },
                }),
                gracefulShutdownTimeoutMs: scenario.timeoutMs,
                port: 3100,
                readiness: createReadinessController(),
            });
            const gracefulStop = server.stop();
            if (scenario.forceAfterGracefulStart) {
                await fake.gracefulStarted;
                expect(server.stop(true)).toBe(gracefulStop);
            }

            await gracefulStop;

            expect(server.stop(true)).toBe(gracefulStop);
            expect(fake.stopCalls).toEqual([false, true]);
            expect(disposals).toBe(1);
            expect(stopCallsAtDisposal).toEqual([false, true]);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test("preserves runtime services when listener escalation remains unsettled", async () => {
        const fake = createPendingBunServer(false);
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fake.server);
        const readiness = createReadinessController();
        readiness.markReady();
        let disposals = 0;
        const applicationRuntime = createShutdownTestRuntime(() => {
            disposals += 1;
        });

        try {
            const server = await createServer({
                ...createTestServerSecurityServices(),
                applicationRuntime,
                authenticationLifecycle: createTestAuthenticationLifecycleService(),
                authenticateCredential: () => ({
                    authentication: { kind: "anonymous" },
                }),
                gracefulShutdownTimeoutMs: 1,
                port: 3100,
                readiness,
            });

            const failure = await captureFailure(() => server.stop());

            expect(failure).toBeInstanceOf(ApplicationListenerStopTimeoutError);
            expect(readiness.isReady()).toBe(false);
            expect(fake.stopCalls).toEqual([false, true]);
            expect(disposals).toBe(0);
        } finally {
            await applicationRuntime.dispose();
            serveSpy.mockRestore();
        }
        expect(disposals).toBe(1);
    });

    test("preserves a startup failure when runtime disposal also fails", async () => {
        const startupError = new Error("simulated listener startup failure");
        const disposalError = new Error("simulated runtime disposal failure");
        const serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
            throw startupError;
        });
        let disposals = 0;

        try {
            const failure = await captureFailure(() =>
                createServer({
                    ...createTestServerSecurityServices(),
                    applicationRuntime: createTestApplicationRuntime({
                        dispose: () => {
                            disposals += 1;
                            return Promise.reject(disposalError);
                        },
                    }),
                    authenticationLifecycle: createTestAuthenticationLifecycleService(),
                    authenticateCredential: () => ({
                        authentication: { kind: "anonymous" },
                    }),
                    port: 3100,
                    readiness: createReadinessController(),
                })
            );

            expect(failure).toBe(startupError);
            expect(disposals).toBe(1);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test.each([{ timeoutMs: 0 }, { timeoutMs: secondsToMilliseconds(61) }])(
        "rejects invalid shutdown timeout $timeoutMs before opening the listener",
        async ({ timeoutMs }) => {
            const serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
                throw new Error("Bun.serve must not receive invalid shutdown policy");
            });
            let disposals = 0;
            let initializations = 0;

            try {
                const failure = await captureFailure(() =>
                    createServer({
                        ...createTestServerSecurityServices(),
                        applicationRuntime: createTestApplicationRuntime({
                            dispose: () => {
                                disposals += 1;
                                return Promise.resolve();
                            },
                            initialize: () => {
                                initializations += 1;
                                return Promise.resolve();
                            },
                        }),
                        authenticationLifecycle:
                            createTestAuthenticationLifecycleService(),
                        authenticateCredential: () => ({
                            authentication: { kind: "anonymous" },
                        }),
                        gracefulShutdownTimeoutMs: timeoutMs,
                        port: 3100,
                        readiness: createReadinessController(),
                    })
                );

                expect(failure).toBeInstanceOf(Error);
                expect(initializations).toBe(0);
                expect(disposals).toBe(1);
                expect(serveSpy).not.toHaveBeenCalled();
            } finally {
                serveSpy.mockRestore();
            }
        }
    );
});
