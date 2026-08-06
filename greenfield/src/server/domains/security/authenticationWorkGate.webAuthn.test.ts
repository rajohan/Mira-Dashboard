import { describe, expect, test } from "bun:test";

import { Effect, Layer, Stream } from "effect";

import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { captureFailure } from "../../test/support/promise.ts";
import { createTestStructuredLogger } from "../../test/support/requestContext.ts";
import {
    type AuthenticationVerificationWorkOptions,
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkSettlementError,
    AuthenticationWorkTimeoutError,
} from "./authenticationWorkGate.ts";

const inertRealtimeLayer = Layer.succeed(
    RealtimeEventPumpService,
    RealtimeEventPumpService.of({
        metricsSnapshot: Effect.die("WebAuthn work tests do not use metrics"),
        stream: () => Stream.empty,
        wake: Effect.void,
    })
);

const testStructuredLogger = createTestStructuredLogger();

async function yieldToWorkService(): Promise<void> {
    await Bun.sleep(0);
}

function webAuthnRunner(runtime: ReturnType<typeof createApplicationRuntime>) {
    return <T>(
        work: (signal: AbortSignal) => Promise<T>,
        options: AuthenticationVerificationWorkOptions<T>
    ): Promise<T> =>
        runtime.services.authentication.runWebAuthnVerification(work, options);
}

