import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { EventSource, type EventSourceFetchInit } from "eventsource";
import superjson from "superjson";

import { type ApplicationServer, createServer } from "../../../app/server.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

const sessionCookie = "mira_session=valid-test-session";
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

describe("application server realtime transport", () => {
    test("streams authorized tracked events and cleans up on unsubscribe", async () => {
        let finishCleanup: (() => void) | undefined;
        const cleanedUp = new Promise<void>((resolve) => {
            finishCleanup = resolve;
        });
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
                            finishCleanup?.();
                        }
                    })()
                );
            },
        });
        const server = await createServer({
            applicationRuntime: runtime,
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

        const authenticatedClient = createEventsClient(server, true);
        let authenticatedSubscription:
            | ReturnType<typeof authenticatedClient.events.stream.subscribe>
            | undefined;
        const firstEvent = new Promise<RealtimeStreamOutput>((resolve, reject) => {
            authenticatedSubscription = authenticatedClient.events.stream.subscribe(
                { topics: [monitoringRealtimeTopics.reports] },
                { onData: resolve, onError: reject }
            );
        });

        expect(await firstEvent).toEqual({
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

        authenticatedSubscription?.unsubscribe();
        await cleanedUp;
        expect(streamSignal?.aborted).toBe(true);

        const anonymousClient = createEventsClient(server, false);
        let anonymousSubscription:
            | ReturnType<typeof anonymousClient.events.stream.subscribe>
            | undefined;
        const anonymousFailure = new Promise<Error>((resolve, reject) => {
            anonymousSubscription = anonymousClient.events.stream.subscribe(
                { topics: [monitoringRealtimeTopics.reports] },
                {
                    onData: () => reject(new Error("Anonymous stream emitted data")),
                    onError: resolve,
                }
            );
        });

        const authenticationError = await anonymousFailure;
        expect(authenticationError.message).toBe("Authentication required");
        anonymousSubscription?.unsubscribe();
        expect(streamCalls).toBe(1);
    });
});
