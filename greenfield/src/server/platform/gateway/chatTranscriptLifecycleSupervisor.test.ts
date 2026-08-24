/* oxlint-disable typescript/require-await -- Async doubles mirror durable lifecycle ports. */
import { describe, expect, test } from "bun:test";

import { createChatTranscriptLifecycleCoordinator } from "../../domains/chat/transcriptLifecycle.ts";
import { createChatTranscriptLifecycleSupervisor } from "./chatTranscriptLifecycleSupervisor.ts";
import type { PersistentGatewayListener } from "./persistentGatewayTransport.ts";

async function flush(): Promise<void> {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

describe("chat transcript lifecycle supervisor", () => {
    test("coalesces lossy boundaries while preserving exact lifecycle events", async () => {
        const boundaries: number[] = [];
        const lifecycleEvents: string[] = [];
        const lifecycle = createChatTranscriptLifecycleCoordinator({
            beginTranscriptControl: async () => {},
            failTranscriptControl: async () => {},
            listReconcilingTranscripts: () => [],
            markTranscriptTransportBoundary: async (occurredAtMs) => {
                boundaries.push(occurredAtMs ?? -1);
                return [];
            },
            observeTranscriptLifecycleEvent: async (event) => {
                lifecycleEvents.push(`${event.reason}:${event.sessionKey ?? "all"}`);
                return [];
            },
            observeTranscriptSnapshot: async () => [],
            readTranscriptState: (sessionKey) => ({
                currentGeneration: 1,
                sessionKey,
                status: "ready",
            }),
            reconcileTranscript: async () => [],
            settleUnchangedTranscriptControl: async () => {},
        });
        let listener: PersistentGatewayListener | undefined;
        let unsubscribed = 0;
        let nowMs = 1800;
        const supervisor = createChatTranscriptLifecycleSupervisor({
            lifecycle,
            nowMs: () => nowMs,
            transport: {
                subscribe(next) {
                    listener = next;
                    return () => {
                        unsubscribed += 1;
                    };
                },
            },
        });
        await supervisor.ready;
        nowMs = 2000;

        listener!.onState?.({
            connectionGeneration: 1,
            phase: "connected",
            reconnectAttempt: 0,
        });
        listener!.onEvent?.({
            connectionGeneration: 1,
            frame: {
                event: "sessions.changed",
                sessionLifecycle: {
                    occurredAtMs: 1900,
                    reason: "reset",
                    sessionId: "provider-session",
                    sessionKey: "agent:main:main",
                    updatedAtMs: 1900,
                },
                type: "event",
            },
            receivedAtMs: 1901,
        });
        listener!.onEvent?.({
            connectionGeneration: 1,
            frame: { event: "sessions.changed", type: "event" },
            receivedAtMs: 1950,
        });
        listener!.onEventGap?.({
            connectionGeneration: 1,
            expectedSequence: 4,
            receivedSequence: 6,
        });
        listener!.onState?.({
            connectionGeneration: 1,
            phase: "connecting",
            reconnectAttempt: 1,
        });
        await flush();

        expect(lifecycleEvents).toEqual(["reset:agent:main:main"]);
        expect(boundaries).toEqual([1800, 1950]);

        nowMs = 2100;
        listener!.onState?.({
            connectionGeneration: 2,
            phase: "connected",
            reconnectAttempt: 0,
        });
        await flush();
        expect(boundaries).toEqual([1800, 1950, 2100]);

        await supervisor.stop();
        expect(unsubscribed).toBe(1);
        listener!.onEventGap?.({
            connectionGeneration: 2,
            expectedSequence: 7,
            receivedSequence: 9,
        });
        await flush();
        expect(boundaries).toEqual([1800, 1950, 2100]);
    });

    test("reports startup bridge failures, schedules reconciliation, and clears it on stop", async () => {
        const failure = new Error("durable lifecycle unavailable");
        const failures: unknown[] = [];
        let retryCallback: (() => void) | undefined;
        let retryDelayMs: number | undefined;
        let clearedHandle: unknown;
        const retryHandle = Object.freeze({ retry: true });
        const lifecycle = createChatTranscriptLifecycleCoordinator({
            beginTranscriptControl: async () => {},
            failTranscriptControl: async () => {},
            listReconcilingTranscripts: () => [],
            markTranscriptTransportBoundary: async () => {
                throw failure;
            },
            observeTranscriptLifecycleEvent: async () => [],
            observeTranscriptSnapshot: async () => [],
            readTranscriptState: (sessionKey) => ({
                currentGeneration: 1,
                sessionKey,
                status: "ready",
            }),
            reconcileTranscript: async () => [],
            settleUnchangedTranscriptControl: async () => {},
        });
        const supervisor = createChatTranscriptLifecycleSupervisor({
            lifecycle,
            onFailure: (error) => failures.push(error),
            retryDelayMs: 25,
            scheduler: {
                clearTimeout(handle) {
                    clearedHandle = handle;
                },
                setTimeout(callback, delayMs) {
                    retryCallback = callback;
                    retryDelayMs = delayMs;
                    return retryHandle;
                },
            },
            transport: {
                subscribe() {
                    return () => {};
                },
            },
        });

        let rejected: unknown;
        try {
            await supervisor.ready;
        } catch (error: unknown) {
            rejected = error;
        }
        expect(rejected).toBe(failure);
        expect(failures).toEqual([failure]);
        expect(retryCallback).toBeFunction();
        expect(retryDelayMs).toBe(25);
        await supervisor.stop();
        expect(clearedHandle).toBe(retryHandle);
    });

    test("retries a failed runtime lifecycle event as a conservative transport boundary", async () => {
        const failure = new Error("durable lifecycle unavailable");
        const failures: unknown[] = [];
        let boundaryCount = 0;
        let lifecycleCount = 0;
        let retryCallback: (() => void) | undefined;
        const lifecycle = createChatTranscriptLifecycleCoordinator({
            beginTranscriptControl: async () => {},
            failTranscriptControl: async () => {},
            listReconcilingTranscripts: () => [],
            markTranscriptTransportBoundary: async () => {
                boundaryCount += 1;
                return [];
            },
            observeTranscriptLifecycleEvent: async () => {
                lifecycleCount += 1;
                throw failure;
            },
            observeTranscriptSnapshot: async () => [],
            readTranscriptState: (sessionKey) => ({
                currentGeneration: 1,
                sessionKey,
                status: "ready",
            }),
            reconcileTranscript: async () => [],
            settleUnchangedTranscriptControl: async () => {},
        });
        let listener: PersistentGatewayListener | undefined;
        const supervisor = createChatTranscriptLifecycleSupervisor({
            lifecycle,
            onFailure: (error) => failures.push(error),
            retryDelayMs: 25,
            scheduler: {
                clearTimeout() {},
                setTimeout(callback) {
                    retryCallback = callback;
                    return Object.freeze({ retry: true });
                },
            },
            transport: {
                subscribe(next) {
                    listener = next;
                    return () => {};
                },
            },
        });
        await supervisor.ready;

        listener!.onEvent?.({
            connectionGeneration: 1,
            frame: {
                event: "sessions.changed",
                sessionLifecycle: {
                    occurredAtMs: 1900,
                    reason: "reset",
                    sessionId: "provider-session",
                    sessionKey: "agent:main:main",
                    updatedAtMs: 1900,
                },
                type: "event",
            },
            receivedAtMs: 1901,
        });
        await flush();

        expect(lifecycleCount).toBe(1);
        expect(failures).toEqual([failure]);
        expect(retryCallback).toBeFunction();
        retryCallback!();
        await flush();
        expect(boundaryCount).toBe(2);
        await supervisor.stop();
    });
});
