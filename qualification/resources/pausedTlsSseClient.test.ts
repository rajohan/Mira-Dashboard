import { describe, expect, test } from "bun:test";

import { Effect, Exit, Fiber, Result, Scope } from "effect";
import { TestClock } from "effect/testing";

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
    openPausedTlsSseClient,
    PausedTlsSseClientArgumentError,
    PausedTlsSseClientDeadlineError,
    PausedTlsSseClientOperationError,
    pausedTlsSseClientResource,
    withPausedTlsSseClientDeadline,
} from "./pausedTlsSseClient.ts";
import { sseMemoryQualificationPolicy } from "./resourcePolicy.ts";

const qualificationCookie = "mira_qualification=paused-native-client";
const connectedFrame = Buffer.from("event: connected\ndata: {}\n\n", "ascii");

function createPausedClientReadBoundary(clientPaused: Promise<void>) {
    const boundaryHeld = Promise.withResolvers<void>();
    const releaseBoundary = Promise.withResolvers<void>();
    let bodyPrefix = Buffer.alloc(0);
    let holding = false;

    return {
        boundaryHeld: boundaryHeld.promise,
        holdAfterChunk: async (chunk: Uint8Array): Promise<void> => {
            if (holding) return;
            const remainingBytes = connectedFrame.byteLength - bodyPrefix.byteLength;
            bodyPrefix = Buffer.concat(
                [bodyPrefix, chunk.subarray(0, Math.max(remainingBytes, 0))],
                Math.min(
                    bodyPrefix.byteLength + chunk.byteLength,
                    connectedFrame.byteLength
                )
            );
            if (!bodyPrefix.equals(connectedFrame)) return;

            holding = true;
            await clientPaused;
            boundaryHeld.resolve();
            await releaseBoundary.promise;
        },
        release: (): void => {
            releaseBoundary.resolve();
        },
    };
}

describe("paused native TLS SSE client", () => {
    test("rejects CR and LF in the raw cookie header", async () => {
        for (const invalidCookie of [
            `${qualificationCookie}\rInjected: true`,
            `${qualificationCookie}\nInjected: true`,
        ]) {
            const failure = await openPausedTlsSseClient(
                new URL("https://127.0.0.1:1"),
                "unused certificate authority",
                invalidCookie,
                1
            ).then(
                () => null,
                (error: unknown) => error
            );

            if (!(failure instanceof Error)) {
                throw new Error("Expected the invalid cookie to be rejected");
            }
            expect(failure).toBeInstanceOf(PausedTlsSseClientArgumentError);
            expect(failure.message).toContain("cookie must not contain CR or LF");
        }
    });

    test("tags a native connection failure", async () => {
        const tlsIdentity = await createTestTlsIdentity();
        const listener = Bun.listen({
            data: undefined,
            hostname: "127.0.0.1",
            port: 0,
            socket: {
                data() {},
            },
        });
        const closedPort = listener.port;
        listener.stop(true);

        try {
            const failure = await openPausedTlsSseClient(
                new URL(`https://127.0.0.1:${closedPort}`),
                tlsIdentity.certificate,
                qualificationCookie,
                1000
            ).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(PausedTlsSseClientOperationError);
            expect(failure).toMatchObject({ operation: "connect" });
        } finally {
            await tlsIdentity.dispose();
        }
    });

    test("interrupts pending Effect work when its deadline expires", async () => {
        let interrupted = false;
        const pending = Effect.callback<void>(() =>
            Effect.sync(() => {
                interrupted = true;
            })
        );
        const program = Effect.gen(function* () {
            const fiber = yield* withPausedTlsSseClientDeadline(
                pending,
                "connect",
                25
            ).pipe(Effect.result, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(25);
            yield* Effect.yieldNow;
            return yield* Fiber.join(fiber);
        });
        const outcome = await Effect.runPromise(
            Effect.provide(program, TestClock.layer())
        );

        expect(interrupted).toBe(true);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isSuccess(outcome)) return;
        expect(outcome.failure).toBeInstanceOf(PausedTlsSseClientDeadlineError);
        expect(outcome.failure).toMatchObject({
            message: "Paused SSE client did not connect within 25 ms",
            operation: "connect",
            timeoutMs: 25,
        });
    });

    test("propagates a paused TLS receive window to the bounded event queue", async () => {
        const cleanup = new AsyncCleanupStack();

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
            const clientPaused = Promise.withResolvers<void>();
            const readBoundary = createPausedClientReadBoundary(clientPaused.promise);
            const proxy = startHttpsReverseProxy({
                certificate: tlsIdentity.certificate,
                privateKey: tlsIdentity.privateKey,
                responseBodyChunkBoundary: readBoundary.holdAfterChunk,
                target: new URL(`http://127.0.0.1:${release.port}`),
            });
            cleanup.defer("paused client proxy", () => proxy.stop(true));
            cleanup.defer("paused client read boundary", () => readBoundary.release());
            const clientScope = await Effect.runPromise(Scope.make());
            cleanup.defer("paused native client scope", () =>
                Effect.runPromise(Scope.close(clientScope, Exit.void))
            );
            const pendingClient = Effect.runPromise(
                Scope.provide(clientScope)(
                    pausedTlsSseClientResource(
                        proxy.url,
                        tlsIdentity.certificate,
                        qualificationCookie,
                        2000
                    )
                )
            );
            void pendingClient.then(
                () => clientPaused.resolve(),
                (error: unknown) => clientPaused.reject(error)
            );
            await pendingClient;
            await readBoundary.boundaryHeld;
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

            await Effect.runPromise(Scope.close(clientScope, Exit.void));
            readBoundary.release();
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
