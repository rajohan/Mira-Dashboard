import { differenceInMilliseconds, getTime } from "date-fns";

import { realtimeChangeDeliveryByteLength } from "../../../contracts/realtime.ts";
import { BoundedAsyncQueue } from "./boundedAsyncQueue.ts";
import {
    cursorIsOutsideRetention,
    parseRealtimeEventPumpLimits,
    RealtimeResyncSignal,
    RealtimeSubscriptionInputError,
    resyncRequiredDelivery,
    type RealtimeChangeDelivery,
    type RealtimeEventPumpMetrics,
    type RealtimeEventPumpOptions,
    type RealtimeResyncRequiredDelivery,
    type RealtimeRetainedEventsSample,
} from "./eventPumpContract.ts";
import type {
    RealtimeCursorBounds,
    RealtimeCursorWindow,
    RealtimeEventStore,
    StoredRealtimeEvent,
} from "./eventStore.ts";

export interface PreparedDelivery {
    readonly delivery: RealtimeChangeDelivery;
    readonly deliveryBytes: number;
}

export interface Subscriber {
    readonly controller: AbortController;
    failure?: Error;
    readonly liveAfterId: number;
    readonly pendingDeliveryIds: number[];
    readonly queue: BoundedAsyncQueue<RealtimeChangeDelivery>;
    readonly topics: ReadonlySet<string> | undefined;
    observedCursor: number;
    replayComplete: boolean;
    requiredCursor: number;
}

export class RealtimeEventPumpState {
    readonly maximumEventDeliveryBytes: number;
    readonly maximumPageEvents: number;
    readonly maximumSubscribers: number;
    readonly maximumSubscriberQueueEvents: number;
    readonly maximumSubscriberQueuedDeliveryBytes: number;
    readonly nowMs: () => number;
    readonly readSubscriptionStore: RealtimeEventPumpOptions["readSubscriptionStore"];
    readonly requestPoll: () => void;
    readonly retainedEventCountSampleIntervalMs: number;
    readonly store: RealtimeEventStore;
    readonly openingSubscribers = new Map<AbortController, Error | undefined>();
    readonly subscribers = new Set<Subscriber>();
    closed = false;
    deliveryPreparationFailures = 0;
    droppedSlowSubscribers = 0;
    forcedResyncs = 0;
    latestIssuedId = 0;
    maximumCatchUpBatchSize = 0;
    maximumObservedQueueDepth = 0;
    maximumObservedQueuedDeliveryBytes = 0;
    newestRetainedId: number | null = null;
    oldestRetainedId: number | null = null;
    pollCursor = 0;
    pollFailures = 0;
    polls = 0;
    retainedEventsSample: RealtimeRetainedEventsSample | null = null;
    retryablePollRetries = 0;
    retryableSubscriptionReadRetries = 0;
    subscriptionReadFailures = 0;
    subscriberCapacityRejections = 0;
    topicFilteredDeliveries = 0;
    wakeups = 0;

    constructor(options: RealtimeEventPumpOptions) {
        const limits = parseRealtimeEventPumpLimits(options);
        this.store = options.store;
        this.nowMs = options.nowMs ?? Date.now;
        this.readSubscriptionStore = options.readSubscriptionStore;
        this.requestPoll = options.requestPoll ?? (() => {});
        this.maximumEventDeliveryBytes = limits.maximumEventDeliveryBytes;
        this.maximumPageEvents = limits.maximumPageEvents;
        this.maximumSubscribers = limits.maximumSubscribers;
        this.maximumSubscriberQueueEvents = limits.maximumSubscriberQueueEvents;
        this.maximumSubscriberQueuedDeliveryBytes =
            limits.maximumSubscriberQueuedDeliveryBytes;
        this.retainedEventCountSampleIntervalMs =
            limits.retainedEventCountSampleIntervalMs;
    }

