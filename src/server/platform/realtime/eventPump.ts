import { BoundedAsyncQueue } from "./boundedAsyncQueue.ts";
import type {
    RealtimeCursorBounds,
    RealtimeCursorWindow,
    RealtimeEventStore,
    StoredRealtimeEvent,
} from "./eventStore.ts";

export const realtimeEventPumpDefaults = Object.freeze({
    activePollIntervalMs: 250,
    idlePollIntervalMs: 5000,
    maximumEventDeliveryBytes: 8 * 1024,
    maximumPageEvents: 16,
    maximumSubscriberQueueEvents: 16,
    maximumSubscriberQueuedDeliveryBytes: 16 * 8 * 1024,
    maximumTopicsPerSubscription: 64,
    maximumTopicCharacters: 128,
    retainedEventCountSampleIntervalMs: 60_000,
});

const subscriberQueueOverflowMessage =
    "Realtime event subscriber exceeded its queue budget";

export interface RealtimeChangeEvent {
    readonly entityId: string;
    readonly entityType: string;
    readonly occurredAtMs: number;
    readonly operation: StoredRealtimeEvent["operation"];
    readonly payloadJson: string;
    readonly topic: string;
}

export interface RealtimeChangeDelivery {
    readonly event: RealtimeChangeEvent;
    readonly id: string;
    readonly kind: "change";
}

export interface RealtimeResyncRequiredDelivery {
    readonly id: string;
    readonly kind: "resync-required";
    readonly reason: "cursor-outside-retention";
}

export type RealtimeEventDelivery =
    | RealtimeChangeDelivery
    | RealtimeResyncRequiredDelivery;

export interface RealtimeEventSubscriptionOptions {
    readonly afterId: string;
    readonly signal: AbortSignal;
    readonly topics?: readonly string[];
}

export interface RealtimeEventPumpMetrics {
    readonly activeSubscribers: number;
    readonly deliveryPreparationFailures: number;
    readonly droppedSlowSubscribers: number;
    readonly forcedResyncs: number;
    readonly latestIssuedId: number;
    readonly maximumCatchUpBatchSize: number;
    readonly maximumObservedQueueDepth: number;
    readonly maximumObservedQueuedDeliveryBytes: number;
    readonly newestRetainedId: number | null;
    readonly oldestRequiredCursor: number | null;
    readonly oldestRetainedId: number | null;
    readonly pollFailures: number;
    readonly polls: number;
    readonly retainedEventsSample: RealtimeRetainedEventsSample | null;
    readonly wakeups: number;
}

export interface RealtimeRetainedEventsSample {
    readonly count: number;
    readonly sampledAtMs: number;
}

export type RealtimeEventPumpTimerHandle = number | object;

export interface RealtimeEventPumpScheduler {
    clearTimeout(handle: RealtimeEventPumpTimerHandle): void;
    setTimeout(callback: () => void, delayMs: number): RealtimeEventPumpTimerHandle;
}

export interface RealtimeEventPumpOptions {
    readonly activePollIntervalMs?: number;
    readonly idlePollIntervalMs?: number;
    readonly maximumEventDeliveryBytes?: number;
    readonly maximumPageEvents?: number;
    readonly maximumSubscriberQueueEvents?: number;
    readonly maximumSubscriberQueuedDeliveryBytes?: number;
    readonly nowMs?: () => number;
    readonly retainedEventCountSampleIntervalMs?: number;
    readonly scheduler?: RealtimeEventPumpScheduler;
    readonly store: RealtimeEventStore;
}

interface PreparedDelivery {
    readonly delivery: RealtimeChangeDelivery;
    readonly deliveryBytes: number;
}

interface Subscriber {
    failure?: Error;
    readonly liveAfterId: number;
    readonly pendingDeliveryIds: number[];
    readonly queue: BoundedAsyncQueue<RealtimeChangeDelivery>;
    readonly topics: ReadonlySet<string> | undefined;
    observedCursor: number;
    replayComplete: boolean;
    requiredCursor: number;
}

type RealtimeCursorErrorCode = "ahead-of-tail" | "invalid";

/** Error for a malformed or impossible resume cursor supplied by a caller. */
export class RealtimeCursorError extends Error {
    readonly code: RealtimeCursorErrorCode;

    constructor(code: RealtimeCursorErrorCode, message: string) {
        super(message);
        this.name = "RealtimeCursorError";
        this.code = code;
    }
}

