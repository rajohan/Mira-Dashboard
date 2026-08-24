import { BoundedAsyncQueue } from "./boundedAsyncQueue.ts";
import {
    cursorIsOutsideRetention,
    errorFromUnknown,
    normalizeTopics,
    parseResumeCursor,
    RealtimeCursorError,
    RealtimeResyncSignal,
    resyncRequiredDelivery,
    subscriberQueueOverflowMessage,
    type RealtimeChangeDelivery,
    type RealtimeEventDelivery,
    type RealtimeEventSubscriptionOptions,
} from "./eventPumpContract.ts";
import { type RealtimeEventPumpState, type Subscriber } from "./eventPumpState.ts";
import type { RealtimeCursorBounds, RealtimeEventBatch } from "./eventStore.ts";

/**
 * Replays durable rows through a stable boundary, then follows the central live poll.
 * Topic filters must already be authorized by the transport adapter before subscription.
 * @param state Mutable pump state owned by the scoped service.
 * @param options Canonical cursor, abort signal, and optional authorized topic filter.
 * @yields {RealtimeEventDelivery} Ordered changes or one terminal resync-required
 * control delivery.
 */
export async function* subscribeRealtimeEvents(
    state: RealtimeEventPumpState,
    options: RealtimeEventSubscriptionOptions
): AsyncGenerator<RealtimeEventDelivery> {
    if (state.closed) {
        throw new Error("Realtime event pump is closed");
    }
    const afterId = parseResumeCursor(options.afterId);
    const topics = normalizeTopics(options.topics);
    if (options.signal.aborted) {
        return;
    }

    const openingController = state.reserveSubscriptionCapacity();
    const openingSignal = AbortSignal.any([options.signal, openingController.signal]);
    let bounds: RealtimeCursorBounds | undefined;
    let readError: unknown;
    let openingFailure: Error | undefined;
    try {
        bounds =
            state.readSubscriptionStore === undefined
                ? state.store.readCursorBounds()
                : await state.readSubscriptionStore(
                      () => state.store.readCursorBounds(),
                      openingSignal
                  );
    } catch (error) {
        readError = error;
    } finally {
        openingFailure = state.openingSubscriberFailure(openingController);
        state.releaseOpeningSubscriber(openingController);
    }
    if (options.signal.aborted) {
        return;
    }
    if (openingFailure !== undefined) {
        throw openingFailure;
    }
    if (state.closed) {
        return;
    }
    if (readError !== undefined) {
        throw errorFromUnknown(
            readError,
            "Realtime subscription cursor-bounds read failed"
        );
    }
    if (bounds === undefined) {
        throw new Error("Realtime cursor-bounds read returned no result");
    }
    const replayBoundary = Math.max(
        bounds.latestIssuedId,
        state.latestIssuedId,
        state.pollCursor
    );
    if (bounds.latestIssuedId >= state.latestIssuedId) {
        state.observeBounds(bounds);
    }
    if (afterId > replayBoundary) {
        throw new RealtimeCursorError(
            "ahead-of-tail",
            "Realtime resume cursor is ahead of the outbox tail"
        );
    }
    if (afterId <= bounds.latestIssuedId && cursorIsOutsideRetention(afterId, bounds)) {
        state.forcedResyncs += 1;
        yield resyncRequiredDelivery(replayBoundary);
        return;
    }

    const queue = new BoundedAsyncQueue<RealtimeChangeDelivery>({
        maximumEvents: state.maximumSubscriberQueueEvents,
        maximumPayloadBytes: state.maximumSubscriberQueuedDeliveryBytes,
        overflowErrorMessage: subscriberQueueOverflowMessage,
    });
    const subscriberController = new AbortController();
    const subscriptionSignal = AbortSignal.any([
        options.signal,
        subscriberController.signal,
    ]);
    const subscriber: Subscriber = {
        controller: subscriberController,
        liveAfterId: replayBoundary,
        observedCursor: replayBoundary,
        pendingDeliveryIds: [],
        queue,
        replayComplete: false,
        requiredCursor: afterId,
        topics,
    };
    const abort = (): void => {
        state.subscribers.delete(subscriber);
        queue.close();
    };

    try {
        // Merge the async bounds snapshot with the synchronous live cursor at attach time.
        // No poll can interleave between this boundary and adding the subscriber.
        if (state.subscribers.size === 0) {
            state.pollCursor = replayBoundary;
        }
        state.subscribers.add(subscriber);
        options.signal.addEventListener("abort", abort, { once: true });
        state.requestPoll();

        let replayCursor = afterId;
        while (
            !state.closed &&
            !options.signal.aborted &&
            replayCursor < replayBoundary
        ) {
            const terminalDelivery = state.terminalDelivery(subscriber);
            if (terminalDelivery !== undefined) {
                yield terminalDelivery;
                return;
            }

            let batch: RealtimeEventBatch;
            try {
                const readBatch = (): RealtimeEventBatch =>
                    state.store.readBatch({
                        afterId: replayCursor,
                        limit: state.maximumPageEvents,
                        throughId: replayBoundary,
                        ...(topics === undefined ? {} : { topics: [...topics] }),
                    });
                batch =
                    state.readSubscriptionStore === undefined
                        ? readBatch()
                        : await state.readSubscriptionStore(
                              readBatch,
                              subscriptionSignal
                          );
            } catch (error) {
                if (state.closed || options.signal.aborted) {
                    return;
                }
                const terminalDelivery = state.terminalDelivery(subscriber);
                if (terminalDelivery !== undefined) {
                    yield terminalDelivery;
                    return;
                }
                throw error;
            }
            if (state.closed || options.signal.aborted) {
                return;
            }
            const postReadTerminalDelivery = state.terminalDelivery(subscriber);
            if (postReadTerminalDelivery !== undefined) {
                yield postReadTerminalDelivery;
                return;
            }
            if (batch.bounds.latestIssuedId >= state.latestIssuedId) {
                state.observeBounds(batch.bounds);
            }
            if (batch.bounds.latestIssuedId < replayBoundary) {
                throw new Error("Realtime outbox tail moved behind the replay boundary");
            }
            if (cursorIsOutsideRetention(replayCursor, batch.bounds)) {
                state.forceSubscriberResync(subscriber, batch.bounds.latestIssuedId);
                yield resyncRequiredDelivery(batch.bounds.latestIssuedId);
                return;
            }

            const page = batch.events;
            state.observeBatch(page.length);
            if (page.length === 0) {
                break;
            }
            const replayExhausted = page.length < state.maximumPageEvents;

            for (const event of page) {
                if (state.closed || options.signal.aborted) {
                    return;
                }
                const failureDelivery = state.terminalDelivery(subscriber);
                if (failureDelivery !== undefined) {
                    yield failureDelivery;
                    return;
                }
                const prepared = state.prepareDelivery(event);
                subscriber.requiredCursor = event.id - 1;
                yield prepared.delivery;
                subscriber.requiredCursor = event.id;
            }
            replayCursor = replayExhausted ? replayBoundary : page.at(-1)!.id;
        }

        if (state.closed || options.signal.aborted) {
            return;
        }
        const terminalDelivery = state.terminalDelivery(subscriber);
        if (terminalDelivery !== undefined) {
            yield terminalDelivery;
            return;
        }
        subscriber.requiredCursor = Math.max(subscriber.requiredCursor, replayBoundary);
        subscriber.replayComplete = true;
        state.advanceRequiredCursor(subscriber);

        while (!state.closed && !options.signal.aborted) {
            let next: IteratorResult<RealtimeChangeDelivery>;
            try {
                next = await queue.next();
            } catch (error) {
                if (state.closed || options.signal.aborted) {
                    return;
                }
                if (error instanceof RealtimeResyncSignal) {
                    yield resyncRequiredDelivery(error.tailId);
                    return;
                }
                throw error;
            }
            if (state.closed || options.signal.aborted) {
                return;
            }
            if (next.done) {
                break;
            }
            yield next.value;
            const deliveredId = Number(next.value.id);
            const pendingDeliveryId = subscriber.pendingDeliveryIds.shift();
            if (pendingDeliveryId !== deliveredId) {
                throw new Error("Realtime subscriber delivery cursor is inconsistent");
            }
            state.advanceRequiredCursor(subscriber);
        }
    } finally {
        options.signal.removeEventListener("abort", abort);
        state.subscribers.delete(subscriber);
        if (!subscriberController.signal.aborted) {
            subscriberController.abort();
        }
        queue.close();
    }
}
