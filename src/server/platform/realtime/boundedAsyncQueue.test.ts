import { expect, test } from "bun:test";

import {
    BoundedAsyncQueue,
    BoundedAsyncQueueOverflowError,
} from "./boundedAsyncQueue.ts";

test("returns and reuses the terminal overflow failure", async () => {
    const queue = new BoundedAsyncQueue<string>({
        maximumEvents: 1,
        maximumPayloadBytes: 8,
        overflowErrorMessage: "queue overflow",
    });

    expect(queue.push("first", 5)).toMatchObject({
        accepted: true,
        queuedEventCount: 1,
        queuedPayloadBytes: 5,
    });
    const rejected = queue.push("second", 4);
    expect(rejected).toMatchObject({
        accepted: false,
        queuedEventCount: 0,
        queuedPayloadBytes: 0,
    });
    expect(rejected.failure).toBeInstanceOf(BoundedAsyncQueueOverflowError);
    expect(rejected.failure?.message).toBe("queue overflow");

    let observedFailure: unknown;
    try {
        await queue.next();
    } catch (error) {
        observedFailure = error;
    }
    expect(observedFailure).toBe(rejected.failure);
    expect(queue.push("third", 1).failure).toBe(rejected.failure);
});

test("distinguishes a closed queue from an overflowed queue", async () => {
    const queue = new BoundedAsyncQueue<string>({
        maximumEvents: 1,
        maximumPayloadBytes: 8,
        overflowErrorMessage: "queue overflow",
    });

    queue.close();

    expect(queue.push("ignored", 1)).toEqual({
        accepted: false,
        queuedEventCount: 0,
        queuedPayloadBytes: 0,
    });
    expect(await queue.next()).toEqual({ done: true, value: undefined });
});

test("validates queue limits and payload sizes through the shared schemas", () => {
    expect(
        () =>
            new BoundedAsyncQueue<string>({
                maximumEvents: 0,
                maximumPayloadBytes: 8,
                overflowErrorMessage: "queue overflow",
            })
    ).toThrow(
        new RangeError(
            "Bounded async queue maximum events must be a positive safe integer"
        )
    );

    const queue = new BoundedAsyncQueue<string>({
        maximumEvents: 1,
        maximumPayloadBytes: 8,
        overflowErrorMessage: "queue overflow",
    });
    expect(() => queue.push("invalid", -1)).toThrow(
        new RangeError(
            "Bounded async queue payload bytes must be a nonnegative safe integer"
        )
    );
});
