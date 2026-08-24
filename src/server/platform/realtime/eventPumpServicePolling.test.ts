import { expect, test } from "bun:test";

import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { realtimeEventPumpLayer, RealtimeEventPumpService } from "./eventPumpService.ts";
import { makePort, provideTestClock } from "./testSupport/eventPumpService.ts";

test("uses the Effect clock for adaptive idle and active polling", async () => {
    let polls = 0;
    const plans = ["idle", "active", "idle"] as const;
    const layer = realtimeEventPumpLayer({
        activePollIntervalMs: 250,
        idlePollIntervalMs: 5000,
        makePump: () =>
            makePort({
                poll() {
                    const plan = plans[Math.min(polls, plans.length - 1)] ?? "idle";
                    polls += 1;
                    return plan;
                },
            }),
    });
    const program = RealtimeEventPumpService.use(() =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect(polls).toBe(1);
            yield* TestClock.adjust(4999);
            expect(polls).toBe(1);
            yield* TestClock.adjust(1);
            expect(polls).toBe(2);
            yield* TestClock.adjust(249);
            expect(polls).toBe(2);
            yield* TestClock.adjust(1);
            expect(polls).toBe(3);
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});

test("coalesces wakeups through the bounded Effect queue", async () => {
    let polls = 0;
    const layer = realtimeEventPumpLayer({
        makePump: ({ requestPoll }) =>
            makePort({
                poll() {
                    polls += 1;
                    return "idle";
                },
                wake: requestPoll,
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect(polls).toBe(1);
            yield* service.wake;
            yield* service.wake;
            yield* service.wake;
            yield* Effect.yieldNow;
            expect(polls).toBe(2);
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});

test("restarts the adaptive deadline after a wake interrupts its sleep", async () => {
    let polls = 0;
    const layer = realtimeEventPumpLayer({
        idlePollIntervalMs: 5000,
        makePump: ({ requestPoll }) =>
            makePort({
                poll() {
                    polls += 1;
                    return "idle";
                },
                wake: requestPoll,
            }),
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect(polls).toBe(1);
            yield* TestClock.adjust(2000);
            yield* service.wake;
            yield* Effect.yieldNow;
            expect(polls).toBe(2);
            yield* TestClock.adjust(2999);
            expect(polls).toBe(2);
            yield* TestClock.adjust(2001);
            expect(polls).toBe(3);
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});

test("retries SQLITE_BUSY on an Effect Schedule without bypassing its delay", async () => {
    let attempts = 0;
    let pollFailures = 0;
    let retries = 0;
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                poll() {
                    attempts += 1;
                    if (attempts === 1) {
                        throw Object.assign(new Error("busy"), {
                            code: "SQLITE_BUSY",
                        });
                    }
                    return "active";
                },
                recordPollFailure() {
                    pollFailures += 1;
                },
                recordRetryablePollRetry() {
                    retries += 1;
                },
            }),
        retryablePollBaseDelayMs: 25,
        retryablePollMaximumDelayMs: 250,
    });
    const program = RealtimeEventPumpService.use(() =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect({ attempts, pollFailures, retries }).toEqual({
                attempts: 1,
                pollFailures: 1,
                retries: 1,
            });
            yield* TestClock.adjust(24);
            expect(attempts).toBe(1);
            yield* TestClock.adjust(1);
            expect({ attempts, pollFailures, retries }).toEqual({
                attempts: 2,
                pollFailures: 1,
                retries: 1,
            });
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});

test("queues a wake during SQLITE_BUSY without bypassing the retry delay", async () => {
    let attempts = 0;
    const layer = realtimeEventPumpLayer({
        makePump: ({ requestPoll }) =>
            makePort({
                poll() {
                    attempts += 1;
                    if (attempts === 1) {
                        throw Object.assign(new Error("busy"), {
                            code: "SQLITE_BUSY",
                        });
                    }
                    return "idle";
                },
                wake: requestPoll,
            }),
        retryablePollBaseDelayMs: 25,
        retryablePollMaximumDelayMs: 250,
    });
    const program = RealtimeEventPumpService.use((service) =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect(attempts).toBe(1);
            yield* service.wake;
            yield* Effect.yieldNow;
            expect(attempts).toBe(1);
            yield* TestClock.adjust(24);
            expect(attempts).toBe(1);
            yield* TestClock.adjust(1);
            expect(attempts).toBe(3);
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});

test("exhausts bounded busy retries and does not retry other SQLite failures", async () => {
    let busyAttempts = 0;
    let busyFailures = 0;
    let busyRetries = 0;
    const busyLayer = realtimeEventPumpLayer({
        idlePollIntervalMs: 5000,
        makePump: () =>
            makePort({
                failSubscribers() {
                    busyFailures += 1;
                },
                poll() {
                    busyAttempts += 1;
                    throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
                },
                recordRetryablePollRetry() {
                    busyRetries += 1;
                },
            }),
        maximumRetryablePollRetries: 2,
        retryablePollBaseDelayMs: 25,
        retryablePollMaximumDelayMs: 250,
    });
    const busyProgram = RealtimeEventPumpService.use(() =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            yield* TestClock.adjust(25);
            yield* TestClock.adjust(50);
            expect({ busyAttempts, busyFailures, busyRetries }).toEqual({
                busyAttempts: 3,
                busyFailures: 1,
                busyRetries: 2,
            });
        })
    );

    await Effect.runPromise(provideTestClock(busyProgram, busyLayer));

    let unavailableAttempts = 0;
    let unavailableFailures = 0;
    let unavailableRetries = 0;
    const unavailableLayer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                failSubscribers() {
                    unavailableFailures += 1;
                },
                poll() {
                    unavailableAttempts += 1;
                    throw Object.assign(new Error("io"), { code: "SQLITE_IOERR" });
                },
                recordRetryablePollRetry() {
                    unavailableRetries += 1;
                },
            }),
    });
    const unavailableProgram = RealtimeEventPumpService.use(() => Effect.yieldNow);

    await Effect.runPromise(provideTestClock(unavailableProgram, unavailableLayer));
    expect({ unavailableAttempts, unavailableFailures, unavailableRetries }).toEqual({
        unavailableAttempts: 1,
        unavailableFailures: 1,
        unavailableRetries: 0,
    });
});

test("caps exponential retry delays and resets them after a successful poll", async () => {
    let attempts = 0;
    const layer = realtimeEventPumpLayer({
        makePump: () =>
            makePort({
                poll() {
                    attempts += 1;
                    if ([1, 2, 3, 5].includes(attempts)) {
                        throw Object.assign(new Error("busy"), {
                            code: "SQLITE_BUSY",
                        });
                    }
                    return attempts === 4 ? "immediate" : "idle";
                },
            }),
        maximumRetryablePollRetries: 3,
        retryablePollBaseDelayMs: 10,
        retryablePollMaximumDelayMs: 15,
    });
    const program = RealtimeEventPumpService.use(() =>
        Effect.gen(function* () {
            yield* Effect.yieldNow;
            expect(attempts).toBe(1);
            yield* TestClock.adjust(9);
            expect(attempts).toBe(1);
            yield* TestClock.adjust(1);
            expect(attempts).toBe(2);
            yield* TestClock.adjust(14);
            expect(attempts).toBe(2);
            yield* TestClock.adjust(1);
            expect(attempts).toBe(3);
            yield* TestClock.adjust(15);
            expect(attempts).toBe(5);
            yield* TestClock.adjust(9);
            expect(attempts).toBe(5);
            yield* TestClock.adjust(1);
            expect(attempts).toBe(6);
        })
    );

    await Effect.runPromise(provideTestClock(program, layer));
});
