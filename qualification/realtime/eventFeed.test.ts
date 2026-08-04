import { describe, expect, test } from "bun:test";

import { waitFor } from "../test/waitFor.ts";
import { QualificationEventFeed } from "./eventFeed.ts";

describe("qualification event feed", () => {
    test("joins replay and live delivery without a gap", async () => {
        const eventFeed = new QualificationEventFeed();
        const abortController = new AbortController();
        eventFeed.publish({ kind: "qualification.changed", value: 1 });
        eventFeed.publish({ kind: "qualification.changed", value: 2 });

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
        eventFeed.publish({ kind: "qualification.changed", value: 3 });
        const deliveredLiveEvent = await liveEvent;
        if (deliveredLiveEvent.done) {
            throw new Error("Live subscription ended before returning an event");
        }
        expect(deliveredLiveEvent.value.id).toBe("3");

        abortController.abort();
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });

    test("keeps the replay snapshot stable when retention advances", async () => {
        const eventFeed = new QualificationEventFeed();
        const abortController = new AbortController();
        const retainedEventCount = 128;

        for (let value = 1; value <= retainedEventCount; value += 1) {
            eventFeed.publish({ kind: "qualification.changed", value });
        }

        const subscription = eventFeed.subscribe({ signal: abortController.signal });
        const firstReplayEvent = await subscription.next();
        if (firstReplayEvent.done) {
            throw new Error("Replay subscription ended before returning its first event");
        }
        expect(firstReplayEvent.value.id).toBe("1");

        eventFeed.publish({
            kind: "qualification.changed",
            value: retainedEventCount + 1,
        });

        const secondReplayEvent = await subscription.next();
        if (secondReplayEvent.done) {
            throw new Error(
                "Replay subscription ended before returning its second event"
            );
        }
        expect(secondReplayEvent.value.id).toBe("2");

        abortController.abort();
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });

    test("rejects a resume cursor ahead of the feed tail", async () => {
        const eventFeed = new QualificationEventFeed();
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
            "Qualification event resume cursor is ahead of feed tail"
        );
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });

    test("accepts a resume cursor at the feed tail", async () => {
        const eventFeed = new QualificationEventFeed();
        const abortController = new AbortController();
        eventFeed.publish({ kind: "qualification.changed", value: 1 });
        const subscription = eventFeed.subscribe({
            afterId: "1",
            signal: abortController.signal,
        });
        const nextEvent = subscription.next();
        eventFeed.publish({ kind: "qualification.changed", value: 2 });

        const deliveredEvent = await nextEvent;
        if (deliveredEvent.done) {
            throw new Error("Tail subscription ended before returning a live event");
        }
        expect(deliveredEvent.value.id).toBe("2");

        abortController.abort();
        const completedSubscription = await subscription.next();
        expect(completedSubscription.done).toBeTrue();
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });

    test("fails and detaches a subscriber that exceeds its queue budget", async () => {
        const eventFeed = new QualificationEventFeed();
        const abortController = new AbortController();
        const subscription = eventFeed.subscribe({ signal: abortController.signal });
        const firstEvent = subscription.next();
        await waitFor(() => eventFeed.activeSubscriberCount === 1);

        for (let value = 1; value <= 18; value += 1) {
            eventFeed.publish({ kind: "qualification.changed", value });
        }
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
            "Qualification event subscriber exceeded its queue budget"
        );
        expect(eventFeed.activeSubscriberCount).toBe(0);
    });
});
