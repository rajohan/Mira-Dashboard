import { afterEach, describe, expect, test } from "bun:test";

import { waitFor } from "../../../support/waitFor.ts";
import { IntegrationEventFeed, integrationEventLimits } from "../realtime/eventFeed.ts";
import { createIntegrationClient } from "./client.ts";
import { integrationRequestBodyMaximumBytes, startIntegrationServer } from "./server.ts";

const servers: Array<ReturnType<typeof startIntegrationServer>> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

describe("tRPC Fetch and tracked SSE on Bun", () => {
    test("serves validated queries and mutations through Bun.serve", async () => {
        const eventFeed = new IntegrationEventFeed();
        const server = startIntegrationServer({
            eventFeed,
            hostname: "127.0.0.1",
            maximumStreamDurationMs: 300,
            releaseId: "direct-release",
        });
        servers.push(server);
        const client = createIntegrationClient({ url: server.url });

        expect(await client.runtime.identity.query()).toEqual({
            hasGlobalEventSource: false,
            releaseId: "direct-release",
            revision: Bun.revision,
            version: Bun.version,
        });
        expect(
            await client.events.publish.mutate({
                kind: "integration.changed",
                value: 1,
            })
        ).toEqual({
            data: {
                kind: "integration.changed",
                value: 1,
            },
            id: "1",
        });
        let payloadError: unknown;
        try {
            await client.events.publish.mutate({
                kind: "integration.changed",
                payload: `${"é".repeat(integrationEventLimits.maximumPayloadBytes / 2)}a`,
                value: 2,
            });
        } catch (error) {
            payloadError = error;
        }
        expect(payloadError).toBeInstanceOf(Error);
        expect((payloadError as Error).message).toContain(
            "Integration event payload must not exceed"
        );
        let unknownInputError: unknown;
        try {
            await client.events.publish.mutate({
                kind: "integration.changed",
                unexpected: true,
                value: 2,
            } as never);
        } catch (error) {
            unknownInputError = error;
        }
        expect(unknownInputError).toBeInstanceOf(Error);
        expect(eventFeed.metricsSnapshot().latestSequence).toBe(1);
    });

    test("rejects request bodies above the integration transport budget", async () => {
        const server = startIntegrationServer({
            eventFeed: new IntegrationEventFeed(),
            hostname: "127.0.0.1",
            releaseId: "direct-release",
        });
        servers.push(server);

        const response = await fetch(new URL("/trpc/events.publish", server.url), {
            body: "x".repeat(integrationRequestBodyMaximumBytes + 1),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(response.status).toBe(413);
    });

    test("resumes tracked events after a forced SSE reconnect without duplicates", async () => {
        const eventFeed = new IntegrationEventFeed();
        const server = startIntegrationServer({
            eventFeed,
            hostname: "127.0.0.1",
            maximumStreamDurationMs: 300,
            releaseId: "direct-release",
        });
        servers.push(server);
        const client = createIntegrationClient({ url: server.url });
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
                kind: "integration.changed",
                value: 1,
            });
            await waitFor(() => receivedIds.length === 1);
            await waitFor(() => eventFeed.activeSubscriberCount === 0, 5000);
            expect(startedCount).toBe(1);

            await client.events.publish.mutate({
                kind: "integration.changed",
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
