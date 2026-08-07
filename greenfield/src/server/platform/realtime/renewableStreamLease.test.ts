import { describe, expect, test } from "bun:test";

import { addSeconds, getTime, secondsToMilliseconds } from "date-fns";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { rejectOnAbort } from "../../test/support/promise.ts";
import {
    type RenewableStreamLease,
    RenewableStreamLeaseInvalidError,
    RenewableStreamLeaseTimeoutError,
    withRenewableStreamLease,
} from "./renewableStreamLease.ts";

const oneMillisecondMs = secondsToMilliseconds(0.001);
const justBeforeOneSecondMs = secondsToMilliseconds(0.999);
const oneSecondMs = secondsToMilliseconds(1);
const renewalTimeoutMs = secondsToMilliseconds(5);

function provideTestClock<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.provide(effect, TestClock.layer());
}

function createPendingSource() {
    let nextCalls = 0;
    let returnCalls = 0;
    const started = Promise.withResolvers<void>();
    const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
            return {
                next() {
                    nextCalls += 1;
                    started.resolve();
                    return new Promise<IteratorResult<string>>(() => {
                        // This source deliberately remains pending until its iterator closes.
                    });
                },
                return() {
                    returnCalls += 1;
                    return Promise.resolve({
                        done: true,
                        value: undefined,
                    });
                },
            };
        },
    };

    return {
        nextCalls: () => nextCalls,
        returnCalls: () => returnCalls,
        started: started.promise,
        stream: Stream.fromAsyncIterable(iterable, (error) => error),
    };
}

describe("renewable Effect stream lease", () => {
    test("renews one quiet pending pull without starting another", async () => {
        let pulls = 0;
        let renewals = 0;
        const leaseAt = (expiresAtMs: number): RenewableStreamLease => ({
            expiresAtMs,
            renew: () => {
                renewals += 1;
                const renewedExpiryMs = getTime(addSeconds(expiresAtMs, 1));
                return Promise.resolve(leaseAt(renewedExpiryMs));
            },
        });
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const delivery = yield* Deferred.make<string>();
            const source = Stream.fromEffect(
                Effect.gen(function* () {
                    pulls += 1;
                    return yield* Deferred.await(delivery);
                })
            );
            const fiber = yield* withRenewableStreamLease(
                source,
                leaseAt(oneSecondMs)
            ).pipe(Stream.runCollect, Effect.forkChild);
            yield* TestClock.adjust(justBeforeOneSecondMs);
            expect(pulls).toBe(1);
            expect(renewals).toBe(0);

            yield* TestClock.adjust(oneMillisecondMs);
            yield* Effect.yieldNow;
            expect(renewals).toBe(1);
            expect(pulls).toBe(1);

            yield* TestClock.adjust(oneSecondMs);
            yield* Effect.yieldNow;
            expect(renewals).toBe(2);
            expect(pulls).toBe(1);

            yield* Deferred.succeed(delivery, "event");
            return yield* Fiber.join(fiber);
        });

        expect([...(await Effect.runPromise(provideTestClock(program)))]).toEqual([
            "event",
        ]);
    });

    test("reauthorizes at the deadline before releasing a simultaneous event", async () => {
        const renewalFailure = new Error("renewal denied");
        const lease: RenewableStreamLease = {
            expiresAtMs: oneSecondMs,
            renew: () => Promise.reject(renewalFailure),
        };
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const source = Stream.fromEffect(
                Effect.sleep(oneSecondMs).pipe(Effect.as("must-not-leak"))
            );
            const fiber = yield* withRenewableStreamLease(source, lease).pipe(
                Stream.runCollect,
                Effect.flip,
                Effect.forkChild
            );

            yield* TestClock.adjust(oneSecondMs);
            return yield* Fiber.join(fiber);
        });

        expect(await Effect.runPromise(provideTestClock(program))).toBe(renewalFailure);
    });

    test("fails once when renewal returns an expired lease", async () => {
        let pulls = 0;
        let renewals = 0;
        const lease: RenewableStreamLease = {
            expiresAtMs: 0,
            renew: () => {
                renewals += 1;
                return Promise.resolve(lease);
            },
        };
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const source = Stream.fromEffect(
                Effect.sync(() => {
                    pulls += 1;
                    return "must-not-leak";
                })
            );
            return yield* withRenewableStreamLease(source, lease).pipe(
                Stream.runCollect,
                Effect.flip
            );
        });

        const failure = await Effect.runPromise(provideTestClock(program));
        expect(failure).toBeInstanceOf(RenewableStreamLeaseInvalidError);
        expect(pulls).toBe(0);
        expect(renewals).toBe(1);
    });

    test("finalizes a pending upstream pull when renewal fails", async () => {
        const renewalFailure = new Error("renewal denied");
        const source = createPendingSource();
        const lease: RenewableStreamLease = {
            expiresAtMs: oneSecondMs,
            renew: () => Promise.reject(renewalFailure),
        };
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* withRenewableStreamLease(source.stream, lease).pipe(
                Stream.runCollect,
                Effect.flip,
                Effect.forkChild
            );
            yield* Effect.promise(() => source.started);
            expect(source.nextCalls()).toBe(1);

            yield* TestClock.adjust(oneSecondMs);
            return yield* Fiber.join(fiber);
        });

        expect(await Effect.runPromise(provideTestClock(program))).toBe(renewalFailure);
        expect(source.returnCalls()).toBe(1);
    });

    test("reauthorizes every element of a multi-element source chunk", async () => {
        const renewalFailure = new Error("renewal denied");
        const lease: RenewableStreamLease = {
            expiresAtMs: oneSecondMs,
            renew: () => Promise.reject(renewalFailure),
        };
        let seen: string[] = [];
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            return yield* withRenewableStreamLease(
                Stream.fromIterable(["first", "second"]),
                lease
            ).pipe(
                Stream.runForEach((value) =>
                    Effect.gen(function* () {
                        seen = [...seen, value];
                        if (value === "first") {
                            yield* TestClock.adjust(oneSecondMs);
                        }
                    })
                ),
                Effect.flip
            );
        });

        expect(await Effect.runPromise(provideTestClock(program))).toBe(renewalFailure);
        expect(seen).toEqual(["first"]);
    });

    test("times out a hanging renewal and finalizes its pending upstream pull", async () => {
        let renewalSignal: AbortSignal | undefined;
        const source = createPendingSource();
        const lease: RenewableStreamLease = {
            expiresAtMs: oneSecondMs,
            renew: (signal) => {
                renewalSignal = signal;
                return rejectOnAbort(signal, "Realtime lease renewal aborted");
            },
        };
        const program = Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const fiber = yield* withRenewableStreamLease(source.stream, lease).pipe(
                Stream.runCollect,
                Effect.flip,
                Effect.forkChild
            );
            yield* Effect.promise(() => source.started);
            expect(source.nextCalls()).toBe(1);

            yield* TestClock.adjust(oneSecondMs);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(renewalTimeoutMs);
            const failure = yield* Fiber.join(fiber);
            return {
                failure,
                signalAborted: renewalSignal?.aborted,
                sourceReturnCalls: source.returnCalls(),
            };
        });

        const result = await Effect.runPromise(provideTestClock(program));
        expect(result.failure).toBeInstanceOf(RenewableStreamLeaseTimeoutError);
        expect(result.signalAborted).toBe(true);
        expect(result.sourceReturnCalls).toBe(1);
    });
});
