import { describe, expect, test } from "bun:test";

import { Effect, Layer, Stream } from "effect";

import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkTimeoutError,
} from "./authenticationWorkGate.ts";

const inertRealtimeLayer = Layer.succeed(
    RealtimeEventPumpService,
    RealtimeEventPumpService.of({
        metricsSnapshot: Effect.die("Authentication work tests do not use metrics"),
        stream: () => Stream.empty,
        wake: Effect.void,
    })
);

describe("process authentication work service", () => {
    test("serializes TOTP work and rejects overflow beyond the bounded queue", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                totpMaximumConcurrent: 1,
                totpMaximumQueued: 1,
            },
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseFirst = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();
        let starts = 0;

        try {
            await runtime.initialize();
            const gate = runtime.services.authentication.totpWorkGate;
            const first = gate.run(async () => {
                starts += 1;
                firstStarted.resolve();
                await releaseFirst.promise;
                return "first";
            });
            await firstStarted.promise;
            const second = gate.run(() => {
                starts += 1;
                return Promise.resolve("second");
            });
            await Promise.resolve();

            expect(starts).toBe(1);
            expect(await gate.run(() => Promise.resolve("overflow"))).toEqual({
                accepted: false,
            });

            releaseFirst.resolve();
            expect(await first).toEqual({ accepted: true, value: "first" });
            expect(await second).toEqual({ accepted: true, value: "second" });
            expect(starts).toBe(2);
        } finally {
            releaseFirst.resolve();
            await runtime.dispose();
        }
    });

    test("releases queued admission when its caller aborts", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                passwordMaximumConcurrent: 1,
                passwordMaximumQueued: 1,
            },
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const releaseFirst = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();

        try {
            await runtime.initialize();
            const gate = runtime.services.authentication.passwordWorkGate;
            const first = gate.run(async () => {
                firstStarted.resolve();
                await releaseFirst.promise;
            });
            await firstStarted.promise;
            const controller = new AbortController();
            const queued = gate.run(() => Promise.resolve(), controller.signal);
            await Promise.resolve();

            controller.abort(new Error("request cancelled"));
            expect(await captureFailure(() => queued)).toBe(controller.signal.reason);

            const replacement = gate.run(() => Promise.resolve("replacement"));
            expect(await gate.run(() => Promise.resolve("overflow"))).toEqual({
                accepted: false,
            });
            releaseFirst.resolve();
            await first;
            expect(await replacement).toEqual({
                accepted: true,
                value: "replacement",
            });
        } finally {
            releaseFirst.resolve();
            await runtime.dispose();
        }
    });

    test("preserves password-work defects for the existing domain contract", async () => {
        const runtime = createApplicationRuntime({
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const expected = new Error("simulated password implementation defect");

        try {
            await runtime.initialize();
            expect(
                await captureFailure(() =>
                    runtime.services.authentication.passwordWorkGate.run(() =>
                        Promise.reject(expected)
                    )
                )
            ).toBe(expected);
        } finally {
            await runtime.dispose();
        }
    });

    test("tags Gateway rejection, timeout, and non-cooperative capacity", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                gatewayMaximumConcurrent: 1,
                gatewayMaximumQueued: 0,
            },
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const pending = Promise.withResolvers<boolean>();
        let timeoutSignal: AbortSignal | undefined;

        try {
            await runtime.initialize();
            const gateway = <T>(
                work: (signal: AbortSignal) => Promise<T>,
                options: { readonly signal?: AbortSignal; readonly timeoutMs: number }
            ): Promise<T> =>
                runtime.services.authentication.runGatewayVerification(work, options);
            const unavailable = await captureFailure(() =>
                gateway(() => Promise.reject(new Error("secret upstream failure")), {
                    timeoutMs: 100,
                })
            );
            expect(unavailable).toBeInstanceOf(AuthenticationUpstreamUnavailableError);
            expect(
                (unavailable as AuthenticationUpstreamUnavailableError).operation
            ).toBe("gateway");

            const timedOut = await captureFailure(() =>
                gateway(
                    (signal) => {
                        timeoutSignal = signal;
                        return pending.promise;
                    },
                    { timeoutMs: 100 }
                )
            );
            expect(timedOut).toBeInstanceOf(AuthenticationWorkTimeoutError);
            expect(timeoutSignal?.aborted).toBeTrue();

            expect(
                await captureFailure(() =>
                    gateway(() => Promise.resolve(true), { timeoutMs: 100 })
                )
            ).toMatchObject({
                _tag: "AuthenticationWorkCapacityError",
                operation: "gateway",
            });

            pending.resolve(false);
            await Promise.resolve();
            expect(
                await gateway(() => Promise.resolve(true), { timeoutMs: 100 })
            ).toBeTrue();
        } finally {
            pending.resolve(false);
            await runtime.dispose();
        }
    });

    test("rejects invalid process work limits", () => {
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { passwordMaximumConcurrent: 0 },
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow(RangeError);
        expect(() =>
            createApplicationRuntime({
                authenticationWork: { totpMaximumQueued: -1 },
                realtimeEventPumpLayer: inertRealtimeLayer,
            })
        ).toThrow(RangeError);
    });
});
