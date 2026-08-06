import { describe, expect, test } from "bun:test";

import { Effect, Layer, Stream } from "effect";

import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    type AuthenticationVerificationWorkOptions,
    AuthenticationUpstreamUnavailableError,
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

async function yieldToWorkService(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
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

    test("redacts defects and retains active capacity after timeout and abort", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                webAuthnMaximumConcurrent: 1,
                webAuthnMaximumQueued: 0,
            },
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
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseResult = Promise.withResolvers<void>();
        const resultStarted = Promise.withResolvers<void>();
        const releaseFailure = Promise.withResolvers<void>();
        const failureStarted = Promise.withResolvers<void>();
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
                    onResultBeforeRelease: () => order.push("result-settled"),
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
                    onResultBeforeRelease: () => order.push("skipped-settled"),
                    timeoutMs: 5000,
                }
            );
            await yieldToWorkService();
            expect(order).toEqual(["result-work"]);

            releaseResult.resolve();
            expect(await result).toBe("verified");
            expect(await skipped).toBe("stale");
            expect(skippedWorkCalls).toBe(0);
            expect(order).toEqual(["result-work", "result-settled", "queued-recheck"]);

            const failed = webAuthn(
                async () => {
                    order.push("failure-work");
                    failureStarted.resolve();
                    await releaseFailure.promise;
                    throw new Error("verifier detail");
                },
                {
                    onFailureBeforeRelease: () => order.push("failure-settled"),
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
            expect(await captureFailure(() => failed)).toBeInstanceOf(
                AuthenticationUpstreamUnavailableError
            );
            expect(await afterFailure).toBe("after");
            expect(order.indexOf("failure-settled")).toBeLessThan(
                order.indexOf("after-failure-start")
            );
        } finally {
            releaseResult.resolve();
            releaseFailure.resolve();
            await runtime.dispose();
        }
    });

    test("rejects invalid WebAuthn process work limits", () => {
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumConcurrent: 0 },
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow("WebAuthn verification concurrency limit is invalid");
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumQueued: -1 },
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow("WebAuthn verification queue limit is invalid");
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { webAuthnMaximumQueued: 1.5 },
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow(RangeError);
    });
});