    wake(): void {
        if (this.closed) {
            return;
        }
        this.wakeups += 1;
        this.requestPoll();
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const controller of this.openingSubscribers.keys()) {
            if (!controller.signal.aborted) {
                controller.abort();
            }
        }
        for (const subscriber of this.subscribers) {
            if (!subscriber.controller.signal.aborted) {
                subscriber.controller.abort();
            }
            subscriber.queue.close();
        }
        this.subscribers.clear();
    }

    metricsSnapshot(): Readonly<RealtimeEventPumpMetrics> {
        let oldestRequiredCursor: number | null = null;
        for (const subscriber of this.subscribers) {
            oldestRequiredCursor =
                oldestRequiredCursor === null
                    ? subscriber.requiredCursor
                    : Math.min(oldestRequiredCursor, subscriber.requiredCursor);
        }
        return Object.freeze({
            activeSubscribers: this.subscribers.size,
            deliveryPreparationFailures: this.deliveryPreparationFailures,
            droppedSlowSubscribers: this.droppedSlowSubscribers,
            forcedResyncs: this.forcedResyncs,
            latestIssuedId: this.latestIssuedId,
            maximumCatchUpBatchSize: this.maximumCatchUpBatchSize,
            maximumObservedQueueDepth: this.maximumObservedQueueDepth,
            maximumObservedQueuedDeliveryBytes: this.maximumObservedQueuedDeliveryBytes,
            newestRetainedId: this.newestRetainedId,
            oldestRequiredCursor,
            oldestRetainedId: this.oldestRetainedId,
            pollFailures: this.pollFailures,
            polls: this.polls,
            retainedEventsSample: this.retainedEventsSample,
            retryablePollRetries: this.retryablePollRetries,
            retryableSubscriptionReadRetries: this.retryableSubscriptionReadRetries,
            subscriptionReadFailures: this.subscriptionReadFailures,
            subscriberCapacityRejections: this.subscriberCapacityRejections,
            topicFilteredDeliveries: this.topicFilteredDeliveries,
            wakeups: this.wakeups,
        });
    }

    prepareDelivery(event: StoredRealtimeEvent): PreparedDelivery {
        try {
            const occurredAtMs = getTime(event.occurredAt);
            const delivery: RealtimeChangeDelivery = Object.freeze({
                event: Object.freeze({
                    entityId: event.entityId,
                    entityType: event.entityType,
                    occurredAtMs,
                    operation: event.operation,
                    payloadJson: event.payloadJson,
                    topic: event.topic,
                }),
                id: String(event.id),
                kind: "change",
            });
            const deliveryBytes = realtimeChangeDeliveryByteLength(delivery);
            if (deliveryBytes > this.maximumEventDeliveryBytes) {
                throw new RangeError(
                    `Realtime event delivery exceeds ${this.maximumEventDeliveryBytes} UTF-8 bytes`
                );
            }
            return Object.freeze({ delivery, deliveryBytes });
        } catch (error) {
            this.deliveryPreparationFailures += 1;
            throw error;
        }
    }

    observeBatch(size: number): void {
        this.maximumCatchUpBatchSize = Math.max(this.maximumCatchUpBatchSize, size);
    }

    advanceRequiredCursor(subscriber: Subscriber): void {
        if (!subscriber.replayComplete) {
            return;
        }
        const earliestPendingId = subscriber.pendingDeliveryIds[0];
        const requiredCursor =
            earliestPendingId === undefined
                ? subscriber.observedCursor
                : earliestPendingId - 1;
        if (requiredCursor < subscriber.requiredCursor) {
            throw new Error("Realtime subscriber retention cursor moved backwards");
        }
        subscriber.requiredCursor = requiredCursor;
    }

    advancePollCursorToActiveFloor(): void {
        let activeFloor: number | undefined;
        for (const subscriber of this.subscribers) {
            activeFloor =
                activeFloor === undefined
                    ? subscriber.observedCursor
                    : Math.min(activeFloor, subscriber.observedCursor);
        }
        if (activeFloor !== undefined) {
            this.pollCursor = Math.max(this.pollCursor, activeFloor);
        }
    }

    reserveSubscriptionCapacity(): AbortController {
        if (
            this.openingSubscribers.size + this.subscribers.size >=
            this.maximumSubscribers
        ) {
            this.subscriberCapacityRejections += 1;
            throw new RealtimeSubscriptionInputError(
                "capacity-exceeded",
                "Realtime subscriber capacity is exhausted"
            );
        }
        const controller = new AbortController();
        this.openingSubscribers.set(controller, undefined);
        return controller;
    }

    openingSubscriberFailure(controller: AbortController): Error | undefined {
        return this.openingSubscribers.get(controller);
    }

    releaseOpeningSubscriber(controller: AbortController): void {
        this.openingSubscribers.delete(controller);
    }

    observeWindow(window: RealtimeCursorWindow, sampledAtMs: number): void {
        this.observeBounds(window);
        this.retainedEventsSample = Object.freeze({
            count: window.retainedEvents,
            sampledAtMs,
        });
    }

    observeBounds(bounds: RealtimeCursorBounds): void {
        this.latestIssuedId = bounds.latestIssuedId;
        this.newestRetainedId = bounds.newestRetainedId;
        this.oldestRetainedId = bounds.oldestRetainedId;
    }

    forceResync(tailId: number): void {
        for (const subscriber of this.subscribers) {
            this.forceSubscriberResync(subscriber, tailId);
        }
    }

    forceResyncOutsideRetention(bounds: RealtimeCursorBounds): number {
        let forcedSubscribers = 0;
        for (const subscriber of this.subscribers) {
            if (!cursorIsOutsideRetention(subscriber.observedCursor, bounds)) {
                continue;
            }
            this.forceSubscriberResync(subscriber, bounds.latestIssuedId);
            forcedSubscribers += 1;
        }
        return forcedSubscribers;
    }

    forceSubscriberResync(subscriber: Subscriber, tailId: number): void {
        const signal = new RealtimeResyncSignal(tailId);
        subscriber.failure = signal;
        this.forcedResyncs += 1;
        this.subscribers.delete(subscriber);
        if (!subscriber.controller.signal.aborted) {
            subscriber.controller.abort(signal);
        }
        subscriber.queue.fail(signal);
    }

    sampleRetainedEventsIfDue(nowMs: number): RealtimeCursorWindow | undefined {
        const previousSample = this.retainedEventsSample;
        if (
            previousSample !== null &&
            differenceInMilliseconds(nowMs, previousSample.sampledAtMs) <
                this.retainedEventCountSampleIntervalMs
        ) {
            return undefined;
        }
        const window = this.store.readCursorWindow();
        this.observeWindow(window, nowMs);
        return window;
    }

    failSubscribers(error: Error): void {
        for (const controller of this.openingSubscribers.keys()) {
            this.openingSubscribers.set(controller, error);
            controller.abort(error);
        }
        for (const subscriber of this.subscribers) {
            this.failSubscriber(subscriber, error);
        }
    }

    failSubscriber(subscriber: Subscriber, error: Error): void {
        subscriber.failure = error;
        this.subscribers.delete(subscriber);
        if (!subscriber.controller.signal.aborted) {
            subscriber.controller.abort(error);
        }
        subscriber.queue.fail(error);
    }

    terminalDelivery(subscriber: Subscriber): RealtimeResyncRequiredDelivery | undefined {
        if (subscriber.failure === undefined) {
            return undefined;
        }
        if (subscriber.failure instanceof RealtimeResyncSignal) {
            return resyncRequiredDelivery(subscriber.failure.tailId);
        }
        throw subscriber.failure;
    }
}
