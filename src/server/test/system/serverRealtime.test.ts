import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { secondsToMilliseconds } from "date-fns";
import { EventSource, type EventSourceFetchInit } from "eventsource";
import superjson from "superjson";

import { type ApplicationServer, createServer } from "../../../app/server.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import type { ApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { withTestTimeout } from "../support/promise.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

const sessionCookie = "mira_session=valid-test-session";
const testWaitTimeoutMs = secondsToMilliseconds(2);
const servers: ApplicationServer[] = [];

const reportDelivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: monitoringRealtimeTopics.reports,
    },
    id: "1",
    kind: "change",
};

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

function authenticatedEventSourceFetch(
    url: string | URL,
    init: EventSourceFetchInit
): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", sessionCookie);
    return fetch(url, { ...init, headers });
}

function createEventsClient(server: ApplicationServer, authenticated: boolean) {
    return createTRPCClient<AppRouter>({
        links: [
            httpSubscriptionLink({
                EventSource,
                ...(authenticated
                    ? { eventSourceOptions: { fetch: authenticatedEventSourceFetch } }
                    : {}),
                transformer: superjson,
                url: new URL("/trpc", server.url).toString(),
            }),
        ],
    });
}

async function startRealtimeServer(
    applicationRuntime: ApplicationRuntime
): Promise<ApplicationServer> {
    const server = await createServer({
        applicationRuntime,
        authenticateRequest: (request) =>
            request.headers.get("cookie") === sessionCookie
                ? {
                      kind: "authenticated" as const,
                      principal: {
                          capabilities: ["reports:read"] as const,
                          id: "test-session",
                          kind: "session" as const,
                      },
                  }
                : { kind: "anonymous" as const },
        hostname: "127.0.0.1",
        port: 0,
        readiness: createReadinessController(),
    });
    servers.push(server);
    return server;
}

describe("application server realtime transport", () => {
    test("streams authorized tracked events and cleans up on unsubscribe", async () => {
        const cleanedUp = Promise.withResolvers<void>();
        let streamCalls = 0;
        let streamSignal: AbortSignal | undefined;
        const runtime = createTestApplicationRuntime({
            stream: (options) => {
                streamCalls += 1;
                streamSignal = options.signal;
                return Promise.resolve(
                    (async function* () {
                        try {
                            yield reportDelivery;
                            await new Promise<void>((resolve) => {
                                if (options.signal?.aborted === true) {
                                    resolve();
                                    return;
                                }
                                options.signal?.addEventListener(
                                    "abort",
                                    () => resolve(),
                                    {
                                        once: true,
                                    }
                                );
                            });
                        } finally {
                            cleanedUp.resolve();
                        }
                    })()
                );
            },
        });
        const server = await startRealtimeServer(runtime);

        const authenticatedClient = createEventsClient(server, true);
        const firstEvent = Promise.withResolvers<RealtimeStreamOutput>();
        const authenticatedSubscription = authenticatedClient.events.stream.subscribe(
            { topics: [monitoringRealtimeTopics.reports] },
            { onData: firstEvent.resolve, onError: firstEvent.reject }
        );

        expect(
            await withTestTimeout(
                firstEvent.promise,
                testWaitTimeoutMs,
                "Authorized realtime stream did not emit its first event"
            )
        ).toEqual({
            data: {
                event: {
                    entityId: "report-1",
                    entityType: "report",
                    occurredAtMs: 1,
                    operation: "created",
                    payload: { id: "report-1" },
                    topic: monitoringRealtimeTopics.reports,
                },
                kind: "change",
            },
            id: "1",
        });
        expect(streamCalls).toBe(1);
        expect(streamSignal?.aborted).toBe(false);

        authenticatedSubscription.unsubscribe();
        await withTestTimeout(
            cleanedUp.promise,
            testWaitTimeoutMs,
            "Realtime stream did not clean up after unsubscribe"
        );
        expect(streamSignal?.aborted).toBe(true);
    });

    test("rejects anonymous subscribers before runtime access", async () => {
        let streamCalls = 0;
        const runtime = createTestApplicationRuntime({
            stream: () => {
                streamCalls += 1;
                return Promise.reject(
                    new Error("Anonymous caller reached the realtime runtime")
                );
            },
        });
        const server = await startRealtimeServer(runtime);

        const anonymousClient = createEventsClient(server, false);
        const anonymousFailure = Promise.withResolvers<Error>();
        const anonymousSubscription = anonymousClient.events.stream.subscribe(
            { topics: [monitoringRealtimeTopics.reports] },
            {
                onData: () =>
                    anonymousFailure.reject(new Error("Anonymous stream emitted data")),
                onError: anonymousFailure.resolve,
            }
        );

        const authenticationError = await withTestTimeout(
            anonymousFailure.promise,
            testWaitTimeoutMs,
            "Anonymous realtime stream did not return an authentication error"
        );
        expect(authenticationError.message).toBe("Authentication required");
        anonymousSubscription.unsubscribe();
        expect(streamCalls).toBe(0);
    });
});
