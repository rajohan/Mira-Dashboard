import { describe, expect, test } from "bun:test";

import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
    taskNotificationSendTimeoutMilliseconds,
    type ClaimedTaskNotification,
    type TaskNotificationChatSender,
    type TaskNotificationQueue,
} from "../shared/taskNotifications.ts";
import {
    processTaskNotificationBatch,
    TaskNotificationLeaseLostError,
    taskNotificationRetryDelayMs,
} from "./taskNotifications.ts";

const firstEventId = "019fd300-0000-7000-8000-000000000001";
const secondEventId = "019fd300-0000-7000-8000-000000000002";
const workerId = "019fd300-0000-7000-8000-000000000003";

function claimed(
    eventId: string,
    attemptCount: number,
    message: string
): ClaimedTaskNotification {
    return { attemptCount, eventId, message };
}

describe("task notification worker", () => {
    test("delivers sequentially and retries failures with stable Gateway identities", async () => {
        const delivered: string[] = [];
        const retried: {
            availableAtMs: number;
            eventId: string;
            settledAtMs: number;
        }[] = [];
        const sent: { idempotencyKey: string; message: string; sessionKey: string }[] =
            [];
        const queue: TaskNotificationQueue = {
            claim: () =>
                Promise.resolve([
                    claimed(firstEventId, 1, "First notification"),
                    claimed(secondEventId, 2, "Second notification"),
                ]),
            markDelivered: (input) => {
                delivered.push(input.eventId);
                return Promise.resolve(true);
            },
            retryLater: (input) => {
                retried.push(input);
                return Promise.resolve(true);
            },
        };
        const sender: TaskNotificationChatSender = {
            send: (input) => {
                sent.push(input);
                return input.message === "Second notification"
                    ? Promise.reject(new Error("Gateway unavailable"))
                    : Promise.resolve();
            },
        };

        expect(
            await Effect.runPromise(
                processTaskNotificationBatch({
                    nowMs: () => 1000,
                    queue,
                    sender,
                    workerId,
                })
            )
        ).toEqual({ claimed: 2, delivered: 1, retried: 1 });
        expect(delivered).toEqual([firstEventId]);
        expect(retried).toEqual([
            {
                availableAtMs: 11_000,
                eventId: secondEventId,
                settledAtMs: 1000,
                workerId,
            },
        ]);
        expect(sent).toEqual([
            {
                idempotencyKey: `tasks-notify-${firstEventId}`,
                message: "First notification",
                sessionKey: "agent:main:main",
            },
            {
                idempotencyKey: `tasks-notify-${secondEventId}`,
                message: "Second notification",
                sessionKey: "agent:main:main",
            },
        ]);
    });

    test("fails closed when a successful send loses its delivery lease", async () => {
        const queue: TaskNotificationQueue = {
            claim: () =>
                Promise.resolve([claimed(firstEventId, 1, "First notification")]),
            markDelivered: () => Promise.resolve(false),
            retryLater: () => Promise.resolve(true),
        };
        const sender: TaskNotificationChatSender = {
            send: () => Promise.resolve(),
        };

        const failure = await Effect.runPromise(
            Effect.flip(processTaskNotificationBatch({ queue, sender, workerId }))
        );
        expect(failure).toBeInstanceOf(TaskNotificationLeaseLostError);
        expect(failure).toMatchObject({
            eventId: firstEventId,
            operation: "deliver",
        });
    });

    test("releases the active claim before worker interruption completes", async () => {
        let started: (() => void) | undefined;
        const senderStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const retried: string[] = [];
        const queue: TaskNotificationQueue = {
            claim: () =>
                Promise.resolve([claimed(firstEventId, 1, "First notification")]),
            markDelivered: () => Promise.resolve(true),
            retryLater: (input) => {
                retried.push(input.eventId);
                return Promise.resolve(true);
            },
        };
        const sender: TaskNotificationChatSender = {
            send: (_input, signal) =>
                new Promise((_resolve, reject) => {
                    started?.();
                    signal.addEventListener(
                        "abort",
                        () =>
                            reject(
                                signal.reason instanceof Error
                                    ? signal.reason
                                    : new DOMException(
                                          "Task notification send aborted",
                                          "AbortError"
                                      )
                            ),
                        { once: true }
                    );
                }),
        };
        const fiber = Effect.runFork(
            processTaskNotificationBatch({ queue, sender, workerId })
        );

        await senderStarted;
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(retried).toEqual([firstEventId]);
    });

    test("aborts a stalled Gateway send before its lease can expire", async () => {
        let sendSignal: AbortSignal | undefined;
        const retried: string[] = [];
        const queue: TaskNotificationQueue = {
            claim: () =>
                Promise.resolve([claimed(firstEventId, 1, "First notification")]),
            markDelivered: () => Promise.resolve(true),
            retryLater: (input) => {
                retried.push(input.eventId);
                return Promise.resolve(true);
            },
        };
        const sender: TaskNotificationChatSender = {
            send: (_input, signal) => {
                sendSignal = signal;
                return new Promise(() => {});
            },
        };
        const program = Effect.gen(function* () {
            const fiber = yield* processTaskNotificationBatch({
                nowMs: () => 1000,
                queue,
                sender,
                workerId,
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(taskNotificationSendTimeoutMilliseconds);
            return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer()));

        expect(await Effect.runPromise(program)).toEqual({
            claimed: 1,
            delivered: 0,
            retried: 1,
        });
        expect(sendSignal?.aborted).toBeTrue();
        expect(retried).toEqual([firstEventId]);
    });

    test("caps exponential retry delay and rejects invalid attempts", () => {
        expect(taskNotificationRetryDelayMs(1)).toBe(5000);
        expect(taskNotificationRetryDelayMs(2)).toBe(10_000);
        expect(taskNotificationRetryDelayMs(1000)).toBe(300_000);
        expect(() => taskNotificationRetryDelayMs(0)).toThrow(RangeError);
    });
});
