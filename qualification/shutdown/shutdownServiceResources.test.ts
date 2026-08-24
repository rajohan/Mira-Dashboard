import { describe, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import {
    createGatewayConnectRequest,
    parseGatewayConnectRequest,
} from "./shutdownProtocol.ts";
import {
    applicationServerResource,
    ShutdownQualificationDeadlineError,
    ShutdownQualificationResourceError,
    stopApplicationListener,
} from "./shutdownServiceResources.ts";

describe("shutdown application listener policy", () => {
    test("binds the Gateway connect request to its challenge nonce", () => {
        const nonce = "qualification-challenge";
        const request = parseGatewayConnectRequest(
            JSON.stringify(createGatewayConnectRequest(nonce))
        );

        expect(request.params.nonce).toBe(nonce);
    });

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

    test("closes every registered SSE controller on a real listener", async () => {
        const evidence = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const server = yield* applicationServerResource({
                        gatewaySocketOpen: false,
                        leaseActive: false,
                        readiness: true,
                    });
                    const response = yield* Effect.tryPromise(() =>
                        fetch(`http://127.0.0.1:${server.port}/api/events`)
                    );
                    if (response.body === null) {
                        return yield* Effect.die("SSE response body is unavailable");
                    }
                    const reader = response.body.getReader();
                    yield* Effect.addFinalizer(() =>
                        Effect.tryPromise(() => reader.cancel()).pipe(
                            Effect.ignore,
                            Effect.asVoid
                        )
                    );
                    const openingEvent = yield* Effect.tryPromise(() => reader.read());
                    if (openingEvent.done || openingEvent.value === undefined) {
                        return yield* Effect.die("SSE opening event is unavailable");
                    }
                    const registeredBeforeClose = server.sseConnectionCount;
                    yield* server.close();
                    return {
                        registeredAfterClose: server.sseConnectionCount,
                        registeredBeforeClose,
                    };
                })
            )
        );

        expect(evidence.registeredBeforeClose).toBe(1);
        expect(evidence.registeredAfterClose).toBe(0);
    });
});
