import { describe, expect, test } from "bun:test";

import { getTime } from "date-fns";
import * as v from "valibot";

import { gatewayRealtimeTopics } from "../../../contracts/gatewayRealtime.ts";
import { realtimeEventRetentionMilliseconds } from "../../../contracts/realtime.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import { waitForCondition } from "../realtime/testSupport/eventPump.ts";
import type { PersistentGatewayEventName } from "./persistentGatewayProtocol.ts";
import {
    createPersistentGatewayRealtimeBridge,
    type PersistentGatewayRealtimeBridgeFailure,
    type PersistentGatewayRealtimeEventInsert,
    type PersistentGatewayRealtimeBridgeScheduler,
} from "./persistentGatewayRealtimeBridge.ts";
import type {
    PersistentGatewayConnectionSnapshot,
    PersistentGatewayListener,
} from "./persistentGatewayTransport.ts";

class FakeGatewaySubscription {
    listener: PersistentGatewayListener | undefined;
    unsubscribeCalls = 0;

    readonly transport = Object.freeze({
        subscribe: (listener: PersistentGatewayListener) => {
            this.listener = listener;
            let active = true;
            return () => {
                if (!active) return;
                active = false;
                this.unsubscribeCalls += 1;
                if (this.listener === listener) this.listener = undefined;
            };
        },
    });

    emitEvent(event: PersistentGatewayEventName): void {
        this.listener?.onEvent?.({
            connectionGeneration: 1,
            frame: { event, type: "event" },
            receivedAtMs: 1000,
        });
    }

    emitGap(): void {
        this.listener?.onEventGap?.({
            connectionGeneration: 1,
            expectedSequence: 10,
            receivedSequence: 12,
        });
    }

    emitState(
        phase: PersistentGatewayConnectionSnapshot["phase"],
        connectionGeneration: number,
        lastFailure?: PersistentGatewayConnectionSnapshot["lastFailure"]
    ): void {
        this.listener?.onState?.({
            connectionGeneration,
            ...(lastFailure === undefined ? {} : { lastFailure }),
            phase,
            reconnectAttempt: 0,
        });
    }
}

class ManualRetryScheduler implements PersistentGatewayRealtimeBridgeScheduler {
    readonly #tasks = new Map<object, () => void>();
    readonly delays: number[] = [];

    get pendingCount(): number {
        return this.#tasks.size;
    }

    clearTimeout(handle: object | number): void {
        if (typeof handle === "object") this.#tasks.delete(handle);
    }

    runNext(): void {
        const next = this.#tasks.entries().next().value;
        if (next === undefined) throw new Error("Expected a scheduled bridge retry");
        const [handle, callback] = next;
        this.#tasks.delete(handle);
        callback();
    }

    setTimeout(callback: () => void, delayMs: number): object {
        const handle = {};
        this.delays.push(delayMs);
        this.#tasks.set(handle, callback);
        return handle;
    }
}

function createCaptureBridge(options?: {
    readonly appendEvent?: (event: PersistentGatewayRealtimeEventInsert) => Promise<void>;
    readonly nowMs?: () => number;
    readonly onFailure?: (failure: PersistentGatewayRealtimeBridgeFailure) => void;
    readonly retry?: {
        readonly factor?: number;
        readonly initialDelayMs?: number;
        readonly maximumDelayMs?: number;
    };
    readonly scheduler?: PersistentGatewayRealtimeBridgeScheduler;
    readonly wake?: () => Promise<void> | void;
}) {
    const subscription = new FakeGatewaySubscription();
    const events: PersistentGatewayRealtimeEventInsert[] = [];
    let wakeCalls = 0;
    const bridge = createPersistentGatewayRealtimeBridge({
        appendEvent:
            options?.appendEvent ??
            ((event) => {
                events.push(event);
                return Promise.resolve();
            }),
        nowMs: options?.nowMs ?? (() => 1000),
        onFailure: options?.onFailure,
        retry: options?.retry,
        scheduler: options?.scheduler,
        transport: subscription.transport,
        wake:
            options?.wake ??
            (() => {
                wakeCalls += 1;
            }),
    });
    return {
        bridge,
        events,
        subscription,
        wakeCalls: () => wakeCalls,
    };
}

