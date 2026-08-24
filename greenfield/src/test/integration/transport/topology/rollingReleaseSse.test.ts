import { describe, expect, test } from "bun:test";

import { AsyncCleanupStack } from "../../../support/asyncCleanupStack.ts";
import { waitFor } from "../../../support/waitFor.ts";
import { IntegrationEventFeed } from "../realtime/eventFeed.ts";
import { createIntegrationClient } from "../trpc/client.ts";
import { startIntegrationServer } from "../trpc/server.ts";
import { startHttpsReverseProxy } from "./httpsReverseProxy.ts";
import { createTestTlsIdentity } from "./testTlsIdentity.ts";
import { createTrustedFetch } from "./trustedFetch.ts";

const scenarioCookie = "mira_scenario=trusted-session";

function createProxiedClient(url: URL, certificateAuthority: string) {
    const trustedFetch = createTrustedFetch({
        certificateAuthority,
        cookie: scenarioCookie,
    });
    return createIntegrationClient({
        eventSourceOptions: {
            fetch: trustedFetch,
            withCredentials: true,
        },
        fetch: trustedFetch,
        retrySubscriptions: true,
        url,
    });
}

describe("production-shaped HTTPS and rolling-release SSE topology", () => {
    test("keeps readiness honest and resumes a tracked stream on the replacement release", async () => {
        const cleanup = new AsyncCleanupStack();
        let subscription: { unsubscribe(): void } | undefined;

        try {
            const tlsIdentity = await createTestTlsIdentity();
            cleanup.defer("rolling-release scenario TLS identity", () =>
                tlsIdentity.dispose()
            );
            const eventFeed = new IntegrationEventFeed();
            const releaseA = startIntegrationServer({
                eventFeed,
                hostname: "127.0.0.1",
                releaseId: "release-a",
                requiredCookie: scenarioCookie,
                requireSecureProxy: true,
            });
            cleanup.defer("rolling-release scenario A", () => releaseA.stop(true));
            const releasePort = releaseA.port;
            const proxy = startHttpsReverseProxy({
                certificate: tlsIdentity.certificate,
                downstreamStreamErrorMode: "opaque",
                privateKey: tlsIdentity.privateKey,
                target: new URL(`http://127.0.0.1:${releasePort}`),
            });
            cleanup.defer("rolling-release scenario proxy", () => proxy.stop(true));
            const publicFetch = createTrustedFetch({
                certificateAuthority: tlsIdentity.certificate,
            });
            const client = createProxiedClient(proxy.url, tlsIdentity.certificate);
            const receivedIds: string[] = [];
            const subscriptionErrors: Error[] = [];
            let startedCount = 0;

            const live = await publicFetch(new URL("/api/health/live", proxy.url));
            const unavailable = await publicFetch(
                new URL("/api/health/ready", proxy.url)
            );
            const headUnavailable = await publicFetch(
                new URL("/api/health/ready", proxy.url),
                { method: "HEAD" }
            );

            expect(live.status).toBe(200);
            expect(await live.json()).toEqual({
                releaseId: "release-a",
                status: "live",
            });
            expect(unavailable.status).toBe(503);
            expect(await unavailable.json()).toEqual({
                releaseId: "release-a",
                status: "not-ready",
            });
            expect(headUnavailable.status).toBe(503);
            expect(await headUnavailable.text()).toBe("");
            expect(() => releaseA.readiness.markReady("release-b")).toThrow(
                "Cannot mark an unexpected integration release ready"
            );

            releaseA.readiness.markReady("release-a");
            const ready = await publicFetch(new URL("/api/health/ready", proxy.url));
            expect(ready.status).toBe(200);
            expect(await ready.json()).toEqual({
                releaseId: "release-a",
                status: "ready",
            });

            const unauthorized = await publicFetch(
                new URL("/trpc/runtime.identity", proxy.url)
            );
            expect(unauthorized.status).toBe(401);
            const bypassAttempt = await fetch(
                new URL("/trpc/runtime.identity", releaseA.url),
                { headers: { cookie: scenarioCookie } }
            );
            expect(bypassAttempt.status).toBe(400);
            const releaseAIdentity = await client.runtime.identity.query();
            expect(releaseAIdentity.releaseId).toBe("release-a");

            subscription = client.events.stream.subscribe(
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
            cleanup.defer("rolling-release scenario subscription", () => {
                subscription?.unsubscribe();
            });
            await waitFor(() => startedCount === 1);
            await client.events.publish.mutate({
                kind: "integration.changed",
                value: 1,
            });
            await waitFor(() => receivedIds.length === 1);
            expect(receivedIds).toEqual(["1"]);

            await releaseA.stop(true);
            expect(releaseA.readiness.snapshot()).toEqual({
                releaseId: "release-a",
                status: "not-ready",
            });
            await waitFor(() => eventFeed.activeSubscriberCount === 0);

            eventFeed.publish({ kind: "integration.changed", value: 2 });
            await waitFor(() => proxy.upstreamUnavailableCount >= 1, 5000);

            const releaseB = startIntegrationServer({
                eventFeed,
                hostname: "127.0.0.1",
                port: releasePort,
                releaseId: "release-b",
                requiredCookie: scenarioCookie,
                requireSecureProxy: true,
            });
            cleanup.defer("rolling-release scenario B", () => releaseB.stop(true));
            releaseB.readiness.markReady("release-b");
            const releaseBIdentity = await client.runtime.identity.query();
            expect(releaseBIdentity.releaseId).toBe("release-b");

            await waitFor(() => startedCount >= 2, 5000);
            await waitFor(() => eventFeed.activeSubscriberCount === 1);
            await waitFor(() => receivedIds.length === 2);
            await client.events.publish.mutate({
                kind: "integration.changed",
                value: 3,
            });
            await waitFor(() => receivedIds.length === 3);

            expect(eventFeed.observedResumeIds.at(-1)).toBe("1");
            expect(receivedIds).toEqual(["1", "2", "3"]);
            expect(subscriptionErrors).toEqual([]);

            subscription.unsubscribe();
            subscription = undefined;
            await waitFor(() => eventFeed.activeSubscriberCount === 0);
            expect(eventFeed.activeSubscriberCount).toBe(0);
        } finally {
            subscription?.unsubscribe();
            await cleanup.dispose();
        }
    }, 10_000);
});
