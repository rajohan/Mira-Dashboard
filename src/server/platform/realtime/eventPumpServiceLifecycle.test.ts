import { expect, test } from "bun:test";

import { Effect, Fiber, Logger, Stream } from "effect";

import type { RealtimeEventSubscriptionOptions } from "./eventPump.ts";
import {
    realtimeEventPumpLayer,
    RealtimeEventPumpService,
    RealtimeEventStoreStreamError,
} from "./eventPumpService.ts";
import { changeDelivery, makePort } from "./testSupport/eventPumpService.ts";

test("acquires a fresh scoped pump and exposes its Effect service", async () => {
    let closes = 0;
    let factories = 0;
    let wakeups = 0;
    const layer = realtimeEventPumpLayer({
        makePump({ requestPoll }) {
            factories += 1;
            return makePort({
                close() {
                    closes += 1;
                },
                async *subscribe() {
                    yield await Promise.resolve(changeDelivery("1"));
                },
                wake() {
                    wakeups += 1;
                    requestPoll();
                },
            });
        },
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            yield* service.wake;
            const deliveries = yield* Stream.runCollect(service.stream({ afterId: "0" }));
            return [...deliveries];
        })
    );

    expect(await Effect.runPromise(Effect.provide(program, layer))).toEqual([
        changeDelivery("1"),
    ]);
    expect(await Effect.runPromise(Effect.provide(program, layer))).toEqual([
        changeDelivery("1"),
    ]);
    expect({ closes, factories, wakeups }).toEqual({
        closes: 2,
        factories: 2,
        wakeups: 2,
    });
});

test("aborts and finalizes a subscription when a consumer stops early", async () => {
    let subscriptionAborts = 0;
    let subscriptionFinalizations = 0;
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                async *subscribe(options: RealtimeEventSubscriptionOptions) {
                    options.signal.addEventListener(
                        "abort",
                        () => {
                            subscriptionAborts += 1;
                        },
                        { once: true }
                    );
                    try {
                        yield await Promise.resolve(changeDelivery("1"));
                        yield changeDelivery("2");
                    } finally {
                        subscriptionFinalizations += 1;
                    }
                },
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        service.stream({ afterId: "0" }).pipe(Stream.take(1), Stream.runCollect)
    );

    expect([...(await Effect.runPromise(Effect.provide(program, layer)))]).toEqual([
        changeDelivery("1"),
    ]);
    expect({ subscriptionAborts, subscriptionFinalizations }).toEqual({
        subscriptionAborts: 1,
        subscriptionFinalizations: 1,
    });
});

test("aborts a blocked subscription when its Effect stream is interrupted", async () => {
    let closes = 0;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
    });
    let subscriptionAborts = 0;
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                close() {
                    closes += 1;
                },
                async *subscribe(options: RealtimeEventSubscriptionOptions) {
                    resolveStarted?.();
                    await new Promise<void>((resolve) => {
                        options.signal.addEventListener(
                            "abort",
                            () => {
                                subscriptionAborts += 1;
                                resolve();
                            },
                            { once: true }
                        );
                    });
                    if (!options.signal.aborted) {
                        yield changeDelivery("unexpected");
                    }
                },
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Stream.runDrain(service.stream({ afterId: "0" }))
    );
    const fiber = Effect.runFork(Effect.provide(program, layer));

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect({ closes, subscriptionAborts }).toEqual({
        closes: 1,
        subscriptionAborts: 1,
    });
});

test("poisons the scoped service after an unexpected runner defect", async () => {
    let closed = false;
    let failedSubscribers = 0;
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                close() {
                    closed = true;
                },
                failSubscribers() {
                    failedSubscribers += 1;
                },
                poll(): never {
                    throw new Error("unexpected poll defect");
                },
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            return yield* Stream.runDrain(service.stream({ afterId: "0" })).pipe(
                Effect.flip
            );
        })
    );

    const quietProgram = Effect.provide(
        Effect.provide(program, layer),
        Logger.layer([Logger.make(() => {})])
    );
    expect(await Effect.runPromise(quietProgram)).toEqual(
        new RealtimeEventStoreStreamError({
            message: "Realtime event store is temporarily unavailable",
        })
    );
    expect({ closed, failedSubscribers }).toEqual({
        closed: true,
        failedSubscribers: 1,
    });
});

test("rejects invalid runtime options before acquiring the pump", () => {
    let factories = 0;

    expect(() =>
        realtimeEventPumpLayer({
            makePump: () => {
                factories += 1;
                return makePort();
            },
            retryablePollBaseDelayMs: 50,
            retryablePollMaximumDelayMs: 25,
        })
    ).toThrow(
        new RangeError(
            "Realtime retryable poll maximum delay cannot be below its base delay"
        )
    );
    expect(factories).toBe(0);
});