describe("persistent Gateway realtime bridge", () => {
    test("writes only compact validated snapshot markers with seven-day retention", async () => {
        const capture = createCaptureBridge();
        capture.bridge.start();

        capture.subscription.emitState("connected", 1);
        capture.subscription.emitEvent("sessions.changed");
        capture.subscription.emitEvent("cron");
        await capture.bridge.dispose();

        expect(capture.events).toHaveLength(3);
        expect(capture.events.map((event) => event.topic)).toEqual([
            gatewayRealtimeTopics.connection,
            gatewayRealtimeTopics.sessions,
            gatewayRealtimeTopics.cron,
        ]);
        expect(
            capture.events.map((event) => ({
                entityId: event.entityId,
                entityType: event.entityType,
                operation: event.operation,
                payloadJson: event.payloadJson,
            }))
        ).toEqual([
            {
                entityId: "current",
                entityType: "gateway-connection",
                operation: "snapshot-required",
                payloadJson: '{"kind":"snapshot-required"}',
            },
            {
                entityId: "current",
                entityType: "gateway-sessions",
                operation: "snapshot-required",
                payloadJson: '{"kind":"snapshot-required"}',
            },
            {
                entityId: "current",
                entityType: "openclaw-cron",
                operation: "snapshot-required",
                payloadJson: '{"kind":"snapshot-required"}',
            },
        ]);
        for (const event of capture.events) {
            expect(v.parse(realtimeEventInsertSchema, event)).toEqual(event);
            expect(getTime(event.occurredAt)).toBe(1000);
            expect(getTime(event.expiresAt) - getTime(event.occurredAt)).toBe(
                realtimeEventRetentionMilliseconds
            );
        }
        expect(capture.wakeCalls()).toBe(3);
        expect(capture.subscription.unsubscribeCalls).toBe(1);
    });

    test("recovers slow-client socket closes through disconnect and reconnect snapshots", async () => {
        const capture = createCaptureBridge();
        capture.bridge.start();

        capture.subscription.emitState("connected", 1);
        await waitForCondition(
            () => capture.events.length === 3,
            "initial connected invalidations"
        );
        capture.subscription.emitState("connected", 1);
        expect(capture.events).toHaveLength(3);
        capture.subscription.emitState("degraded", 1, "transport");
        await waitForCondition(
            () => capture.events.length === 6,
            "disconnect provider invalidations"
        );
        capture.subscription.emitState("degraded", 1, "transport");
        expect(capture.events).toHaveLength(6);
        capture.subscription.emitGap();
        await waitForCondition(
            () => capture.events.length === 8,
            "event-gap invalidations"
        );
        capture.subscription.emitState("connected", 2);
        await waitForCondition(
            () => capture.events.length === 11,
            "reconnected provider invalidations"
        );
        capture.subscription.emitState("connected", 2);
        await capture.bridge.dispose();

        expect(
            capture.events.filter(
                (event) => event.topic === gatewayRealtimeTopics.connection
            )
        ).toHaveLength(3);
        expect(
            capture.events.filter(
                (event) => event.topic === gatewayRealtimeTopics.sessions
            )
        ).toHaveLength(4);
        expect(
            capture.events.filter((event) => event.topic === gatewayRealtimeTopics.cron)
        ).toHaveLength(4);
    });

    test("retries a coalesced session invalidation through a prolonged disconnect", async () => {
        const scheduler = new ManualRetryScheduler();
        const appended: PersistentGatewayRealtimeEventInsert[] = [];
        const failures: PersistentGatewayRealtimeBridgeFailure[] = [];
        let sessionAttempts = 0;
        const capture = createCaptureBridge({
            appendEvent: (event) => {
                if (event.topic === gatewayRealtimeTopics.sessions) {
                    sessionAttempts += 1;
                    if (sessionAttempts < 3) {
                        return Promise.reject(new Error("transient SQLite pressure"));
                    }
                }
                appended.push(event);
                return Promise.resolve();
            },
            onFailure: (failure) => failures.push(failure),
            retry: { factor: 2, initialDelayMs: 10, maximumDelayMs: 40 },
            scheduler,
        });
        capture.bridge.start();

        capture.subscription.emitState("connected", 1);
        await waitForCondition(() => scheduler.pendingCount === 1, "first bridge retry");
        for (let index = 0; index < 20; index += 1) {
            capture.subscription.emitState("degraded", 1);
        }
        expect(scheduler.pendingCount).toBe(1);

        scheduler.runNext();
        await waitForCondition(
            () => scheduler.pendingCount === 1 && sessionAttempts === 2,
            "second bridge retry"
        );
        scheduler.runNext();
        await waitForCondition(
            () =>
                appended.some((event) => event.topic === gatewayRealtimeTopics.sessions),
            "recovered session invalidation"
        );
        await capture.bridge.dispose();

        expect(sessionAttempts).toBe(3);
        expect(
            appended.filter((event) => event.topic === gatewayRealtimeTopics.sessions)
        ).toHaveLength(1);
        expect(failures.map(({ stage, topic }) => ({ stage, topic }))).toEqual([
            { stage: "append", topic: gatewayRealtimeTopics.sessions },
            { stage: "append", topic: gatewayRealtimeTopics.sessions },
        ]);
        expect(scheduler.delays).toEqual([10, 20]);
        expect(scheduler.pendingCount).toBe(0);
    });

    test("serializes writes and coalesces a burst to one pending marker per topic", async () => {
        const gate = Promise.withResolvers<void>();
        const firstWriteStarted = Promise.withResolvers<void>();
        const events: PersistentGatewayRealtimeEventInsert[] = [];
        let activeWrites = 0;
        let maximumActiveWrites = 0;
        const capture = createCaptureBridge({
            appendEvent: async (event) => {
                events.push(event);
                activeWrites += 1;
                maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
                if (events.length === 1) {
                    firstWriteStarted.resolve();
                    await gate.promise;
                }
                activeWrites -= 1;
            },
        });
        capture.bridge.start();
        capture.subscription.emitState("connecting", 1);
        await firstWriteStarted.promise;

        for (let index = 0; index < 100; index += 1) {
            capture.subscription.emitState("connecting", 1);
            capture.subscription.emitEvent("sessions.changed");
            capture.subscription.emitEvent("cron");
        }
        gate.resolve();
        await capture.bridge.dispose();
        await capture.bridge.dispose();

        expect(events.map((event) => event.topic)).toEqual([
            gatewayRealtimeTopics.connection,
            gatewayRealtimeTopics.sessions,
            gatewayRealtimeTopics.cron,
        ]);
        expect(maximumActiveWrites).toBe(1);
        expect(capture.wakeCalls()).toBe(3);
        expect(capture.subscription.unsubscribeCalls).toBe(1);
        capture.subscription.emitEvent("cron");
        expect(events).toHaveLength(3);
    });

    test("isolates append and pump-wake failures while continuing other topics", async () => {
        const appendFailure = new Error("simulated append failure");
        const wakeFailure = new Error("simulated wake failure");
        const appended: PersistentGatewayRealtimeEventInsert[] = [];
        const failures: PersistentGatewayRealtimeBridgeFailure[] = [];
        let lastAppendedTopic: string | undefined;
        let wakeCalls = 0;
        const capture = createCaptureBridge({
            appendEvent: (event) => {
                if (event.topic === gatewayRealtimeTopics.connection) {
                    return Promise.reject(appendFailure);
                }
                appended.push(event);
                lastAppendedTopic = event.topic;
                return Promise.resolve();
            },
            onFailure: (failure) => failures.push(failure),
            wake: () => {
                wakeCalls += 1;
                if (lastAppendedTopic === gatewayRealtimeTopics.sessions) {
                    throw wakeFailure;
                }
            },
        });
        capture.bridge.start();
        capture.subscription.emitState("connected", 1);
        await capture.bridge.dispose();

        expect(appended.map((event) => event.topic)).toEqual([
            gatewayRealtimeTopics.sessions,
            gatewayRealtimeTopics.cron,
        ]);
        expect(wakeCalls).toBe(2);
        expect(failures).toEqual([
            {
                cause: appendFailure,
                stage: "append",
                topic: gatewayRealtimeTopics.connection,
            },
            {
                cause: wakeFailure,
                stage: "wake",
                topic: gatewayRealtimeTopics.sessions,
            },
            {
                cause: appendFailure,
                stage: "append",
                topic: gatewayRealtimeTopics.connection,
            },
        ]);
    });
});
