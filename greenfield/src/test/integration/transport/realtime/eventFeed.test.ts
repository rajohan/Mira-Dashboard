import { describe, expect, test } from "bun:test";

import { waitFor } from "../../../support/waitFor.ts";
import { IntegrationEventFeed, integrationEventLimits } from "./eventFeed.ts";

describe("integration event feed", () => {
    test("enforces the exact UTF-8 payload budget before advancing the feed", () => {
        const eventFeed = new IntegrationEventFeed();
        const maximumMultibytePayload = "é".repeat(
            integrationEventLimits.maximumPayloadBytes / 2
        );
        const acceptedEvent = eventFeed.publish({
            kind: "integration.changed",
            payload: maximumMultibytePayload,
            value: 1,
        });

        expect(Object.isFrozen(integrationEventLimits)).toBeTrue();
        expect(acceptedEvent.data.payload).toBe(maximumMultibytePayload);
        expect(acceptedEvent.id).toBe("1");
        expect(() =>
            eventFeed.publish({
                kind: "integration.changed",
                payload: `${maximumMultibytePayload}a`,
                value: 2,
            })
        ).toThrow(
            `Integration event payload exceeds ${integrationEventLimits.maximumPayloadBytes} UTF-8 bytes`
        );
        expect(eventFeed.metricsSnapshot()).toEqual({
            activeSubscribers: 0,
            droppedSlowSubscribers: 0,
            latestSequence: 1,
            maximumObservedQueueDepth: 0,
            maximumObservedQueuedPayloadBytes: 0,
            retainedEvents: 1,
        });
    });

    test("joins replay and live delivery without a gap", async () => {
        const eventFeed = new IntegrationEventFeed();
        const abortController = new AbortController();
        eventFeed.publish({ kind: "integration.changed", value: 1 });
        eventFeed.publish({ kind: "integration.changed", value: 2 });

        const subscription = eventFeed.subscribe({
            afterId: "1",
            signal: abortController.signal,
        });
        const replayEvent = await subscription.next();
        if (replayEvent.done) {
            throw new Error("Replay subscription ended before returning an event");
        }
        expect(replayEvent.value.id).toBe("2");

        const liveEvent = subscription.next();
        eventFeed.publish({ kind: "integration.changed", value: 3 });
        const deliveredLiveEvent = await liveEvent;
        if (deliveredLiveEvent.done) {
            throw new Error("Live subscription ended before returning an event");
        }
        expect(deliveredLiveEvent.value.id).toBe("3");

        abortController.abort();
        expect(eventFeed.activeSubscriberCount).toBe(0);
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
    });

    test("keeps the replay snapshot stable when retention advances", async () => {
        const eventFeed = new IntegrationEventFeed();
        const abortController = new AbortController();
        const retainedEventCount = integrationEventLimits.maximumRetainedEvents;

        for (let value = 1; value <= retainedEventCount; value += 1) {
            eventFeed.publish({ kind: "integration.changed", value });
        }

        const subscription = eventFeed.subscribe({ signal: abortController.signal });
        const firstReplayEvent = await subscription.next();
        if (firstReplayEvent.done) {
            throw new Error("Replay subscription ended before returning its first event");
        }
        expect(firstReplayEvent.value.id).toBe("1");

        eventFeed.publish({
            kind: "integration.changed",
            value: retainedEventCount + 1,
        });
        expect(eventFeed.metricsSnapshot()).toMatchObject({
            latestSequence: retainedEventCount + 1,
            retainedEvents: integrationEventLimits.maximumRetainedEvents,
        });

        const secondReplayEvent = await subscription.next();
        if (secondReplayEvent.done) {
            throw new Error(
                "Replay subscription ended before returning its second event"
            );
        }
        expect(secondReplayEvent.value.id).toBe("2");

        abortController.abort();
        expect(eventFeed.activeSubscriberCount).toBe(0);
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
    });

    test("rejects a resume cursor ahead of the feed tail", async () => {
        const eventFeed = new IntegrationEventFeed();
        const subscription = eventFeed.subscribe({
            afterId: "100",
            signal: new AbortController().signal,
        });

        let resumeError: unknown;
        try {
            await subscription.next();
        } catch (error) {
            resumeError = error;
        }
        expect(resumeError).toBeInstanceOf(Error);
        expect((resumeError as Error).message).toBe(
            "Integration event resume cursor is ahead of feed tail"
        );
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });

    test("rejects a malformed or oversized resume cursor", async () => {
        for (const afterId of ["01", "-1", "9".repeat(10_000)]) {
            const eventFeed = new IntegrationEventFeed();
            const subscription = eventFeed.subscribe({
                afterId,
                signal: new AbortController().signal,
            });

            expect(
                await subscription.next().catch((error: unknown) => error)
            ).toMatchObject({
                message: "Integration event resume cursor is invalid",
            });
            expect(eventFeed.activeSubscriberCount).toBe(0);
        }
    });

    test("accepts a resume cursor at the feed tail", async () => {
        const eventFeed = new IntegrationEventFeed();
        const abortController = new AbortController();
        eventFeed.publish({ kind: "integration.changed", value: 1 });
        const subscription = eventFeed.subscribe({
            afterId: "1",
            signal: abortController.signal,
        });
        const nextEvent = subscription.next();
        eventFeed.publish({ kind: "integration.changed", value: 2 });

        const deliveredEvent = await nextEvent;
        if (deliveredEvent.done) {
            throw new Error("Tail subscription ended before returning a live event");
        }
        expect(deliveredEvent.value.id).toBe("2");

        abortController.abort();
        expect(eventFeed.activeSubscriberCount).toBe(0);
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
    });

    test("fails and detaches a subscriber that exceeds its queue budget", async () => {
        const eventFeed = new IntegrationEventFeed();
        const abortController = new AbortController();
        const subscription = eventFeed.subscribe({ signal: abortController.signal });
        const firstEvent = subscription.next();
        const maximumPayload = "a".repeat(integrationEventLimits.maximumPayloadBytes);
        const overflowEventCount =
            integrationEventLimits.maximumSubscriberQueueEvents + 2;
        await waitFor(() => eventFeed.activeSubscriberCount === 1);

        for (let value = 1; value <= overflowEventCount; value += 1) {
            eventFeed.publish({
                kind: "integration.changed",
                payload: maximumPayload,
                value,
            });
        }
        await waitFor(() => eventFeed.activeSubscriberCount === 0);
        eventFeed.publish({
            kind: "integration.changed",
            payload: maximumPayload,
            value: overflowEventCount + 1,
        });

        const deliveredFirstEvent = await firstEvent;
        if (deliveredFirstEvent.done) {
            throw new Error("Slow subscription ended before returning its first event");
        }
        expect(deliveredFirstEvent.value.id).toBe("1");

        let overflowError: unknown;
        try {
            await subscription.next();
        } catch (error) {
            overflowError = error;
        }
        expect(overflowError).toBeInstanceOf(Error);
        expect((overflowError as Error).message).toBe(
            "Integration event subscriber exceeded its queue budget"
        );
        expect(eventFeed.activeSubscriberCount).toBe(0);
        const metrics = eventFeed.metricsSnapshot();
        expect(metrics.droppedSlowSubscribers).toBe(1);
        expect(metrics.maximumObservedQueueDepth).toBe(
            integrationEventLimits.maximumSubscriberQueueEvents
        );
        expect(metrics.maximumObservedQueuedPayloadBytes).toBe(
            integrationEventLimits.maximumSubscriberQueuedPayloadBytes
        );
    });
});
