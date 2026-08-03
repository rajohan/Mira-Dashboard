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
