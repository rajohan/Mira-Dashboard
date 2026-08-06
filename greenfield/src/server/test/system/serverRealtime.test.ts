import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { secondsToMilliseconds } from "date-fns";
import { EventSource, type EventSourceFetchInit } from "eventsource";
import superjson from "superjson";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import { type ApplicationServer, createServer } from "../../../app/server.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import {
    openAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../../domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import type { ApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import { generateOpaqueToken } from "../../shared/opaqueToken.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { withTestTimeout } from "../support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationResolution,
    createTestServerSecurityServices,
    createTestSessionAuthentication,
} from "../support/requestContext.ts";

const testSessionCredential = generateOpaqueToken("session");
const sessionCookie = `${dashboardSessionCookieName}=${testSessionCredential.token}`;
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

function eventSourceFetchWithCookie(
    cookie: string,
    observeResponse?: (response: Response) => void
) {
    return async (url: string | URL, init: EventSourceFetchInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        const response = await fetch(url, { ...init, headers });
        observeResponse?.(response);
        return response;
    };
}

function createEventsClient(
    server: ApplicationServer,
    cookie?: string,
    observeResponse?: (response: Response) => void
) {
    return createTRPCClient<AppRouter>({
        links: [
            httpSubscriptionLink({
                EventSource,
                ...(cookie
                    ? {
                          eventSourceOptions: {
                              fetch: eventSourceFetchWithCookie(cookie, observeResponse),
                          },
                      }
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
        ...createTestServerSecurityServices({
            authenticateCredential: (credential) =>
                credential.kind === "session" &&
                credential.token.prefix === testSessionCredential.prefix &&
                credential.token.validatorHash === testSessionCredential.validatorHash
                    ? createTestAuthenticationResolution(
                          createTestSessionAuthentication(["reports:read"])
                      )
                    : createTestAuthenticationResolution({ kind: "anonymous" }),
        }),
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

        const observedCacheControl: string[] = [];
        const authenticatedClient = createEventsClient(
            server,
            sessionCookie,
            (response) => {
                observedCacheControl.push(response.headers.get("cache-control") ?? "");
            }
        );
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
        expect(observedCacheControl[0]).toContain("no-cache");
        expect(observedCacheControl[0]).toContain("no-store");
        expect(observedCacheControl[0]).toContain("no-transform");

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

        const anonymousClient = createEventsClient(server);
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

    test("wires a migrated session through the real server composition", async () => {
        const fixture = await openAuthenticationTestDatabase(new Date());
        let server: ApplicationServer | undefined;

        try {
            const runtime = createTestApplicationRuntime({
                stream: () =>
                    Promise.resolve(
                        (async function* () {
                            yield await Promise.resolve(reportDelivery);
                        })()
                    ),
            });
            server = await createDashboardServer({
                applicationRuntime: runtime,
                browserOrigin: "https://dashboard.example",
                database: fixture.database.orm,
                gatewayUrl: "ws://127.0.0.1:1",
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            servers.push(server);
            const client = createEventsClient(
                server,
                `${dashboardSessionCookieName}=${fixture.session.token}`
            );
            const firstEvent = Promise.withResolvers<RealtimeStreamOutput>();
            const subscription = client.events.stream.subscribe(
                { topics: [monitoringRealtimeTopics.reports] },
                { onData: firstEvent.resolve, onError: firstEvent.reject }
            );

            expect(
                await withTestTimeout(
                    firstEvent.promise,
                    testWaitTimeoutMs,
                    "Persisted session did not authenticate the realtime stream"
                )
            ).toMatchObject({
                data: { kind: "change" },
                id: "1",
            });
            subscription.unsubscribe();
        } finally {
            if (server !== undefined) {
                await server.stop(true);
                const index = servers.indexOf(server);
                if (index !== -1) servers.splice(index, 1);
            }
            fixture.database.sqlite.close(true);
        }
    });
});
