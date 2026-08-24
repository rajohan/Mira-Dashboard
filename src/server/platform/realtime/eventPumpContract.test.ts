import { describe, expect, test } from "bun:test";

import { realtimeEventDeliveryMaximumBytes } from "../../../contracts/realtime.ts";
import {
    RealtimeCursorError,
    RealtimeEventPump,
    RealtimeSubscriptionInputError,
} from "./eventPump.ts";
import { realtimeEventStoreLimits, type RealtimeEventStore } from "./eventStore.ts";
import {
    captureRejection,
    dataFreeStore,
    emptyRealtimeEventStore,
    waitForCondition,
} from "./testSupport/eventPump.ts";

describe("realtime event pump", () => {
    test("rejects malformed and ahead-of-tail cursors without event data", async () => {
        const store: RealtimeEventStore = {
            readBatch(): never {
                throw new Error("Expected cursor validation before reading a batch");
            },
            readCursorBounds() {
                return {
                    latestIssuedId: 3,
                    newestRetainedId: null,
                    oldestRetainedId: null,
                };
            },
            readCursorWindow(): never {
                throw new Error("Expected no retained-row sample during subscription");
            },
        };
        const pump = new RealtimeEventPump({ store });

        try {
            const ahead = pump.subscribe({
                afterId: "4",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(ahead.next())).toMatchObject({
                code: "ahead-of-tail",
                name: "RealtimeCursorError",
            } satisfies Partial<RealtimeCursorError>);
            const malformed = pump.subscribe({
                afterId: "01",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(malformed.next())).toMatchObject({
                code: "invalid",
                name: "RealtimeCursorError",
            } satisfies Partial<RealtimeCursorError>);
            const oversized = pump.subscribe({
                afterId: "9".repeat(10_000),
                signal: new AbortController().signal,
            });
            expect(await captureRejection(oversized.next())).toMatchObject({
                code: "invalid",
                name: "RealtimeCursorError",
            } satisfies Partial<RealtimeCursorError>);
        } finally {
            pump.close();
        }
    });

    test("validates topic count and length boundaries without reading event data", async () => {
        const pump = new RealtimeEventPump({
            store: dataFreeStore,
        });
        const abortController = new AbortController();
        abortController.abort();
        const signal = abortController.signal;
        const invalidTopics: readonly (readonly string[])[] = [
            [],
            Array.from({ length: 65 }, (_, index) => `topic-${index}`),
            [""],
            [" topic.a"],
            ["topic.a "],
            ["x".repeat(129)],
        ];

        try {
            for (const topics of invalidTopics) {
                const subscription = pump.subscribe({
                    afterId: "0",
                    signal,
                    topics,
                });
                expect(await captureRejection(subscription.next())).toMatchObject({
                    code: "invalid-topics",
                    name: "RealtimeSubscriptionInputError",
                } satisfies Partial<RealtimeSubscriptionInputError>);
            }

            const exactTopicCount = pump.subscribe({
                afterId: "0",
                signal,
                topics: Array.from({ length: 64 }, (_, index) => `topic-${index}`),
            });
            const exactTopicCountResult = await exactTopicCount.next();
            expect(exactTopicCountResult.done).toBeTrue();

            const exactTopicLength = pump.subscribe({
                afterId: "0",
                signal,
                topics: ["x".repeat(128)],
            });
            const exactTopicLengthResult = await exactTopicLength.next();
            expect(exactTopicLengthResult.done).toBeTrue();
        } finally {
            pump.close();
        }
    });

    test("rejects subscriptions above the process-local capacity", async () => {
        const pump = new RealtimeEventPump({
            maximumSubscribers: 1,
            store: emptyRealtimeEventStore,
        });
        const firstAbort = new AbortController();
        const first = pump.subscribe({ afterId: "0", signal: firstAbort.signal });
        const firstPending = first.next();

        try {
            await waitForCondition(
                () => pump.metricsSnapshot().activeSubscribers === 1,
                "first realtime subscriber to attach"
            );
            const second = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(second.next())).toMatchObject({
                code: "capacity-exceeded",
                name: "RealtimeSubscriptionInputError",
            } satisfies Partial<RealtimeSubscriptionInputError>);
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 1,
                subscriberCapacityRejections: 1,
            });
        } finally {
            firstAbort.abort();
            expect(await firstPending).toEqual({ done: true, value: undefined });
            pump.close();
        }
    });

    test("counts subscriptions still opening toward process-local capacity", async () => {
        let releaseRead: (() => void) | undefined;
        let signalReadStarted: (() => void) | undefined;
        const readStarted = new Promise<void>((resolve) => {
            signalReadStarted = resolve;
        });
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        const pump = new RealtimeEventPump({
            maximumSubscribers: 1,
            readSubscriptionStore: async (read) => {
                signalReadStarted?.();
                await readGate;
                return read();
            },
            store: emptyRealtimeEventStore,
        });
        const firstAbort = new AbortController();
        const first = pump.subscribe({ afterId: "0", signal: firstAbort.signal });
        const firstPending = first.next();

        try {
            await readStarted;
            const second = pump.subscribe({
                afterId: "0",
                signal: new AbortController().signal,
            });
            expect(await captureRejection(second.next())).toMatchObject({
                code: "capacity-exceeded",
                name: "RealtimeSubscriptionInputError",
            } satisfies Partial<RealtimeSubscriptionInputError>);
            expect(pump.metricsSnapshot()).toMatchObject({
                activeSubscribers: 0,
                subscriberCapacityRejections: 1,
            });
        } finally {
            releaseRead?.();
            firstAbort.abort();
            expect(await firstPending).toEqual({ done: true, value: undefined });
            pump.close();
        }
    });

    test("fails a subscription that is still opening when the runner fails", async () => {
        let signalReadStarted: (() => void) | undefined;
        const readStarted = new Promise<void>((resolve) => {
            signalReadStarted = resolve;
        });
        const pump = new RealtimeEventPump({
            readSubscriptionStore: <A>(_read: () => A, signal: AbortSignal) =>
                new Promise<A>((_resolve, reject) => {
                    signalReadStarted?.();
                    const rejectWithAbortReason = (): void => {
                        const reason: unknown = signal.reason;
                        reject(
                            reason instanceof Error
                                ? reason
                                : new Error("Subscription opening aborted", {
                                      cause: reason,
                                  })
                        );
                    };
                    if (signal.aborted) {
                        rejectWithAbortReason();
                        return;
                    }
                    signal.addEventListener("abort", rejectWithAbortReason, {
                        once: true,
                    });
                }),
            store: dataFreeStore,
        });
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });
        const pending = subscription.next();

        try {
            await readStarted;
            const runnerFailure = new Error("Realtime event runner failed");
            pump.failSubscribers(runnerFailure);

            expect(await captureRejection(pending)).toBe(runnerFailure);
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            pump.close();
        }
    });

    test("cleans up an attached subscriber when the poll request callback fails", async () => {
        const pump = new RealtimeEventPump({
            requestPoll: () => {
                throw new Error("Poll request failed");
            },
            store: emptyRealtimeEventStore,
        });
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });

        try {
            expect(await captureRejection(subscription.next())).toMatchObject({
                message: "Poll request failed",
            });
            expect(pump.metricsSnapshot().activeSubscribers).toBe(0);
        } finally {
            pump.close();
        }
    });

    test("rejects poll and subscribe after the pump is closed", async () => {
        const pump = new RealtimeEventPump({ store: dataFreeStore });
        pump.close();

        expect(() => pump.poll()).toThrow("Realtime event pump is closed");
        const subscription = pump.subscribe({
            afterId: "0",
            signal: new AbortController().signal,
        });
        expect(await captureRejection(subscription.next())).toMatchObject({
            message: "Realtime event pump is closed",
        });
    });

    test("validates the store-backed page budget before polling", () => {
        const invalidMaximumPageEvents = [
            0,
            1.5,
            realtimeEventStoreLimits.maximumPageEvents + 1,
        ];

        for (const maximumPageEvents of invalidMaximumPageEvents) {
            expect(
                () =>
                    new RealtimeEventPump({
                        maximumPageEvents,
                        store: dataFreeStore,
                    })
            ).toThrow(RangeError);
        }

        expect(
            () =>
                new RealtimeEventPump({
                    maximumEventDeliveryBytes: realtimeEventDeliveryMaximumBytes + 1,
                    store: dataFreeStore,
                })
        ).toThrow(
            "Realtime maximum event delivery bytes exceeds the durable wire budget"
        );

        expect(
            () =>
                new RealtimeEventPump({
                    maximumPageEvents: 4,
                    maximumSubscriberQueueEvents: 3,
                    store: dataFreeStore,
                })
        ).toThrow(
            "Realtime subscriber queue event budget cannot hold one synchronous page"
        );
        expect(
            () =>
                new RealtimeEventPump({
                    maximumEventDeliveryBytes: 256,
                    maximumPageEvents: 4,
                    maximumSubscriberQueueEvents: 4,
                    maximumSubscriberQueuedDeliveryBytes: 1023,
                    store: dataFreeStore,
                })
        ).toThrow(
            "Realtime subscriber queue byte budget cannot hold one synchronous page"
        );

        const boundaryPump = new RealtimeEventPump({
            maximumEventDeliveryBytes: realtimeEventDeliveryMaximumBytes,
            maximumPageEvents: realtimeEventStoreLimits.maximumPageEvents,
            maximumSubscriberQueueEvents: realtimeEventStoreLimits.maximumPageEvents,
            maximumSubscriberQueuedDeliveryBytes:
                realtimeEventStoreLimits.maximumPageEvents *
                realtimeEventDeliveryMaximumBytes,
            store: dataFreeStore,
        });
        boundaryPump.close();
    });
});
