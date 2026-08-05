import { describe, expect, test } from "bun:test";

import { addMilliseconds, secondsToMilliseconds } from "date-fns";
import { Effect, Layer, Stream } from "effect";

import { withTestTimeout } from "../../test/support/promise.ts";
import type { RealtimeEventDelivery } from "../realtime/eventPump.ts";
import {
    isRealtimeEventStreamError,
    RealtimeEventPumpService,
    RealtimeEventStoreStreamError,
} from "../realtime/eventPumpService.ts";
import type { RenewableStreamLease } from "../realtime/renewableStreamLease.ts";
import { createApplicationRuntime } from "./applicationRuntime.ts";

const delivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: "monitoring.reports",
    },
    id: "1",
    kind: "change",
};

describe("application Effect runtime", () => {
    test("builds one shared layer and disposes its scope exactly once", async () => {
        let acquisitions = 0;
        let releases = 0;
        let observedSignal: AbortSignal | undefined;
        const layer = Layer.effect(
            RealtimeEventPumpService,
            Effect.acquireRelease(
                Effect.sync(() => {
                    acquisitions += 1;
                    return RealtimeEventPumpService.of({
                        metricsSnapshot: Effect.die("metrics are not used in this test"),
                        stream: (options) => {
                            observedSignal = options.signal;
                            return Stream.make(delivery);
                        },
                        wake: Effect.void,
                    });
                }),
                () =>
                    Effect.sync(() => {
                        releases += 1;
                    })
            )
        );
        const runtime = createApplicationRuntime({ realtimeEventPumpLayer: layer });
        const controller = new AbortController();

        await runtime.initialize();
        await runtime.initialize();
        expect(acquisitions).toBe(1);
        expect(Object.isFrozen(runtime)).toBe(true);
        expect(Object.isFrozen(runtime.services)).toBe(true);
        expect(Object.isFrozen(runtime.services.realtimeEvents)).toBe(true);

        const values = await Array.fromAsync(
            await runtime.services.realtimeEvents.stream({
                afterId: "0",
                signal: controller.signal,
            })
        );
        expect(values).toEqual([delivery]);
        expect(observedSignal).toBe(controller.signal);

        await runtime.dispose();
        await runtime.dispose();
        expect(releases).toBe(1);
    });

    test("preserves typed failures across the async-iterator boundary", async () => {
        const expected = new RealtimeEventStoreStreamError({
            message: "simulated event-store failure",
        });
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => Stream.fail(expected),
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({ realtimeEventPumpLayer: layer });
        let observed: unknown;

        try {
            const deliveries = await runtime.services.realtimeEvents.stream({
                afterId: "0",
            });
            await Array.fromAsync(deliveries);
        } catch (error) {
            observed = error;
        } finally {
            await runtime.dispose();
        }

        expect(observed).toBe(expected);
        expect(isRealtimeEventStreamError(observed)).toBe(true);
    });

    test("releases a subscription scope when an async consumer stops early", async () => {
        let acquisitions = 0;
        let releases = 0;
        const scopedDelivery = Effect.acquireRelease(
            Effect.sync(() => {
                acquisitions += 1;
                return delivery;
            }),
            () =>
                Effect.sync(() => {
                    releases += 1;
                })
        );
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => Stream.scoped(Stream.fromEffect(scopedDelivery)),
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({ realtimeEventPumpLayer: layer });
        const deliveries = await runtime.services.realtimeEvents.stream({
            afterId: "0",
        });

        try {
            for await (const value of deliveries) {
                expect(value).toBe(delivery);
                break;
            }

            expect(acquisitions).toBe(1);
            expect(releases).toBe(1);
        } finally {
            await runtime.dispose();
        }
    });

    test("interrupts a quiet pull and its renewal when the client aborts", async () => {
        const leaseDurationMs = secondsToMilliseconds(1);
        const testTimeoutMs = secondsToMilliseconds(3);
        const sourceStarted = Promise.withResolvers<void>();
        const renewalStarted = Promise.withResolvers<AbortSignal>();
        let sourceReleases = 0;
        const sourceLease = Effect.acquireRelease(
            Effect.sync(() => {
                sourceStarted.resolve();
            }),
            () =>
                Effect.sync(() => {
                    sourceReleases += 1;
                })
        );
        const pendingSource = sourceLease.pipe(Effect.flatMap(() => Effect.never));
        const source = Stream.scoped(Stream.fromEffect(pendingSource));
        const layer = Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: Effect.die("metrics are not used in this test"),
                stream: () => source,
                wake: Effect.void,
            })
        );
        const runtime = createApplicationRuntime({ realtimeEventPumpLayer: layer });
        const controller = new AbortController();
        let iterator: AsyncIterator<RealtimeEventDelivery> | undefined;

        try {
            await runtime.initialize();
            const lease: RenewableStreamLease = {
                expiresAtMs: addMilliseconds(new Date(), leaseDurationMs).getTime(),
                renew(signal) {
                    renewalStarted.resolve(signal);
                    return new Promise<RenewableStreamLease>((_resolve, reject) => {
                        const rejectWithAbortReason = (): void => {
                            const reason: unknown = signal.reason;
                            reject(
                                reason instanceof Error
                                    ? reason
                                    : new Error("Realtime lease renewal aborted", {
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
                    });
                },
            };
            const deliveries = await runtime.services.realtimeEvents.stream(
                {
                    afterId: "0",
                    signal: controller.signal,
                },
                lease
            );
            iterator = deliveries[Symbol.asyncIterator]();
            const next = iterator.next();

            await withTestTimeout(
                sourceStarted.promise,
                testTimeoutMs,
                "quiet source pull did not start"
            );
            const renewalSignal = await withTestTimeout(
                renewalStarted.promise,
                testTimeoutMs,
                "quiet source pull was not revalidated"
            );
            controller.abort();
            const result = await withTestTimeout(
                next,
                testTimeoutMs,
                "client abort did not stop the realtime iterator"
            );

            expect(result.done).toBe(true);
            expect(renewalSignal.aborted).toBe(true);
            expect(sourceReleases).toBe(1);
        } finally {
            controller.abort();
            await iterator?.return?.();
            await runtime.dispose();
        }
    });
});
