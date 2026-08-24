import { describe, expect, test } from "bun:test";

import { isTrackedEnvelope, TRPCError } from "@trpc/server";

import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import type { RequestAuthentication } from "../../../contracts/security.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import {
    RealtimeEventStoreStreamError,
    type RealtimeEventStreamOptions,
} from "../../platform/realtime/eventPumpService.ts";
import type { RenewableStreamLease } from "../../platform/realtime/renewableStreamLease.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestAutomationAuthentication,
    createTestApplicationRuntime,
    createTestRequestContext,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";

const authenticatedReportsReader = createTestAutomationAuthentication(["reports:read"]);

const delivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: monitoringRealtimeTopics.reports,
    },
    id: "1",
    kind: "change",
};

function oneValueAsyncIterable<TValue>(value: TValue): AsyncIterable<TValue> {
    return {
        [Symbol.asyncIterator]() {
            let emitted = false;
            return {
                next(): Promise<IteratorResult<TValue>> {
                    if (emitted) {
                        return Promise.resolve({ done: true, value: undefined });
                    }
                    emitted = true;
                    return Promise.resolve({ done: false, value });
                },
            };
        },
    };
}

function rejectedAsyncIterable<TValue>(error: Error): AsyncIterable<TValue> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<TValue>> {
                    throw error;
                },
            };
        },
    };
}

describe("events.stream procedure", () => {
    test("authorizes before opening one tracked runtime stream", async () => {
        const controller = new AbortController();
        let observedOptions: RealtimeEventStreamOptions | undefined;
        let observedLease: RenewableStreamLease | undefined;
        let signalWasAbortedWhenOpened: boolean | undefined;
        const runtime = createTestApplicationRuntime({
            stream(options, lease) {
                observedOptions = options;
                observedLease = lease;
                signalWasAbortedWhenOpened = options.signal?.aborted;
                return Promise.resolve(oneValueAsyncIterable(delivery));
            },
        });
        const context = await createTestRequestContext(
            authenticatedReportsReader,
            runtime
        );
        if (context.authenticationLease === undefined) {
            throw new Error("Expected an authenticated test context lease");
        }
        const caller = appRouter.createCaller(context, { signal: controller.signal });

        const results = await Array.fromAsync(
            await caller.events.stream({
                topics: [monitoringRealtimeTopics.reports],
            })
        );

        const observedSignal = observedOptions?.signal;
        expect(observedOptions?.afterId).toBe("0");
        expect(observedOptions?.topics).toEqual([monitoringRealtimeTopics.reports]);
        expect(observedSignal).toBeDefined();
        expect(observedSignal).toBe(controller.signal);
        expect(signalWasAbortedWhenOpened).toBe(false);
        expect(observedSignal?.aborted).toBe(false);
        expect(observedLease).toBeDefined();
        expect(observedLease?.expiresAtMs).toBe(context.authenticationLease.expiresAtMs);
        expect(typeof observedLease?.renew).toBe("function");
        expect(results).toHaveLength(1);
        expect(isTrackedEnvelope(results[0])).toBe(true);
        if (isTrackedEnvelope(results[0])) {
            expect(String(results[0][0])).toBe("1");
            expect(results[0][1]).toMatchObject({
                event: { payload: { id: "report-1" } },
                kind: "change",
            });
        }
    });

    test("rejects unauthenticated and under-capability callers before runtime access", async () => {
        let streamCalls = 0;
        const runtime = createTestApplicationRuntime({
            stream() {
                streamCalls += 1;
                return Promise.reject(
                    new Error("Unauthorized caller reached the realtime runtime")
                );
            },
        });
        const authenticationCases: RequestAuthentication[] = [
            { kind: "anonymous" },
            { kind: "invalid" },
            {
                ...createTestAutomationAuthentication(["notifications:read"]),
            },
        ];

        const failures: unknown[] = [];
        for (const authentication of authenticationCases) {
            const context = await createTestRequestContext(authentication, runtime);
            const caller = appRouter.createCaller(context, {
                signal: new AbortController().signal,
            });
            failures.push(
                await captureFailure(async () =>
                    Array.fromAsync(
                        await caller.events.stream({
                            topics: [monitoringRealtimeTopics.reports],
                        })
                    )
                )
            );
        }

        expect(streamCalls).toBe(0);
        expect(failures).toHaveLength(3);
        expect(failures.every((failure) => failure instanceof TRPCError)).toBe(true);
        expect((failures[0] as TRPCError).code).toBe("UNAUTHORIZED");
        expect((failures[1] as TRPCError).code).toBe("UNAUTHORIZED");
        expect((failures[2] as TRPCError).code).toBe("FORBIDDEN");
    });

    test("maps typed Effect stream failures and preserves unknown defects", async () => {
        const typedFailure = new RealtimeEventStoreStreamError({
            message: "internal store detail",
        });
        const defect = new Error("internal invariant detail");

        for (const [failure, expected] of [
            [typedFailure, "SERVICE_UNAVAILABLE"],
            [defect, undefined],
        ] as const) {
            const runtime = createTestApplicationRuntime({
                stream: () =>
                    Promise.resolve(
                        rejectedAsyncIterable<RealtimeEventDelivery>(failure)
                    ),
            });
            const context = await createTestRequestContext(
                authenticatedReportsReader,
                runtime
            );
            const caller = appRouter.createCaller(context, {
                signal: new AbortController().signal,
            });
            const observed = await captureFailure(async () =>
                Array.fromAsync(
                    await caller.events.stream({
                        topics: [monitoringRealtimeTopics.reports],
                    })
                )
            );

            if (expected === undefined) {
                expect(observed).toBe(defect);
            } else {
                expect(observed).toBeInstanceOf(TRPCError);
                expect((observed as TRPCError).code).toBe(expected);
                expect((observed as TRPCError).message).not.toContain("internal");
            }
        }
    });
});