class RealtimeResyncSignal extends Error {
    readonly tailId: number;

    constructor(tailId: number) {
        super("Realtime cursor moved outside retention while subscribed");
        this.name = "RealtimeResyncSignal";
        this.tailId = tailId;
    }
}

const runtimeScheduler: RealtimeEventPumpScheduler = {
    clearTimeout(handle: RealtimeEventPumpTimerHandle): void {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number): RealtimeEventPumpTimerHandle {
        return setTimeout(callback, delayMs);
    },
};

function positiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
    return value;
}

function parseResumeCursor(value: string): number {
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || String(cursor) !== value) {
        throw new RealtimeCursorError("invalid", "Realtime resume cursor is invalid");
    }
    return cursor;
}

function cursorIsOutsideRetention(cursor: number, window: RealtimeCursorBounds): boolean {
    if (cursor >= window.latestIssuedId) {
        return false;
    }
    if (window.oldestRetainedId === null) {
        return true;
    }
    return cursor < window.oldestRetainedId - 1;
}

function normalizeTopics(
    topics: readonly string[] | undefined
): ReadonlySet<string> | undefined {
    if (topics === undefined) {
        return undefined;
    }
    if (
        topics.length === 0 ||
        topics.length > realtimeEventPumpDefaults.maximumTopicsPerSubscription
    ) {
        throw new RangeError("Realtime subscription topic count is outside its budget");
    }

    const normalized = new Set<string>();
    for (const topic of topics) {
        if (
            topic.length === 0 ||
            topic.length > realtimeEventPumpDefaults.maximumTopicCharacters ||
            topic.trim() !== topic
        ) {
            throw new RangeError("Realtime subscription topic is invalid");
        }
        normalized.add(topic);
    }
    return normalized;
}

function resyncRequiredDelivery(tailId: number): RealtimeResyncRequiredDelivery {
    return Object.freeze({
        id: String(tailId),
        kind: "resync-required",
        reason: "cursor-outside-retention",
    });
}

/**
 * Durable SQLite event pump with bounded replay, one coalesced live poll, and explicit resync.
 * Transport and authentication adapters consume this iterator but remain outside this module.
 */
export class RealtimeEventPump {
    readonly #activePollIntervalMs: number;
    readonly #idlePollIntervalMs: number;
    readonly #maximumEventDeliveryBytes: number;
    readonly #maximumPageEvents: number;
    readonly #maximumSubscriberQueueEvents: number;
    readonly #maximumSubscriberQueuedDeliveryBytes: number;
    readonly #nowMs: () => number;
    readonly #retainedEventCountSampleIntervalMs: number;
    readonly #scheduler: RealtimeEventPumpScheduler;
    readonly #store: RealtimeEventStore;
    readonly #subscribers = new Set<Subscriber>();
    #closed = false;
    #deliveryPreparationFailures = 0;
    #droppedSlowSubscribers = 0;
    #forcedResyncs = 0;
    #latestIssuedId = 0;
    #maximumCatchUpBatchSize = 0;
    #maximumObservedQueueDepth = 0;
    #maximumObservedQueuedDeliveryBytes = 0;
    #newestRetainedId: number | null = null;
    #oldestRetainedId: number | null = null;
    #pollCursor = 0;
    #pollFailures = 0;
    #polls = 0;
    #retainedEventsSample: RealtimeRetainedEventsSample | null = null;
    #scheduledDelayMs: number | undefined;
    #timer: RealtimeEventPumpTimerHandle | undefined;
    #started = false;
    #wakeups = 0;

