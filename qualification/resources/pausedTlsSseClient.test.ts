import { describe, expect, test } from "bun:test";

import {
    QualificationEventFeed,
    qualificationEventLimits,
} from "../realtime/eventFeed.ts";
import { AsyncCleanupStack } from "../test/asyncCleanupStack.ts";
import { waitFor } from "../test/waitFor.ts";
import { startHttpsReverseProxy } from "../topology/httpsReverseProxy.ts";
import { createTestTlsIdentity } from "../topology/testTlsIdentity.ts";
import { startQualificationServer } from "../trpc/server.ts";
import {
    hasConnectedSseFrame,
    openPausedTlsSseClient,
    type PausedTlsSseClient,
} from "./pausedTlsSseClient.ts";
import { sseMemoryQualificationPolicy } from "./resourcePolicy.ts";

const responseHeaders = [
    "HTTP/1.1 200 OK",
    "Content-Type: text/event-stream",
    "Transfer-Encoding: chunked",
    "",
    "",
].join("\r\n");
const qualificationCookie = "mira_qualification=paused-native-client";

describe("paused native TLS SSE client", () => {
    test("recognizes a connected frame across HTTP chunks", () => {
        const response = [
            responseHeaders,
            "11\r\nevent: connected\n\r\n",
            "9\r\ndata: {}\n\r\n",
            "2\r\n\n\n\r\n",
        ].join("");
        const oversizedResponse = Buffer.concat([
            Buffer.from(response, "ascii"),
            Buffer.alloc(20 * 1024, 120),
        ]);
        expect(hasConnectedSseFrame(response.slice(0, -5))).toBeFalse();
        expect(hasConnectedSseFrame(response)).toBeTrue();
        expect(hasConnectedSseFrame(oversizedResponse)).toBeTrue();
    });

    test("recognizes a connected frame at the start of a large open chunk", () => {
        const response = Buffer.concat([
            Buffer.from(responseHeaders, "ascii"),
            Buffer.from("10000\r\n", "ascii"),
            Buffer.from("event: connected\ndata: {}\n\n", "ascii"),
            Buffer.alloc(20 * 1024, 120),
        ]);

        expect(hasConnectedSseFrame(response)).toBeTrue();
    });

    test("uses HTTP chunk byte lengths before decoding SSE text", () => {
        const nonAsciiPrelude = Buffer.concat([
            Buffer.from(responseHeaders, "ascii"),
            Buffer.from("2\r\n", "ascii"),
            Buffer.from("é", "utf8"),
            Buffer.from("\r\n", "ascii"),
            Buffer.from("1b\r\nevent: connected\ndata: {}\n\n\r\n", "ascii"),
        ]);

        expect(() => hasConnectedSseFrame(nonAsciiPrelude)).toThrow(
            "unexpected connected frame"
        );
    });

    test("rejects invalid status, framing, and unbounded handshakes", () => {
        expect(() =>
            hasConnectedSseFrame(responseHeaders.replace("200 OK", "503 Unavailable"))
        ).toThrow("non-200");
        expect(() =>
            hasConnectedSseFrame(
                responseHeaders.replace("Transfer-Encoding: chunked", "Content-Length: 0")
            )
        ).toThrow("chunked");
        expect(() => hasConnectedSseFrame("x".repeat(16 * 1024 + 1))).toThrow(
            "byte budget"
        );
    });

    test("propagates a paused TLS receive window to the bounded event queue", async () => {
        const cleanup = new AsyncCleanupStack();
        let client: PausedTlsSseClient | undefined;

        try {
            const tlsIdentity = await createTestTlsIdentity();
            cleanup.defer("paused client TLS identity", () => tlsIdentity.dispose());
            const eventFeed = new QualificationEventFeed();
            const release = startQualificationServer({
                eventFeed,
                hostname: "127.0.0.1",
                maximumStreamDurationMs: 9000,
                releaseId: "paused-native-client",
                requiredCookie: qualificationCookie,
                requireSecureProxy: true,
            });
            cleanup.defer("paused client release", () => release.stop(true));
            const proxy = startHttpsReverseProxy({
                certificate: tlsIdentity.certificate,
                privateKey: tlsIdentity.privateKey,
                target: new URL(`http://127.0.0.1:${release.port}`),
            });
            cleanup.defer("paused client proxy", () => proxy.stop(true));
            client = await openPausedTlsSseClient(
                proxy.url,
                tlsIdentity.certificate,
                qualificationCookie,
                2000
            );
            cleanup.defer("paused native client", () => client?.close());
            await waitFor(() => eventFeed.activeSubscriberCount === 1);

            const payload = "x".repeat(qualificationEventLimits.maximumPayloadBytes);
            for (
                let sequence = 1;
                sequence <= sseMemoryQualificationPolicy.scenario.maximumEventsPerRound;
                sequence += 1
            ) {
                eventFeed.publish({
                    kind: "qualification.changed",
                    payload,
                    value: sequence,
                });
                if (sequence % 8 === 0) await Bun.sleep(0);
                if (eventFeed.metricsSnapshot().droppedSlowSubscribers === 1) break;
            }

            try {
                await waitFor(
                    () =>
                        eventFeed.metricsSnapshot().droppedSlowSubscribers === 1 &&
                        eventFeed.activeSubscriberCount === 0,
                    5000
                );
            } catch (error) {
                const metrics = eventFeed.metricsSnapshot();
                throw new Error(
                    `Paused TLS backpressure did not reach the event queue: drops=${metrics.droppedSlowSubscribers}, active=${metrics.activeSubscribers}, queue=${metrics.maximumObservedQueueDepth}, queuedBytes=${metrics.maximumObservedQueuedPayloadBytes}, releasePending=${release.server.pendingRequests}, proxyPending=${proxy.server.pendingRequests}`,
                    { cause: error }
                );
            }
            expect(eventFeed.metricsSnapshot()).toMatchObject({
                maximumObservedQueueDepth:
                    qualificationEventLimits.maximumSubscriberQueueEvents,
                maximumObservedQueuedPayloadBytes:
                    qualificationEventLimits.maximumSubscriberQueuedPayloadBytes,
            });

            await client.close();
            client = undefined;
            await waitFor(
                () =>
                    release.server.pendingRequests === 0 &&
                    proxy.server.pendingRequests === 0,
                2000
            );
        } finally {
            await cleanup.dispose();
        }
    }, 15_000);
});
