import { afterEach, describe, expect, test } from "bun:test";

import {
    QualificationEventFeed,
    qualificationEventLimits,
} from "../realtime/eventFeed.ts";
import { waitFor } from "../test/waitFor.ts";
import { createQualificationClient } from "./client.ts";
import { startQualificationServer } from "./server.ts";

const servers: Array<ReturnType<typeof startQualificationServer>> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

describe("tRPC Fetch and tracked SSE on Bun", () => {
    test("serves validated queries and mutations through Bun.serve", async () => {
        const eventFeed = new QualificationEventFeed();
        const server = startQualificationServer({
            eventFeed,
            maximumStreamDurationMs: 300,
            releaseId: "direct-release",
        });
        servers.push(server);
        const client = createQualificationClient({ url: server.url });

        expect(await client.runtime.identity.query()).toEqual({
            hasGlobalEventSource: false,
            releaseId: "direct-release",
            revision: Bun.revision,
            version: Bun.version,
        });
        expect(
            await client.events.publish.mutate({
                kind: "qualification.changed",
                value: 1,
            })
        ).toEqual({
            data: {
                kind: "qualification.changed",
                value: 1,
            },
            id: "1",
        });
        let payloadError: unknown;
        try {
            await client.events.publish.mutate({
                kind: "qualification.changed",
                payload: `${"é".repeat(
                    qualificationEventLimits.maximumPayloadBytes / 2
                )}a`,
                value: 2,
            });
        } catch (error) {
            payloadError = error;
        }
        expect(payloadError).toBeInstanceOf(Error);
        expect((payloadError as Error).message).toContain(
            "Qualification event payload must not exceed"
        );
        expect(eventFeed.metricsSnapshot().latestSequence).toBe(1);
    });

    test("resumes tracked events after a forced SSE reconnect without duplicates", async () => {
        const eventFeed = new QualificationEventFeed();
        const server = startQualificationServer({
            eventFeed,
            maximumStreamDurationMs: 300,
            releaseId: "direct-release",
        });
        servers.push(server);
        const client = createQualificationClient({ url: server.url });
        const receivedIds: string[] = [];
        const subscriptionErrors: Error[] = [];
        let startedCount = 0;

        const subscription = client.events.stream.subscribe(
            {},
            {
                onData(event) {
                    receivedIds.push(event.id);
                },
                onError(error) {
                    subscriptionErrors.push(error);
                },
                onStarted() {
                    startedCount += 1;
                },
            }
        );

        try {
            await waitFor(() => startedCount >= 1);
            await client.events.publish.mutate({
                kind: "qualification.changed",
                value: 1,
            });
            await waitFor(() => receivedIds.length === 1);
            await waitFor(() => eventFeed.activeSubscriberCount === 0, 5000);
            expect(startedCount).toBe(1);

            await client.events.publish.mutate({
                kind: "qualification.changed",
                value: 2,
            });
            expect(receivedIds).toEqual(["1"]);

            await waitFor(() => startedCount >= 2, 5000);
            await waitFor(() => receivedIds.length === 2);

            expect(eventFeed.observedResumeIds.at(1)).toBe("1");
            expect(receivedIds).toEqual(["1", "2"]);
            expect(subscriptionErrors).toEqual([]);
        } finally {
            subscription.unsubscribe();
        }

        await waitFor(() => eventFeed.activeSubscriberCount === 0);
    });
});