    constructor(options: RealtimeEventPumpOptions) {
        this.#store = options.store;
        this.#scheduler = options.scheduler ?? runtimeScheduler;
        this.#nowMs = options.nowMs ?? Date.now;
        this.#activePollIntervalMs = positiveSafeInteger(
            options.activePollIntervalMs ??
                realtimeEventPumpDefaults.activePollIntervalMs,
            "Realtime active poll interval"
        );
        this.#idlePollIntervalMs = positiveSafeInteger(
            options.idlePollIntervalMs ?? realtimeEventPumpDefaults.idlePollIntervalMs,
            "Realtime idle poll interval"
        );
        this.#maximumEventDeliveryBytes = positiveSafeInteger(
            options.maximumEventDeliveryBytes ??
                realtimeEventPumpDefaults.maximumEventDeliveryBytes,
            "Realtime maximum event delivery bytes"
        );
        this.#maximumPageEvents = positiveSafeInteger(
            options.maximumPageEvents ?? realtimeEventPumpDefaults.maximumPageEvents,
            "Realtime maximum page events"
        );
        this.#maximumSubscriberQueueEvents = positiveSafeInteger(
            options.maximumSubscriberQueueEvents ??
                realtimeEventPumpDefaults.maximumSubscriberQueueEvents,
            "Realtime maximum subscriber queue events"
        );
        this.#maximumSubscriberQueuedDeliveryBytes = positiveSafeInteger(
            options.maximumSubscriberQueuedDeliveryBytes ??
                realtimeEventPumpDefaults.maximumSubscriberQueuedDeliveryBytes,
            "Realtime maximum subscriber queued delivery bytes"
        );
        this.#retainedEventCountSampleIntervalMs = positiveSafeInteger(
            options.retainedEventCountSampleIntervalMs ??
                realtimeEventPumpDefaults.retainedEventCountSampleIntervalMs,
            "Realtime retained event count sample interval"
        );
    }

    /** Starts adaptive polling. Repeated calls are idempotent. */
    start(): void {
        if (this.#closed) {
            throw new Error("Realtime event pump is closed");
        }
        if (this.#started) {
            return;
        }
        this.#started = true;
        this.#schedulePoll(0);
    }

    /** Coalesces an immediate best-effort poll after a local transaction commits. */
    wake(): void {
        if (this.#closed) {
            return;
        }
        this.#wakeups += 1;
        this.start();
        this.#schedulePoll(0);
    }

    /** Stops timers and closes every active subscription. */
    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        if (this.#timer !== undefined) {
            this.#scheduler.clearTimeout(this.#timer);
            this.#timer = undefined;
            this.#scheduledDelayMs = undefined;
        }
        for (const subscriber of this.#subscribers) {
            subscriber.queue.close();
        }
        this.#subscribers.clear();
    }

    /**
     * Captures point-in-time operational counters and retention checkpoints.
     * @returns An immutable metrics snapshot.
     */
    metricsSnapshot(): Readonly<RealtimeEventPumpMetrics> {
        const requiredCursors = [...this.#subscribers].map(
            (subscriber) => subscriber.requiredCursor
        );
        return Object.freeze({
            activeSubscribers: this.#subscribers.size,
            deliveryPreparationFailures: this.#deliveryPreparationFailures,
            droppedSlowSubscribers: this.#droppedSlowSubscribers,
            forcedResyncs: this.#forcedResyncs,
            latestIssuedId: this.#latestIssuedId,
            maximumCatchUpBatchSize: this.#maximumCatchUpBatchSize,
            maximumObservedQueueDepth: this.#maximumObservedQueueDepth,
            maximumObservedQueuedDeliveryBytes: this.#maximumObservedQueuedDeliveryBytes,
            newestRetainedId: this.#newestRetainedId,
            oldestRequiredCursor:
                requiredCursors.length === 0 ? null : Math.min(...requiredCursors),
            oldestRetainedId: this.#oldestRetainedId,
            pollFailures: this.#pollFailures,
            polls: this.#polls,
            retainedEventsSample: this.#retainedEventsSample,
            wakeups: this.#wakeups,
        });
    }

    /**
     * Replays durable rows through a stable boundary, then follows the central live poll.
     * @param options Canonical cursor, request abort signal, and optional topic filter.
     * @yields {RealtimeEventDelivery} Ordered changes or one terminal resync-required
     * control delivery.
     */
    async *subscribe(
        options: RealtimeEventSubscriptionOptions
    ): AsyncGenerator<RealtimeEventDelivery> {
        if (this.#closed) {
            throw new Error("Realtime event pump is closed");
        }
        const afterId = parseResumeCursor(options.afterId);
        const topics = normalizeTopics(options.topics);
        if (options.signal.aborted) {
            return;
        }

        this.start();
        const bounds = this.#store.readCursorBounds();
        this.#observeBounds(bounds);
        if (afterId > bounds.latestIssuedId) {
            throw new RealtimeCursorError(
                "ahead-of-tail",
                "Realtime resume cursor is ahead of the outbox tail"
            );
        }
        if (cursorIsOutsideRetention(afterId, bounds)) {
            this.#forcedResyncs += 1;
            yield resyncRequiredDelivery(bounds.latestIssuedId);
            return;
        }

        const replayBoundary = bounds.latestIssuedId;
        const queue = new BoundedAsyncQueue<RealtimeChangeDelivery>({
            maximumEvents: this.#maximumSubscriberQueueEvents,
            maximumPayloadBytes: this.#maximumSubscriberQueuedDeliveryBytes,
            overflowErrorMessage: subscriberQueueOverflowMessage,
        });
        const subscriber: Subscriber = {
            liveAfterId: replayBoundary,
            observedCursor: replayBoundary,
            pendingDeliveryIds: [],
            queue,
            replayComplete: false,
            requiredCursor: afterId,
            topics,
        };
        const abort = (): void => {
            this.#subscribers.delete(subscriber);
            queue.close();
        };

        if (this.#subscribers.size === 0) {
            this.#pollCursor = replayBoundary;
        }
        this.#subscribers.add(subscriber);
        options.signal.addEventListener("abort", abort, { once: true });
        this.#schedulePoll(0);

        try {
            let replayCursor = afterId;
            while (
                !this.#closed &&
                !options.signal.aborted &&
                replayCursor < replayBoundary
            ) {
                const terminalDelivery = this.#terminalDelivery(subscriber);
                if (terminalDelivery !== undefined) {
                    yield terminalDelivery;
                    return;
                }

                const batch = this.#store.readBatch({
                    afterId: replayCursor,
                    limit: this.#maximumPageEvents,
                    throughId: replayBoundary,
                    ...(topics === undefined ? {} : { topics: [...topics] }),
                });
                this.#observeBounds(batch.bounds);
                if (batch.bounds.latestIssuedId < replayBoundary) {
                    throw new Error(
                        "Realtime outbox tail moved behind the replay boundary"
                    );
                }
                if (cursorIsOutsideRetention(replayCursor, batch.bounds)) {
                    this.#forcedResyncs += 1;
                    this.#subscribers.delete(subscriber);
                    queue.close();
                    yield resyncRequiredDelivery(batch.bounds.latestIssuedId);
                    return;
                }

                const page = batch.events;
                this.#observeBatch(page.length);
                if (page.length === 0) {
                    replayCursor = replayBoundary;
                    break;
                }
                const replayExhausted = page.length < this.#maximumPageEvents;

                for (const event of page) {
                    if (this.#closed || options.signal.aborted) {
                        return;
                    }
                    const failureDelivery = this.#terminalDelivery(subscriber);
                    if (failureDelivery !== undefined) {
                        yield failureDelivery;
                        return;
                    }
                    const prepared = this.#prepareDelivery(event);
                    subscriber.requiredCursor = event.id - 1;
                    yield prepared.delivery;
                    subscriber.requiredCursor = event.id;
                }
                replayCursor = replayExhausted ? replayBoundary : page.at(-1)!.id;
            }

            if (this.#closed || options.signal.aborted) {
                return;
            }
            const terminalDelivery = this.#terminalDelivery(subscriber);
            if (terminalDelivery !== undefined) {
                yield terminalDelivery;
                return;
            }
            subscriber.requiredCursor = Math.max(
                subscriber.requiredCursor,
                replayBoundary
            );
            subscriber.replayComplete = true;
            this.#advanceRequiredCursor(subscriber);

            while (!this.#closed && !options.signal.aborted) {
                let next: IteratorResult<RealtimeChangeDelivery>;
                try {
                    next = await queue.next();
                } catch (error) {
                    if (this.#closed || options.signal.aborted) {
                        return;
                    }
                    if (error instanceof RealtimeResyncSignal) {
                        yield resyncRequiredDelivery(error.tailId);
                        return;
                    }
                    throw error;
                }
                if (this.#closed || options.signal.aborted) {
                    return;
                }
                if (next.done) {
                    break;
                }
                yield next.value;
                const deliveredId = Number(next.value.id);
                const pendingDeliveryId = subscriber.pendingDeliveryIds.shift();
                if (pendingDeliveryId !== deliveredId) {
                    throw new Error(
                        "Realtime subscriber delivery cursor is inconsistent"
                    );
                }
                this.#advanceRequiredCursor(subscriber);
            }
        } finally {
            options.signal.removeEventListener("abort", abort);
            this.#subscribers.delete(subscriber);
            queue.close();
        }
    }

    #schedulePoll(delayMs: number): void {
        if (this.#closed || !this.#started) {
            return;
        }
        if (
            this.#timer !== undefined &&
            this.#scheduledDelayMs !== undefined &&
            this.#scheduledDelayMs <= delayMs
        ) {
            return;
        }
        if (this.#timer !== undefined) {
            this.#scheduler.clearTimeout(this.#timer);
        }

        this.#scheduledDelayMs = delayMs;
        this.#timer = this.#scheduler.setTimeout(() => {
            this.#timer = undefined;
            this.#scheduledDelayMs = undefined;
            this.#poll();
        }, delayMs);
    }

    #poll(): void {
        if (this.#closed || !this.#started) {
            return;
        }
        this.#polls += 1;

        try {
            const nowMs = nonnegativeSafeInteger(
                this.#nowMs(),
                "Realtime event pump clock"
            );
            const sampledBounds = this.#sampleRetainedEventsIfDue(nowMs);
            if (this.#subscribers.size === 0) {
                const bounds = sampledBounds ?? this.#store.readCursorBounds();
                this.#observeBounds(bounds);
                this.#pollCursor = bounds.latestIssuedId;
                this.#schedulePoll(this.#idlePollIntervalMs);
                return;
            }

            this.#advancePollCursorToActiveFloor();
            const batch = this.#store.readBatch({
                afterId: this.#pollCursor,
                limit: this.#maximumPageEvents,
            });
            const bounds = batch.bounds;
            this.#observeBounds(bounds);
            if (this.#pollCursor > bounds.latestIssuedId) {
                throw new Error("Realtime outbox tail moved behind the live poll cursor");
            }
            if (cursorIsOutsideRetention(this.#pollCursor, bounds)) {
                const forcedSubscribers = this.#forceResyncOutsideRetention(bounds);
                if (forcedSubscribers === 0) {
                    throw new Error(
                        "Realtime live poll cursor is outside retention without an affected subscriber"
                    );
                }
                if (this.#subscribers.size === 0) {
                    this.#pollCursor = bounds.latestIssuedId;
                    this.#schedulePoll(this.#idlePollIntervalMs);
                } else {
                    this.#advancePollCursorToActiveFloor();
                    this.#schedulePoll(0);
                }
                return;
            }

            const page = batch.events;
            this.#observeBatch(page.length);
            for (const event of page) {
                const recipients: Subscriber[] = [];
                for (const subscriber of this.#subscribers) {
                    if (event.id <= subscriber.liveAfterId) {
                        continue;
                    }
                    subscriber.observedCursor = event.id;
                    if (
                        subscriber.topics !== undefined &&
                        !subscriber.topics.has(event.topic)
                    ) {
                        this.#advanceRequiredCursor(subscriber);
                        continue;
                    }
                    recipients.push(subscriber);
                }

                let prepared: PreparedDelivery | undefined;
                if (recipients.length > 0) {
                    try {
                        prepared = this.#prepareDelivery(event);
                    } catch (error) {
                        const failure =
                            error instanceof Error
                                ? error
                                : new Error("Realtime event delivery is invalid");
                        for (const subscriber of recipients) {
                            this.#failSubscriber(subscriber, failure);
                        }
                    }
                }

                if (prepared !== undefined) {
                    for (const subscriber of recipients) {
                        const result = subscriber.queue.push(
                            prepared.delivery,
                            prepared.deliveryBytes
                        );
                        if (!result.accepted) {
                            subscriber.failure = new Error(
                                subscriberQueueOverflowMessage
                            );
                            this.#droppedSlowSubscribers += 1;
                            this.#subscribers.delete(subscriber);
                            continue;
                        }
                        subscriber.pendingDeliveryIds.push(event.id);
                        this.#advanceRequiredCursor(subscriber);
                        this.#maximumObservedQueueDepth = Math.max(
                            this.#maximumObservedQueueDepth,
                            result.queuedEventCount
                        );
                        this.#maximumObservedQueuedDeliveryBytes = Math.max(
                            this.#maximumObservedQueuedDeliveryBytes,
                            result.queuedPayloadBytes
                        );
                    }
                }
                this.#pollCursor = event.id;
            }

            if (this.#subscribers.size === 0) {
                this.#pollCursor = bounds.latestIssuedId;
                this.#schedulePoll(this.#idlePollIntervalMs);
                return;
            }
            if (page.length === 0 && this.#pollCursor < bounds.latestIssuedId) {
                this.#forceResync(bounds.latestIssuedId);
                this.#pollCursor = bounds.latestIssuedId;
                this.#schedulePoll(this.#idlePollIntervalMs);
                return;
            }
            this.#schedulePoll(
                this.#pollCursor < bounds.latestIssuedId ? 0 : this.#activePollIntervalMs
            );
        } catch (error) {
            this.#pollFailures += 1;
            this.#failSubscribers(
                error instanceof Error ? error : new Error("Realtime event poll failed")
            );
            this.#schedulePoll(this.#idlePollIntervalMs);
        }
    }

    #prepareDelivery(event: StoredRealtimeEvent): PreparedDelivery {
        try {
            const occurredAtMs = event.occurredAt.getTime();
            if (!Number.isSafeInteger(occurredAtMs)) {
                throw new TypeError("Realtime event occurrence timestamp is invalid");
            }

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
            const serializedDelivery = JSON.stringify(delivery);
            const deliveryBytes = Buffer.byteLength(serializedDelivery, "utf8");
            if (deliveryBytes > this.#maximumEventDeliveryBytes) {
                throw new RangeError(
                    `Realtime event delivery exceeds ${this.#maximumEventDeliveryBytes} UTF-8 bytes`
                );
            }

            return Object.freeze({ delivery, deliveryBytes });
        } catch (error) {
            this.#deliveryPreparationFailures += 1;
            throw error;
        }
    }

    #observeBatch(size: number): void {
        this.#maximumCatchUpBatchSize = Math.max(this.#maximumCatchUpBatchSize, size);
    }

    #advanceRequiredCursor(subscriber: Subscriber): void {
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

    #advancePollCursorToActiveFloor(): void {
        let activeFloor: number | undefined;
        for (const subscriber of this.#subscribers) {
            activeFloor =
                activeFloor === undefined
                    ? subscriber.observedCursor
                    : Math.min(activeFloor, subscriber.observedCursor);
        }
        if (activeFloor !== undefined) {
            this.#pollCursor = Math.max(this.#pollCursor, activeFloor);
        }
    }

    #observeWindow(window: RealtimeCursorWindow, sampledAtMs: number): void {
        this.#observeBounds(window);
        this.#retainedEventsSample = Object.freeze({
            count: window.retainedEvents,
            sampledAtMs,
        });
    }

    #observeBounds(bounds: RealtimeCursorBounds): void {
        this.#latestIssuedId = bounds.latestIssuedId;
        this.#newestRetainedId = bounds.newestRetainedId;
        this.#oldestRetainedId = bounds.oldestRetainedId;
    }

    #forceResync(tailId: number): void {
        for (const subscriber of this.#subscribers) {
            this.#forceSubscriberResync(subscriber, tailId);
        }
    }

    #forceResyncOutsideRetention(bounds: RealtimeCursorBounds): number {
        let forcedSubscribers = 0;
        for (const subscriber of this.#subscribers) {
            if (!cursorIsOutsideRetention(subscriber.observedCursor, bounds)) {
                continue;
            }
            this.#forceSubscriberResync(subscriber, bounds.latestIssuedId);
            forcedSubscribers += 1;
        }
        return forcedSubscribers;
    }

    #forceSubscriberResync(subscriber: Subscriber, tailId: number): void {
        const signal = new RealtimeResyncSignal(tailId);
        subscriber.failure = signal;
        this.#forcedResyncs += 1;
        this.#subscribers.delete(subscriber);
        subscriber.queue.fail(signal);
    }

    #sampleRetainedEventsIfDue(nowMs: number): RealtimeCursorWindow | undefined {
        const previousSample = this.#retainedEventsSample;
        if (
            previousSample !== null &&
            nowMs - previousSample.sampledAtMs < this.#retainedEventCountSampleIntervalMs
        ) {
            return undefined;
        }

        const window = this.#store.readCursorWindow();
        this.#observeWindow(window, nowMs);
        return window;
    }

    #failSubscribers(error: Error): void {
        for (const subscriber of this.#subscribers) {
            this.#failSubscriber(subscriber, error);
        }
    }

    #failSubscriber(subscriber: Subscriber, error: Error): void {
        subscriber.failure = error;
        this.#subscribers.delete(subscriber);
        subscriber.queue.fail(error);
    }

    #terminalDelivery(
        subscriber: Subscriber
    ): RealtimeResyncRequiredDelivery | undefined {
        if (subscriber.failure === undefined) {
            return undefined;
        }
        if (subscriber.failure instanceof RealtimeResyncSignal) {
            return resyncRequiredDelivery(subscriber.failure.tailId);
        }
        throw subscriber.failure;
    }
}
