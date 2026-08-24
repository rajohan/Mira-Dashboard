import { Effect } from "effect";
import { TestClock } from "effect/testing";

import type { RealtimeEventDelivery, RealtimeEventPumpMetrics } from "../eventPump.ts";
import {
    realtimeEventPumpLayer,
    RealtimeEventPumpService,
    type RealtimeEventPumpLayerOptions,
} from "../eventPumpService.ts";

type PumpPort = ReturnType<RealtimeEventPumpLayerOptions["makePump"]>;

const emptyMetrics: Readonly<RealtimeEventPumpMetrics> = Object.freeze({
    activeSubscribers: 0,
    deliveryPreparationFailures: 0,
    droppedSlowSubscribers: 0,
    forcedResyncs: 0,
    latestIssuedId: 0,
    maximumCatchUpBatchSize: 0,
    maximumObservedQueueDepth: 0,
    maximumObservedQueuedDeliveryBytes: 0,
    newestRetainedId: null,
    oldestRequiredCursor: null,
    oldestRetainedId: null,
    pollFailures: 0,
    polls: 0,
    retainedEventsSample: null,
    retryablePollRetries: 0,
    retryableSubscriptionReadRetries: 0,
    subscriptionReadFailures: 0,
    subscriberCapacityRejections: 0,
    topicFilteredDeliveries: 0,
    wakeups: 0,
});

export function changeDelivery(id: string): RealtimeEventDelivery {
    return {
        event: {
            entityId: id,
            entityType: "qualification",
            occurredAtMs: 1000,
            operation: "updated",
            payloadJson: "{}",
            topic: "topic.a",
        },
        id,
        kind: "change",
    };
}

export function makePort(overrides: Partial<PumpPort> = {}): PumpPort {
    return {
        close() {},
        failSubscribers() {},
        metricsSnapshot: () => emptyMetrics,
        poll: () => "idle",
        recordPollFailure() {},
        recordRetryablePollRetry() {},
        recordRetryableSubscriptionReadRetry() {},
        recordSubscriptionReadFailure() {},
        async *subscribe() {},
        wake() {},
        ...overrides,
    };
}

export function provideTestClock<A, E>(
    effect: Effect.Effect<A, E, RealtimeEventPumpService>,
    layer: ReturnType<typeof realtimeEventPumpLayer>
): Effect.Effect<A, E> {
    return Effect.provide(Effect.provide(effect, layer), TestClock.layer());
}
