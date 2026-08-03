import { afterEach, describe, expect, test } from "bun:test";

import {
    createTRPCClient,
    httpBatchLink,
    httpSubscriptionLink,
    splitLink,
} from "@trpc/client";
import { EventSource } from "eventsource";

import { QualificationEventFeed } from "../realtime/eventFeed.ts";
import { runtimeCandidate } from "../runtimeCandidate.ts";
import { waitFor } from "../test/waitFor.ts";
import type { QualificationRouter } from "./router.ts";
import { startQualificationServer } from "./server.ts";

const servers: Array<ReturnType<typeof startQualificationServer>> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

function createQualificationClient(serverUrl: URL) {
    const url = new URL("/trpc", serverUrl).toString();
    return createTRPCClient<QualificationRouter>({
        links: [
            splitLink({
                condition: (operation) => operation.type === "subscription",
                false: httpBatchLink({ url }),
                true: httpSubscriptionLink({ EventSource, url }),
            }),
        ],
    });
}

describe("tRPC Fetch and tracked SSE on Bun", () => {
    test("serves validated queries and mutations through Bun.serve", async () => {
        const eventFeed = new QualificationEventFeed();
        const server = startQualificationServer(eventFeed);
        servers.push(server);
        const client = createQualificationClient(server.url);

        expect(await client.runtime.identity.query()).toEqual({
            hasGlobalEventSource: false,
            revision: runtimeCandidate.revision,
            version: runtimeCandidate.version,
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
    });

    test("resumes tracked events after a forced SSE reconnect without duplicates", async () => {
        const eventFeed = new QualificationEventFeed();
        const server = startQualificationServer(eventFeed);
        servers.push(server);
        const client = createQualificationClient(server.url);
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
            await waitFor(
                () => eventFeed.observedResumeIds.some((resumeId) => resumeId === "1"),
                5000
            );

            await client.events.publish.mutate({
                kind: "qualification.changed",
                value: 2,
            });
            await waitFor(() => receivedIds.length === 2);

            expect(receivedIds).toEqual(["1", "2"]);
            expect(subscriptionErrors).toEqual([]);
        } finally {
            subscription.unsubscribe();
        }

        await waitFor(() => eventFeed.activeSubscriberCount === 0);
    });
});
