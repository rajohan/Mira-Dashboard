import { expect, test } from "bun:test";

import { toDate } from "date-fns";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { BoundedAsyncQueueOverflowError } from "./boundedAsyncQueue.ts";
import {
    RealtimeCursorError,
    RealtimeEventPump,
    RealtimeSubscriptionInputError,
} from "./eventPump.ts";
import {
    realtimeEventPumpLayer,
    RealtimeEventCursorStreamError,
    RealtimeEventPumpService,
    RealtimeEventSlowConsumerStreamError,
    RealtimeEventStoreStreamError,
    RealtimeEventSubscriptionStreamError,
} from "./eventPumpService.ts";
import type { RealtimeEventStore } from "./eventStore.ts";
import {
    changeDelivery,
    makePort,
    provideTestClock,
} from "./testSupport/eventPumpService.ts";

test("maps subscription input and slow-consumer failures into distinct typed errors", async () => {
    const cursorLayer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                async *subscribe() {
                    yield await Promise.reject(
                        new RealtimeCursorError("invalid", "bad cursor")
                    );
                },
            }),
    });
    const overflowLayer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                async *subscribe() {
                    yield await Promise.reject(
                        new BoundedAsyncQueueOverflowError("slow consumer")
                    );
                },
            }),
    });
    const inputLayer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                async *subscribe() {
                    yield await Promise.reject(
                        new RealtimeSubscriptionInputError("invalid-topics", "bad topics")
                    );
                },
            }),
    });
    const drain = RealtimeEventPumpService.use((service) =>
        Stream.runDrain(service.stream({ afterId: "01" }))
    );

    const cursorFailureProgram = Effect.flip(Effect.provide(drain, cursorLayer));
    const cursorFailure = await Effect.runPromise(cursorFailureProgram);
    expect(cursorFailure).toEqual(
        new RealtimeEventCursorStreamError({ code: "invalid", message: "bad cursor" })
    );
    const overflowFailureProgram = Effect.flip(Effect.provide(drain, overflowLayer));
    const overflowFailure = await Effect.runPromise(overflowFailureProgram);
    expect(overflowFailure).toEqual(
        new RealtimeEventSlowConsumerStreamError({ message: "slow consumer" })
    );
    const inputFailureProgram = Effect.flip(Effect.provide(drain, inputLayer));
    const inputFailure = await Effect.runPromise(inputFailureProgram);
    expect(inputFailure).toEqual(
        new RealtimeEventSubscriptionStreamError({
            code: "invalid-topics",
            message: "bad topics",
        })
    );
});

test("keeps unknown iterator failures in the defect channel", async () => {
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                async *subscribe() {
                    yield await Promise.reject(new Error("iterator defect"));
                },
            }),
    });
    const drain = RealtimeEventPumpService.use((service) =>
        Stream.runDrain(service.stream({ afterId: "0" }))
    );

    let observedDefect: unknown;
    try {
        await Effect.runPromise(Effect.provide(drain, layer));
    } catch (error) {
        observedDefect = error;
    }
    expect(String(observedDefect)).toContain("iterator defect");
});

test("surfaces classified store failures through the typed stream channel", async () => {
    let pollAttempts = 0;
    let rejectSubscription: ((error: Error) => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
    });
    const layer = realtimeEventPumpLayer({
        makePump: ({ requestPoll }) =>
            makePort({
                failSubscribers(error) {
                    rejectSubscription?.(error);
                },
                poll() {
                    pollAttempts += 1;
                    if (pollAttempts === 1) {
                        return "active";
                    }
                    throw Object.assign(new Error("io"), { code: "SQLITE_IOERR" });
                },
                async *subscribe() {
                    resolveStarted?.();
                    await new Promise<never>((_resolve, reject) => {
                        rejectSubscription = reject;
                    });
                    yield changeDelivery("unreachable");
                },
                wake: requestPoll,
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            const streamFiber = yield* Stream.runDrain(
                service.stream({ afterId: "0" })
            ).pipe(Effect.forkChild);
            yield* Effect.promise(() => started);
            yield* service.wake;
            return yield* Fiber.join(streamFiber).pipe(Effect.flip);
        })
    );

    expect(await Effect.runPromise(Effect.provide(program, layer))).toEqual(
        new RealtimeEventStoreStreamError({
            message: "Realtime event store is temporarily unavailable",
        })
    );
});

