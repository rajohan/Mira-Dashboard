import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import {
    AsyncCleanupDeadlineError,
    AsyncCleanupOperationError,
    AsyncCleanupStack,
} from "./asyncCleanupStack.ts";

describe("asynchronous qualification cleanup stack", () => {
    test("runs every cleanup in LIFO order and tags operational failures", async () => {
        const cleanup = new AsyncCleanupStack();
        const order: string[] = [];
        const operationFailure = new Error("fixture cleanup failed");

        cleanup.defer("first", () => {
            order.push("first");
        });
        cleanup.defer("failing", () => {
            order.push("failing");
            throw operationFailure;
        });
        cleanup.defer("last", async () => {
            await Promise.resolve();
            order.push("last");
        });

        const outcome = await Effect.runPromise(
            cleanup.disposeEffect().pipe(Effect.result)
        );
        expect(order).toEqual(["last", "failing", "first"]);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isSuccess(outcome)) return;
        expect(outcome.failure).toBeInstanceOf(AggregateError);
        const failures = outcome.failure.errors as unknown[];
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(AsyncCleanupOperationError);
        expect(failures[0]).toMatchObject({
            cause: operationFailure,
            label: "failing",
            message: "failing cleanup failed",
        });

        await cleanup.dispose();
    });

    test("interrupts a timed-out cleanup and continues with older resources", async () => {
        const cleanup = new AsyncCleanupStack();
        const order: string[] = [];
        let cleanupSignal: AbortSignal | undefined;

        cleanup.defer("after deadline", () => {
            order.push("after deadline");
        });
        cleanup.defer("pending", (signal) => {
            cleanupSignal = signal;
            order.push("pending");
            return new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
        });

        const program = Effect.gen(function* () {
            const fiber = yield* cleanup
                .disposeEffect(25)
                .pipe(Effect.result, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(25);
            yield* Effect.yieldNow;
            return yield* Fiber.join(fiber);
        });
        const outcome = await Effect.runPromise(
            Effect.provide(program, TestClock.layer())
        );

        expect(cleanupSignal?.aborted).toBe(true);
        expect(order).toEqual(["pending", "after deadline"]);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isSuccess(outcome)) return;
        expect(outcome.failure).toBeInstanceOf(AggregateError);
        const failures = outcome.failure.errors as unknown[];
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(AsyncCleanupDeadlineError);
        expect(failures[0]).toMatchObject({
            label: "pending",
            message: "pending did not stop within 25 ms",
            timeoutMs: 25,
        });
    });

    test("drains older resources before honoring external interruption", async () => {
        const cleanup = new AsyncCleanupStack();
        const order: string[] = [];

        cleanup.defer("older", () => {
            order.push("older");
        });
        cleanup.defer("pending", (signal) => {
            order.push("pending");
            return new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
        });

        const program = Effect.gen(function* () {
            const cleanupFiber = yield* cleanup.disposeEffect(25).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            const interruptionFiber = yield* Fiber.interrupt(cleanupFiber).pipe(
                Effect.forkChild
            );
            yield* Effect.yieldNow;
            yield* TestClock.adjust(25);
            yield* Fiber.join(interruptionFiber);
        });
        await Effect.runPromise(Effect.provide(program, TestClock.layer()));

        expect(order).toEqual(["pending", "older"]);
    });
});
