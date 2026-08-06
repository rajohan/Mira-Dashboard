import { describe, expect, spyOn, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";
import { Effect, Layer, Stream } from "effect";

import { createServer } from "../../../app/server.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import {
    ApplicationListenerStopTimeoutError,
    createApplicationRuntime,
} from "../../platform/runtime/applicationRuntime.ts";
import { captureFailure } from "../support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestServerSecurityServices,
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
    return createApplicationRuntime({ realtimeEventPumpLayer: layer });
}

describe("application server shutdown", () => {
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