test("retries subscription replay reads through the scoped Effect runtime", async () => {
    let cursorReadAttempts = 0;
    const store: RealtimeEventStore = {
        readBatch(options) {
            return {
                bounds: {
                    latestIssuedId: 1,
                    newestRetainedId: 1,
                    oldestRetainedId: 1,
                },
                events:
                    options.throughId === undefined
                        ? []
                        : [
                              {
                                  entityId: "1",
                                  entityType: "qualification",
                                  expiresAt: toDate(60_000),
                                  id: 1,
                                  occurredAt: toDate(1000),
                                  operation: "updated",
                                  payloadJson: "{}",
                                  topic: "topic.a",
                              },
                          ],
            };
        },
        readCursorBounds() {
            cursorReadAttempts += 1;
            if (cursorReadAttempts === 1) {
                throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
            }
            return {
                latestIssuedId: 1,
                newestRetainedId: 1,
                oldestRetainedId: 1,
            };
        },
        readCursorWindow() {
            return {
                latestIssuedId: 1,
                newestRetainedId: 1,
                oldestRetainedId: 1,
                retainedEvents: 1,
            };
        },
    };
    let pump: RealtimeEventPump | undefined;
    const layer = realtimeEventPumpLayer({
        makePump(runtime) {
            pump = new RealtimeEventPump({ ...runtime, nowMs: () => 0, store });
            return pump;
        },
        maximumRetryablePollRetries: 1,
        retryablePollBaseDelayMs: 25,
        retryablePollMaximumDelayMs: 25,
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            const streamFiber = yield* service
                .stream({ afterId: "0" })
                .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
            yield* Effect.yieldNow;
            expect(cursorReadAttempts).toBe(1);
            yield* TestClock.adjust(24);
            expect(cursorReadAttempts).toBe(1);
            yield* TestClock.adjust(1);
            return yield* Fiber.join(streamFiber);
        })
    );

    expect([...(await Effect.runPromise(provideTestClock(program, layer)))]).toEqual([
        changeDelivery("1"),
    ]);
    expect(cursorReadAttempts).toBe(2);
    expect(pump?.metricsSnapshot()).toMatchObject({
        retryableSubscriptionReadRetries: 1,
        subscriptionReadFailures: 1,
    });
});

test("maps a non-retryable subscription read failure to the safe store error", async () => {
    const store: RealtimeEventStore = {
        readBatch(): never {
            throw new Error("Expected cursor read to fail first");
        },
        readCursorBounds(): never {
            throw Object.assign(new Error("io"), { code: "SQLITE_IOERR" });
        },
        readCursorWindow() {
            return {
                latestIssuedId: 0,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 0,
            };
        },
    };
    const layer = realtimeEventPumpLayer({
        makePump: (runtime) => new RealtimeEventPump({ ...runtime, store }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Stream.runDrain(service.stream({ afterId: "0" }))
    );

    const failureProgram = Effect.flip(Effect.provide(program, layer));
    const failure = await Effect.runPromise(failureProgram);
    expect(failure).toEqual(
        new RealtimeEventStoreStreamError({
            message: "Realtime event store is temporarily unavailable",
        })
    );
});

test("exhausts bounded SQLITE_BUSY retries for subscription reads", async () => {
    let cursorReadAttempts = 0;
    const store: RealtimeEventStore = {
        readBatch(): never {
            throw new Error("Expected cursor read to fail first");
        },
        readCursorBounds(): never {
            cursorReadAttempts += 1;
            throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        },
        readCursorWindow() {
            return {
                latestIssuedId: 0,
                newestRetainedId: null,
                oldestRetainedId: null,
                retainedEvents: 0,
            };
        },
    };
    let pump: RealtimeEventPump | undefined;
    const layer = realtimeEventPumpLayer({
        makePump: (runtime) => {
            pump = new RealtimeEventPump({ ...runtime, nowMs: () => 0, store });
            return pump;
        },
        maximumRetryablePollRetries: 2,
        retryablePollBaseDelayMs: 25,
        retryablePollMaximumDelayMs: 25,
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            const failureFiber = yield* Stream.runDrain(
                service.stream({ afterId: "0" })
            ).pipe(Effect.flip, Effect.forkChild);
            yield* Effect.yieldNow;
            expect(cursorReadAttempts).toBe(1);
            yield* TestClock.adjust(25);
            expect(cursorReadAttempts).toBe(2);
            yield* TestClock.adjust(25);
            return yield* Fiber.join(failureFiber);
        })
    );

    expect(await Effect.runPromise(provideTestClock(program, layer))).toEqual(
        new RealtimeEventStoreStreamError({
            message: "Realtime event store is temporarily unavailable",
        })
    );
    expect(cursorReadAttempts).toBe(3);
    expect(pump?.metricsSnapshot()).toMatchObject({
        retryableSubscriptionReadRetries: 2,
        subscriptionReadFailures: 3,
    });
});
