import {
    cursorIsOutsideRetention,
    errorFromUnknown,
    parseRealtimeEventPumpClock,
    type RealtimeEventPollPlan,
} from "./eventPumpContract.ts";
import {
    type PreparedDelivery,
    type RealtimeEventPumpState,
    type Subscriber,
} from "./eventPumpState.ts";

/**
 * Performs one synchronous, bounded poll step for the scoped Effect runner.
 * @param state Mutable pump state owned by the scoped service.
 * @returns The next adaptive polling action.
 */
export function pollRealtimeEvents(state: RealtimeEventPumpState): RealtimeEventPollPlan {
    if (state.closed) {
        throw new Error("Realtime event pump is closed");
    }
    state.polls += 1;

    const nowMs = parseRealtimeEventPumpClock(state.nowMs());
    const sampledBounds = state.sampleRetainedEventsIfDue(nowMs);
    if (state.subscribers.size === 0) {
        const bounds = sampledBounds ?? state.store.readCursorBounds();
        state.observeBounds(bounds);
        state.pollCursor = bounds.latestIssuedId;
        return "idle";
    }

    state.advancePollCursorToActiveFloor();
    // One unfiltered page is required because subscribers can select different
    // topic sets while sharing this central cursor. Filtering happens below.
    const batch = state.store.readBatch({
        afterId: state.pollCursor,
        limit: state.maximumPageEvents,
    });
    const bounds = batch.bounds;
    state.observeBounds(bounds);
    if (state.pollCursor > bounds.latestIssuedId) {
        throw new Error("Realtime outbox tail moved behind the live poll cursor");
    }
    if (cursorIsOutsideRetention(state.pollCursor, bounds)) {
        const forcedSubscribers = state.forceResyncOutsideRetention(bounds);
        if (forcedSubscribers === 0) {
            throw new Error(
                "Realtime live poll cursor is outside retention without an affected subscriber"
            );
        }
        if (state.subscribers.size === 0) {
            state.pollCursor = bounds.latestIssuedId;
            return "idle";
        }
        state.advancePollCursorToActiveFloor();
        return "immediate";
    }

    const page = batch.events;
    state.observeBatch(page.length);
    for (const event of page) {
        const recipients: Subscriber[] = [];
        for (const subscriber of state.subscribers) {
            if (event.id <= subscriber.liveAfterId) {
                continue;
            }
            subscriber.observedCursor = event.id;
            if (subscriber.topics !== undefined && !subscriber.topics.has(event.topic)) {
                state.topicFilteredDeliveries += 1;
                try {
                    state.advanceRequiredCursor(subscriber);
                } catch (error) {
                    state.failSubscriber(
                        subscriber,
                        errorFromUnknown(
                            error,
                            "Realtime subscriber cursor update failed"
                        )
                    );
                }
                continue;
            }
            recipients.push(subscriber);
        }

        let prepared: PreparedDelivery | undefined;
        if (recipients.length > 0) {
            try {
                prepared = state.prepareDelivery(event);
            } catch (error) {
                const failure =
                    error instanceof Error
                        ? error
                        : new Error("Realtime event delivery is invalid");
                for (const subscriber of recipients) {
                    state.failSubscriber(subscriber, failure);
                }
            }
        }

        if (prepared !== undefined) {
            for (const subscriber of recipients) {
                subscriber.pendingDeliveryIds.push(event.id);
                try {
                    state.advanceRequiredCursor(subscriber);
                } catch (error) {
                    subscriber.pendingDeliveryIds.pop();
                    state.failSubscriber(
                        subscriber,
                        errorFromUnknown(
                            error,
                            "Realtime subscriber cursor update failed"
                        )
                    );
                    continue;
                }
                const result = subscriber.queue.push(
                    prepared.delivery,
                    prepared.deliveryBytes
                );
                if (!result.accepted) {
                    if (result.failure === undefined) {
                        state.subscribers.delete(subscriber);
                    } else {
                        state.droppedSlowSubscribers += 1;
                        state.failSubscriber(subscriber, result.failure);
                    }
                    continue;
                }
                state.maximumObservedQueueDepth = Math.max(
                    state.maximumObservedQueueDepth,
                    result.queuedEventCount
                );
                state.maximumObservedQueuedDeliveryBytes = Math.max(
                    state.maximumObservedQueuedDeliveryBytes,
                    result.queuedPayloadBytes
                );
            }
        }
        state.pollCursor = event.id;
    }

    if (state.subscribers.size === 0) {
        state.pollCursor = bounds.latestIssuedId;
        return "idle";
    }
    if (page.length === 0 && state.pollCursor < bounds.latestIssuedId) {
        state.forceResync(bounds.latestIssuedId);
        state.pollCursor = bounds.latestIssuedId;
        return "idle";
    }
    return state.pollCursor < bounds.latestIssuedId ? "immediate" : "active";
}
