import { describe, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import {
    applicationServerResource,
    ShutdownQualificationDeadlineError,
    ShutdownQualificationResourceError,
    stopApplicationListener,
} from "./shutdownServiceResources.ts";

describe("shutdown application listener policy", () => {
    test("reports a graceful stop without escalation", async () => {
        const stopCalls: boolean[] = [];

        const mode = await Effect.runPromise(
            stopApplicationListener({
                stop(force = false) {
                    stopCalls.push(force);
                    return Promise.resolve();
                },
            })
        );

        expect(mode).toBe("graceful");
        expect(stopCalls).toEqual([false]);
    });

    test("forces one pending graceful stop and joins its settlement", async () => {
        const gracefulStop = Promise.withResolvers<void>();
        const stopCalls: boolean[] = [];

        const mode = await Effect.runPromise(
            stopApplicationListener({
                stop(force = false) {
                    stopCalls.push(force);
                    if (force) gracefulStop.resolve();
                    return gracefulStop.promise;
                },
            })
        );

        expect(mode).toBe("forced");
        expect(stopCalls).toEqual([false, true]);
    });

    test("bounds a force stop that does not settle", async () => {
        const pending = new Promise<void>(() => {});
        const stopCalls: boolean[] = [];

        const failure = await Effect.runPromise(
            stopApplicationListener(
                {
                    stop(force = false) {
                        stopCalls.push(force);
                        return pending;
                    },
                },
                { forcedStopDeadline: 1, gracefulStopDeadline: 1 }
            )
        ).then(
            () => null,
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(ShutdownQualificationDeadlineError);
        expect(stopCalls).toEqual([false, true]);
    });

    test("best-effort forces after graceful rejection and preserves that failure", async () => {
        const gracefulFailure = new Error("simulated graceful stop failure");
        const stopCalls: boolean[] = [];

        const failure = await Effect.runPromise(
            stopApplicationListener({
                stop(force = false) {
                    stopCalls.push(force);
                    return force ? Promise.resolve() : Promise.reject(gracefulFailure);
                },
            })
        ).then(
            () => null,
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(ShutdownQualificationResourceError);
        expect((failure as ShutdownQualificationResourceError).cause).toBe(
            gracefulFailure
        );
        expect(stopCalls).toEqual([false, true]);
    });

    test("memoizes concurrent and finalizer-driven close calls", async () => {
        const stopCalls: boolean[] = [];
        const fakeServer = {
            port: 31_001,
            stop(force = false) {
                stopCalls.push(force);
                return Promise.resolve();
            },
        } as unknown as ReturnType<typeof Bun.serve>;
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fakeServer);

        try {
            const modes = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const server = yield* applicationServerResource({
                            gatewaySocketOpen: false,
                            leaseActive: false,
                            readiness: false,
                        });
                        return yield* Effect.all(
                            [server.close(), server.close()] as const,
                            { concurrency: "unbounded" }
                        );
                    })
                )
            );

            expect(modes).toEqual(["graceful", "graceful"]);
            expect(stopCalls).toEqual([false]);
        } finally {
            serveSpy.mockRestore();
        }
    });
});