describe("process WebAuthn verification work service", () => {
    test("uses an independent default two-active/four-queued gate", async () => {
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseActive = Promise.withResolvers<void>();
        const activeStarted = Promise.withResolvers<void>();
        let starts = 0;

        try {
            await runtime.initialize();
            const authentication = runtime.services.authentication;
            const runWebAuthn = (value: number): Promise<number> =>
                authentication.runWebAuthnVerification(
                    async (signal) => {
                        expect(signal.aborted).toBeFalse();
                        starts += 1;
                        if (starts === 2) activeStarted.resolve();
                        if (starts <= 2) await releaseActive.promise;
                        return value;
                    },
                    { timeoutMs: 5000 }
                );
            const active = [runWebAuthn(1), runWebAuthn(2)];
            await activeStarted.promise;
            const queued = [
                runWebAuthn(3),
                runWebAuthn(4),
                runWebAuthn(5),
                runWebAuthn(6),
            ];
            await yieldToWorkService();

            expect(starts).toBe(2);
            expect(
                await authentication.runGatewayVerification(
                    () => Promise.resolve("gateway"),
                    { timeoutMs: 500 }
                )
            ).toBe("gateway");
            expect(await captureFailure(() => runWebAuthn(7))).toMatchObject({
                _tag: "AuthenticationWorkCapacityError",
                operation: "webauthn",
            });

            releaseActive.resolve();
            expect(await Promise.all([...active, ...queued])).toEqual([1, 2, 3, 4, 5, 6]);
            expect(starts).toBe(6);
        } finally {
            releaseActive.resolve();
            await runtime.dispose();
        }
    });

    test("releases queued admission when the WebAuthn caller aborts", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 1,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseFirst = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();
        let queuedCancellationSettlements = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const first = webAuthn(
                async () => {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                    return "first";
                },
                { timeoutMs: 5000 }
            );
            await firstStarted.promise;
            const controller = new AbortController();
            const queued = webAuthn(() => Promise.resolve("cancelled"), {
                onCancellationBeforeRelease: () => {
                    queuedCancellationSettlements += 1;
                },
                signal: controller.signal,
                timeoutMs: 5000,
            });
            await yieldToWorkService();

            const cancellation = new Error("request cancelled");
            controller.abort(cancellation);
            expect(await captureFailure(() => queued)).toBe(cancellation);
            expect(queuedCancellationSettlements).toBe(0);

            const replacement = webAuthn(() => Promise.resolve("replacement"), {
                timeoutMs: 5000,
            });
            await yieldToWorkService();
            expect(
                await captureFailure(() =>
                    webAuthn(() => Promise.resolve("overflow"), {
                        timeoutMs: 5000,
                    })
                )
            ).toMatchObject({
                _tag: "AuthenticationWorkCapacityError",
                operation: "webauthn",
            });
            releaseFirst.resolve();
            expect(await first).toBe("first");
            expect(await replacement).toBe("replacement");
        } finally {
            releaseFirst.resolve();
            await runtime.dispose();
        }
    });

    test("returns the typed timeout when queued verification never starts", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 1,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const activeStarted = Promise.withResolvers<void>();
        const releaseActive = Promise.withResolvers<void>();
        let queuedFailureSettlements = 0;
        let queuedWorkCalls = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const active = webAuthn(
                async () => {
                    activeStarted.resolve();
                    await releaseActive.promise;
                    return "active";
                },
                { timeoutMs: 5000 }
            );
            await activeStarted.promise;

            const failure = await captureFailure(() =>
                webAuthn(
                    () => {
                        queuedWorkCalls += 1;
                        return Promise.resolve("unexpected");
                    },
                    {
                        onFailureBeforeRelease: (timeoutFailure) => {
                            expect(timeoutFailure).toBeInstanceOf(
                                AuthenticationWorkTimeoutError
                            );
                            queuedFailureSettlements += 1;
                        },
                        timeoutMs: 20,
                    }
                )
            );

            expect(failure).toBeInstanceOf(AuthenticationWorkTimeoutError);
            expect(failure).toMatchObject({ operation: "webauthn", timeoutMs: 20 });
            expect(queuedFailureSettlements).toBe(1);
            expect(queuedWorkCalls).toBe(0);

            releaseActive.resolve();
            expect(await active).toBe("active");
        } finally {
            releaseActive.resolve();
            await runtime.dispose();
        }
    });

    test("preserves a queued timeout settlement failure", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 1,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const activeStarted = Promise.withResolvers<void>();
        const releaseActive = Promise.withResolvers<void>();
        const sentinel = new Error("private queued settlement failure");
        let queuedWorkCalls = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const active = webAuthn(
                async () => {
                    activeStarted.resolve();
                    await releaseActive.promise;
                    return "active";
                },
                { timeoutMs: 5000 }
            );
            await activeStarted.promise;

            const failure = await captureFailure(() =>
                webAuthn(
                    () => {
                        queuedWorkCalls += 1;
                        return Promise.resolve("unexpected");
                    },
                    {
                        onFailureBeforeRelease: () => Promise.reject(sentinel),
                        timeoutMs: 20,
                    }
                )
            );

            expect(failure).toBeInstanceOf(AuthenticationWorkSettlementError);
            expect(failure).toMatchObject({
                cause: sentinel,
                operation: "webauthn",
            });
            expect(queuedWorkCalls).toBe(0);

            releaseActive.resolve();
            expect(await active).toBe("active");
        } finally {
            releaseActive.resolve();
            await runtime.dispose();
        }
    });

    test("keeps a cooperative abort inside the timeout outcome", async () => {
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        let failureSettlements = 0;

        try {
            await runtime.initialize();
            const failure = await captureFailure(() =>
                webAuthnRunner(runtime)(
                    (signal) =>
                        new Promise<never>((_resolve, reject) => {
                            signal.addEventListener(
                                "abort",
                                () => {
                                    reject(new Error("verification aborted"));
                                },
                                { once: true }
                            );
                        }),
                    {
                        onFailureBeforeRelease: async (timeoutFailure) => {
                            expect(timeoutFailure).toBeInstanceOf(
                                AuthenticationWorkTimeoutError
                            );
                            failureSettlements += 1;
                            await Bun.sleep(30);
                        },
                        timeoutMs: 20,
                    }
                )
            );

            expect(failure).toBeInstanceOf(AuthenticationWorkTimeoutError);
            expect(failure).toMatchObject({ operation: "webauthn", timeoutMs: 20 });
            expect(failureSettlements).toBe(1);
        } finally {
            await runtime.dispose();
        }
    });

    test("redacts defects and retains active capacity after timeout and abort", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 0,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const timedWork = Promise.withResolvers<boolean>();
        const abortedWork = Promise.withResolvers<boolean>();
        const abortedWorkStarted = Promise.withResolvers<void>();
        let timedSignal: AbortSignal | undefined;
        let abortedSignal: AbortSignal | undefined;
        let cancellationSettlements = 0;
        let timeoutSettled = false;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const unavailable = await captureFailure(() =>
                webAuthn(() => Promise.reject(new Error("sensitive verifier detail")), {
                    timeoutMs: 500,
                })
            );
            expect(unavailable).toBeInstanceOf(AuthenticationUpstreamUnavailableError);
            expect(unavailable).toMatchObject({ operation: "webauthn" });
            expect(String(unavailable)).not.toContain("sensitive verifier detail");

            const timedOut = await captureFailure(() =>
                webAuthn(
                    (signal) => {
                        timedSignal = signal;
                        return timedWork.promise;
                    },
                    {
                        onFailureBeforeRelease: (failure) => {
                            expect(failure).toBeInstanceOf(
                                AuthenticationWorkTimeoutError
                            );
                            timeoutSettled = true;
                        },
                        timeoutMs: 50,
                    }
                )
            );
            expect(timedOut).toBeInstanceOf(AuthenticationWorkTimeoutError);
            expect(timedOut).toMatchObject({ operation: "webauthn", timeoutMs: 50 });
            expect(timeoutSettled).toBeTrue();
            expect(timedSignal?.aborted).toBeTrue();
            expect(
                await captureFailure(() =>
                    webAuthn(() => Promise.resolve(true), { timeoutMs: 500 })
                )
            ).toMatchObject({ operation: "webauthn" });

            timedWork.resolve(false);
            await yieldToWorkService();
            const controller = new AbortController();
            const aborted = webAuthn(
                (signal) => {
                    abortedSignal = signal;
                    abortedWorkStarted.resolve();
                    return abortedWork.promise;
                },
                {
                    onCancellationBeforeRelease: () => {
                        cancellationSettlements += 1;
                    },
                    signal: controller.signal,
                    timeoutMs: 5000,
                }
            );
            await abortedWorkStarted.promise;
            const cancellation = new Error("request cancelled");
            controller.abort(cancellation);
            expect(await captureFailure(() => aborted)).toBe(cancellation);
            expect(abortedSignal?.aborted).toBeTrue();
            expect(cancellationSettlements).toBe(0);
            expect(
                await captureFailure(() =>
                    webAuthn(() => Promise.resolve(true), { timeoutMs: 500 })
                )
            ).toMatchObject({ operation: "webauthn" });

            abortedWork.resolve(false);
            await yieldToWorkService();
            expect(cancellationSettlements).toBe(1);
            expect(
                await webAuthn(() => Promise.resolve(true), { timeoutMs: 500 })
            ).toBeTrue();
        } finally {
            timedWork.resolve(false);
            abortedWork.resolve(false);
            await runtime.dispose();
        }
    });

    test("runs in-gate rechecks and settlements before releasing capacity", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 1,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseResult = Promise.withResolvers<void>();
        const resultStarted = Promise.withResolvers<void>();
        const releaseResultSettlement = Promise.withResolvers<void>();
        const resultSettlementStarted = Promise.withResolvers<void>();
        const releaseFailure = Promise.withResolvers<void>();
        const failureStarted = Promise.withResolvers<void>();
        const releaseFailureSettlement = Promise.withResolvers<void>();
        const failureSettlementStarted = Promise.withResolvers<void>();
        const order: string[] = [];
        let skippedWorkCalls = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const result = webAuthn(
                async () => {
                    order.push("result-work");
                    resultStarted.resolve();
                    await releaseResult.promise;
                    return "verified";
                },
                {
                    onResultBeforeRelease: async () => {
                        order.push("result-settlement-started");
                        resultSettlementStarted.resolve();
                        await releaseResultSettlement.promise;
                        order.push("result-settled");
                    },
                    timeoutMs: 5000,
                }
            );
            await resultStarted.promise;
            const skipped = webAuthn(
                () => {
                    skippedWorkCalls += 1;
                    return Promise.resolve("unexpected");
                },
                {
                    onBeforeStart: () => {
                        order.push("queued-recheck");
                        return { proceed: false, value: "stale" };
                    },
                    onResultBeforeRelease: () => {
                        order.push("skipped-settled");
                    },
                    timeoutMs: 5000,
                }
            );
            await yieldToWorkService();
            expect(order).toEqual(["result-work"]);

            releaseResult.resolve();
            await resultSettlementStarted.promise;
            await yieldToWorkService();
            expect(order).toEqual(["result-work", "result-settlement-started"]);
            releaseResultSettlement.resolve();
            expect(await result).toBe("verified");
            expect(await skipped).toBe("stale");
            expect(skippedWorkCalls).toBe(0);
            expect(order).toEqual([
                "result-work",
                "result-settlement-started",
                "result-settled",
                "queued-recheck",
            ]);

            const failed = webAuthn(
                async () => {
                    order.push("failure-work");
                    failureStarted.resolve();
                    await releaseFailure.promise;
                    throw new Error("verifier detail");
                },
                {
                    onFailureBeforeRelease: async () => {
                        order.push("failure-settlement-started");
                        failureSettlementStarted.resolve();
                        await releaseFailureSettlement.promise;
                        order.push("failure-settled");
                    },
                    timeoutMs: 5000,
                }
            );
            await failureStarted.promise;
            const afterFailure = webAuthn(
                () => {
                    order.push("after-failure-start");
                    return Promise.resolve("after");
                },
                { timeoutMs: 5000 }
            );
            releaseFailure.resolve();
            await failureSettlementStarted.promise;
            await yieldToWorkService();
            expect(order).not.toContain("after-failure-start");
            releaseFailureSettlement.resolve();
            expect(await captureFailure(() => failed)).toBeInstanceOf(
                AuthenticationUpstreamUnavailableError
            );
            expect(await afterFailure).toBe("after");
            expect(order.indexOf("failure-settled")).toBeLessThan(
                order.indexOf("after-failure-start")
            );
        } finally {
            releaseResult.resolve();
            releaseResultSettlement.resolve();
            releaseFailure.resolve();
            releaseFailureSettlement.resolve();
            await runtime.dispose();
        }
    });

    test("stops the verification deadline before awaiting result settlement", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 0,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseSettlement = Promise.withResolvers<void>();
        const settlementStarted = Promise.withResolvers<void>();
        let callerSettled = false;
        let failureSettlements = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const verification = webAuthn(() => Promise.resolve("verified"), {
                onFailureBeforeRelease: () => {
                    failureSettlements += 1;
                },
                onResultBeforeRelease: async () => {
                    settlementStarted.resolve();
                    await releaseSettlement.promise;
                },
                timeoutMs: 20,
            });
            void verification.then(
                () => {
                    callerSettled = true;
                    return true;
                },
                () => {
                    callerSettled = true;
                    return false;
                }
            );
            await settlementStarted.promise;
            await Bun.sleep(60);

            expect(callerSettled).toBeFalse();
            expect(failureSettlements).toBe(0);
            expect(
                await captureFailure(() =>
                    webAuthn(() => Promise.resolve("overflow"), {
                        timeoutMs: 500,
                    })
                )
            ).toMatchObject({
                _tag: "AuthenticationWorkCapacityError",
                operation: "webauthn",
            });

            releaseSettlement.resolve();
            expect(await verification).toBe("verified");
            expect(failureSettlements).toBe(0);
        } finally {
            releaseSettlement.resolve();
            await runtime.dispose();
        }
    });

    test("does not run cancellation settlement after result settlement is claimed", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 1,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseSettlement = Promise.withResolvers<void>();
        const replacementStarted = Promise.withResolvers<void>();
        const settlementStarted = Promise.withResolvers<void>();
        let cancellationSettlements = 0;
        let resultSettlements = 0;

        try {
            await runtime.initialize();
            const webAuthn = webAuthnRunner(runtime);
            const controller = new AbortController();
            const verification = webAuthn(() => Promise.resolve("verified"), {
                onCancellationBeforeRelease: () => {
                    cancellationSettlements += 1;
                },
                onResultBeforeRelease: async () => {
                    resultSettlements += 1;
                    settlementStarted.resolve();
                    await releaseSettlement.promise;
                },
                signal: controller.signal,
                timeoutMs: 5000,
            });
            await settlementStarted.promise;

            const cancellation = new Error("request cancelled");
            controller.abort(cancellation);
            expect(await captureFailure(() => verification)).toBe(cancellation);

            const replacement = webAuthn(
                () => {
                    replacementStarted.resolve();
                    return Promise.resolve("replacement");
                },
                { timeoutMs: 5000 }
            );
            await yieldToWorkService();
            expect(resultSettlements).toBe(1);
            expect(cancellationSettlements).toBe(0);

            releaseSettlement.resolve();
            await replacementStarted.promise;
            expect(await replacement).toBe("replacement");
            expect(resultSettlements).toBe(1);
            expect(cancellationSettlements).toBe(0);
        } finally {
            releaseSettlement.resolve();
            await runtime.dispose();
        }
    });

    test("keeps a claimed settlement owned during runtime disposal", async () => {
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseSettlement = Promise.withResolvers<void>();
        const settlementStarted = Promise.withResolvers<void>();
        let disposalCompleted = false;
        let settlementCompleted = false;

        try {
            await runtime.initialize();
            const verification = webAuthnRunner(runtime)(
                () => Promise.resolve("verified"),
                {
                    onResultBeforeRelease: async () => {
                        settlementStarted.resolve();
                        await releaseSettlement.promise;
                        settlementCompleted = true;
                    },
                    timeoutMs: 5000,
                }
            );
            const observedVerification = verification.catch(() => null);
            await settlementStarted.promise;
            const disposal = runtime.dispose().then(() => {
                disposalCompleted = true;
                return true;
            });
            await Bun.sleep(0);

            expect(disposalCompleted).toBeFalse();
            expect(settlementCompleted).toBeFalse();

            releaseSettlement.resolve();
            await disposal;
            await observedVerification;
            expect(disposalCompleted).toBeTrue();
            expect(settlementCompleted).toBeTrue();
        } finally {
            releaseSettlement.resolve();
            await runtime.dispose();
        }
    });

    test("surfaces an in-gate recheck defect before the verification deadline", async () => {
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const sentinel = new Error("private recheck defect");

        try {
            await runtime.initialize();
            const failure = await captureFailure(() =>
                webAuthnRunner(runtime)(() => Promise.resolve("unused"), {
                    onBeforeStart: () => {
                        throw sentinel;
                    },
                    timeoutMs: 20,
                })
            );

            expect(failure).toBe(sentinel);
        } finally {
            await runtime.dispose();
        }
    });

    test("wraps a failed durable settlement with its private cause", async () => {
        const runtime = createApplicationRuntime({
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const sentinel = new Error("private database settlement failure");

        try {
            await runtime.initialize();
            const failure = await captureFailure(() =>
                webAuthnRunner(runtime)(() => Promise.resolve("verified"), {
                    onResultBeforeRelease: () => Promise.reject(sentinel),
                    timeoutMs: 5000,
                })
            );

            expect(failure).toBeInstanceOf(AuthenticationWorkSettlementError);
            expect(failure).toMatchObject({
                cause: sentinel,
                operation: "webauthn",
            });
        } finally {
            await runtime.dispose();
        }
    });

    test("rejects invalid WebAuthn process work limits", () => {
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumConcurrent: 0 },
                logger: testStructuredLogger,
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow("WebAuthn verification concurrency limit is invalid");
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumQueued: -1 },
                logger: testStructuredLogger,
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow("WebAuthn verification queue limit is invalid");
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumQueued: 1.5 },
                logger: testStructuredLogger,
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow(RangeError);
    });
});
