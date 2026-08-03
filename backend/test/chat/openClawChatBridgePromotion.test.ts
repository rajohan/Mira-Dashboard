import { describe, expect, it } from "bun:test";

import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat/transport.ts";
import { OpenClawChatBridge } from "../../src/services/chat/openClawChatBridge.ts";
import type { OpenClawChatSnapshotStore } from "../../src/services/chat/openClawChatPersistence.ts";
const MAIN = "agent:main:main";
class MemorySnapshotStore implements OpenClawChatSnapshotStore {
    readonly loadedKeys: string[] = [];
    readonly snapshots = new Map<string, OpenClawRuntimeSnapshot>();
    clearFailures = 0;
    deleteFailures = 0;
    keysCount = 0;
    keysFailures = 0;
    loadFailures = 0;
    maximumSequenceFailures = 0;
    saveCount = 0;
    saveFailures = 0;
    clear(): void {
        if (this.clearFailures > 0) {
            this.clearFailures -= 1;
            throw new Error("clear failed");
        }
        this.snapshots.clear();
    }
    delete(sessionKey: string): void {
        if (this.deleteFailures > 0) {
            this.deleteFailures -= 1;
            throw new Error("delete failed");
        }
        this.snapshots.delete(sessionKey);
    }
    keys(): string[] {
        this.keysCount += 1;
        if (this.keysFailures > 0) {
            this.keysFailures -= 1;
            throw new Error("keys failed");
        }
        return this.snapshots.keys().toArray();
    }
    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined {
        this.loadedKeys.push(sessionKey);
        if (this.loadFailures > 0) {
            this.loadFailures -= 1;
            throw new Error("load failed");
        }
        const snapshot = this.snapshots.get(sessionKey);
        return snapshot ? structuredClone(snapshot) : undefined;
    }
    maximumSequence(): number {
        if (this.maximumSequenceFailures > 0) {
            this.maximumSequenceFailures -= 1;
            throw new Error("maximum sequence failed");
        }
        let maximumSequence = 0;
        for (const snapshot of this.snapshots.values()) {
            if (
                Number.isSafeInteger(snapshot.throughSequence) &&
                snapshot.throughSequence >= 0
            ) {
                maximumSequence = Math.max(maximumSequence, snapshot.throughSequence);
            }
        }
        return maximumSequence;
    }
    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): void {
        this.saveCount += 1;
        if (this.saveFailures > 0) {
            this.saveFailures -= 1;
            throw new Error("save failed");
        }
        if (this.deleteFailures > 0) {
            this.deleteFailures -= 1;
            throw new Error("delete failed");
        }
        const nextSourceSnapshot =
            sourceSnapshot.events.length > 0
                ? structuredClone(sourceSnapshot)
                : undefined;
        const nextCanonicalSnapshot =
            canonicalSnapshot.events.length > 0
                ? structuredClone(canonicalSnapshot)
                : undefined;
        if (nextSourceSnapshot) {
            this.snapshots.set(sourceSessionKey, nextSourceSnapshot);
        } else {
            this.snapshots.delete(sourceSessionKey);
        }
        if (nextCanonicalSnapshot) {
            this.snapshots.set(canonicalSessionKey, nextCanonicalSnapshot);
        } else {
            this.snapshots.delete(canonicalSessionKey);
        }
    }
    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void {
        this.saveCount += 1;
        if (this.saveFailures > 0) {
            this.saveFailures -= 1;
            throw new Error("save failed");
        }
        this.snapshots.set(sessionKey, structuredClone(snapshot));
    }
}
function payloads(bridge: OpenClawChatBridge, sessionKey = MAIN) {
    return bridge
        .snapshot(sessionKey)
        .events.map((event) => event.payload as Record<string, unknown>);
}
function runtimeEnvelope(
    runtimeSequence: number,
    event: string,
    payload: Record<string, unknown>,
    runtimeRecordedAt: number
) {
    return withCanonicalOpenClawEvents({
        event,
        payload,
        runtimeRecordedAt,
        runtimeSequence,
        type: "event" as const,
    });
}
describe("OpenClaw chat bridge run promotion", () => {
    it("promotes a short-key idempotency replay before the session index loads", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "older canonical answer",
                runId: "older-canonical-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "early notification",
                runId: "tasks-notify-early",
                sessionKey: "main",
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "unrelated quarantined answer",
                runId: "unrelated-short-run",
                sessionKey: "main",
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "tasks-notify-early",
                message: "notify",
                sessionKey: MAIN,
            },
            {
                runId: "provider-notify-early",
            }
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "early notification",
                runId: "provider-notify-early",
                sessionKey: MAIN,
            }),
        ]);
        expect(payloads(bridge, "main")).toEqual([
            expect.objectContaining({
                message: "unrelated quarantined answer",
                runId: "unrelated-short-run",
                sessionKey: "main",
            }),
        ]);
    });
    it("promotes a completed runless turn emitted after the send started", () => {
        const bridge = new OpenClawChatBridge();
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.recordEvent(
            "chat",
            {
                message: "fast runless answer",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-runless",
                message: "fast question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-runless-final",
            },
            requestBoundary
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        message: "fast runless answer",
                        runId: "provider-runless-final",
                    }),
                }),
            ],
        });
    });
    it("hydrates persisted replay before capturing a new send boundary", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(MAIN, {
            completed: true,
            events: [
                runtimeEnvelope(
                    7,
                    "chat",
                    {
                        message: "persisted old answer",
                        sessionKey: MAIN,
                        state: "final",
                    },
                    Date.now() - 1000
                ),
            ],
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 7,
        });
        const bridge = new OpenClawChatBridge(store);
        const requestBoundary = bridge.captureRequestBoundary(MAIN);
        bridge.recordEvent(
            "chat",
            {
                message: "new answer",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-new",
                message: "new question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-new",
            },
            requestBoundary
        );
        expect(requestBoundary).toBe(7);
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "new answer",
                runId: "provider-new",
            }),
        ]);
    });
    it("promotes a completed runless turn without a provider run id", () => {
        const withoutProvider = new OpenClawChatBridge();
        const withoutProviderBoundary = withoutProvider.captureRequestBoundary();
        withoutProvider.recordEvent(
            "chat",
            {
                message: "runless answer without provider id",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        withoutProvider.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-runless-only",
                message: "fast question",
                sessionKey: MAIN,
            },
            {},
            withoutProviderBoundary
        );
        expect(payloads(withoutProvider)).toEqual([
            expect.objectContaining({
                runId: "dashboard-chat-runless-only",
                state: "final",
            }),
        ]);
        expect(
            withoutProvider.recordEvent(
                "agent",
                {
                    runId: "dashboard-chat-runless-only",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            sessionKey: MAIN,
        });
    });
    it("does not promote a completed runless turn from before the send", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "stale runless answer",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-new",
                message: "new question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-new",
            },
            requestBoundary
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
    });
    it("retains a matching completed provisional run without a provider id", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "fast answer",
                runId: "dashboard-chat-without-provider",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-without-provider",
                message: "fast question",
                sessionKey: MAIN,
            },
            {}
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "fast answer",
                runId: "dashboard-chat-without-provider",
                state: "final",
            }),
        ]);
    });
    it("rewrites runless replay payloads on promotion", () => {
        const runlessBridge = new OpenClawChatBridge();
        runlessBridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "runless",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        runlessBridge.handleSuccessfulRequest(
            "chat.send",
            {
                message: "question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-runless",
            }
        );
        expect(payloads(runlessBridge)).toEqual([
            expect.objectContaining({
                runId: "provider-runless",
            }),
        ]);
    });
    it("keeps an explicit provider replay separate until send acknowledgement", () => {
        const activeBridge = new OpenClawChatBridge();
        activeBridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "provisional",
                },
                runId: "dashboard-chat-active",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        activeBridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "provider",
                },
                runId: "provider-active",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(payloads(activeBridge).map((payload) => payload.runId)).toEqual([
            "dashboard-chat-active",
            "provider-active",
        ]);
        activeBridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-active",
                message: "question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-active",
            }
        );
        expect(payloads(activeBridge).map((payload) => payload.runId)).toEqual([
            "provider-active",
            "provider-active",
        ]);
    });
    it("promotes a grouped runless stream beside parallel concrete runs", () => {
        const bridge = new OpenClawChatBridge();
        for (const runId of ["parallel-a", "parallel-b"]) {
            bridge.recordEvent(
                "agent",
                {
                    runId,
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
        }
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "first",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "second",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                runId: "provider-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-grouped",
                message: "question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-run",
            },
            requestBoundary
        );
        expect(payloads(bridge).map((payload) => payload.runId)).toEqual([
            "parallel-a",
            "parallel-b",
            "provider-run",
            "provider-run",
            "provider-run",
        ]);
    });
    it("merges a completed provisional replay into an existing provider run", () => {
        const mergedBridge = new OpenClawChatBridge();
        mergedBridge.recordEvent(
            "chat",
            {
                message: "fast answer",
                runId: "dashboard-chat-completed",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        mergedBridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "provider tail",
                },
                runId: "provider-completed",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        mergedBridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-completed",
                message: "fast question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-completed",
            }
        );
        expect(mergedBridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: "provider-completed",
                        state: "final",
                    }),
                }),
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: "provider-completed",
                        stream: "thinking",
                    }),
                }),
            ],
        });
    });
    it("does not promote a stale completed provisional run into a new send", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "old answer",
                runId: "dashboard-chat-old",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-new",
                message: "new question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-new",
            }
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "provider-new",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            runId: "provider-new",
            sessionKey: MAIN,
        });
    });
    it("keeps a new unscoped turn separate from an older runless completion", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "old answer",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "new reasoning",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-new",
                message: "new question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-new",
            },
            requestBoundary
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: {
                    delta: "new reasoning",
                },
                runId: "provider-new",
            }),
        ]);
    });
    it("retains a nested unscoped assistant session echo with its completed final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: {
                    content: [
                        {
                            text: "done",
                            type: "text",
                        },
                    ],
                    role: "assistant",
                },
                runId: "completed-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                data: {
                    content: "done",
                    role: "assistant",
                    sessionKey: MAIN,
                },
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "chat",
                }),
                expect.objectContaining({
                    event: "session.message",
                }),
            ],
        });
    });
    it("treats only Synthetic stop session messages as terminal", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: [
                        {
                            thinking: "inspect repository",
                            type: "thinking",
                        },
                        {
                            arguments: {
                                command: "pwd",
                            },
                            id: "functions.exec:0",
                            name: "exec",
                            type: "toolCall",
                        },
                    ],
                    role: "assistant",
                    stopReason: "toolUse",
                },
                runId: "synthetic-run",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN).completed).toBe(false);
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: [
                        {
                            thinking: "report result",
                            type: "thinking",
                        },
                        {
                            text: "SYNTHETIC_OK",
                            type: "text",
                        },
                    ],
                    role: "assistant",
                    stopReason: "stop",
                },
                runId: "synthetic-run",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: "synthetic-run",
                    }),
                }),
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: "synthetic-run",
                    }),
                }),
            ],
        });
    });
    it("retains a Synthetic stop marker when the final payload is oversized", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: "x".repeat(1_000_001),
                    role: "assistant",
                    stopReason: "stop",
                },
                runId: "large-synthetic-run",
                sessionKey: MAIN,
            },
            []
        );
        const compactMessage = expect.objectContaining({
            role: "assistant",
            stopReason: "stop",
        });
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    canonicalEvents: [
                        expect.objectContaining({
                            kind: "finish",
                            lifecycle: "completed",
                            message: undefined,
                            outcome: "completed",
                        }),
                    ],
                    event: "session.message",
                    payload: expect.objectContaining({
                        message: compactMessage,
                        runId: "large-synthetic-run",
                        sessionKey: MAIN,
                    }),
                }),
            ],
        });
    });
    it("promotes a completed runless Synthetic turn when its run id arrives", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "session.message",
            {
                content: "question",
                role: "user",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: "SYNTHETIC_OK",
                    role: "assistant",
                    stopReason: "stop",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "model.completed",
            {
                runId: "synthetic-provider-run",
                sessionKey: MAIN,
                status: "completed",
            },
            []
        );
        expect(bridge.clearMemory()).toBe(true);
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "session.message",
            "session.message",
            "model.completed",
        ]);
        expect(
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual([
            "synthetic-provider-run",
            "synthetic-provider-run",
            "synthetic-provider-run",
        ]);
    });
    it("promotes a completed runless Synthetic turn across global sequence gaps", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "session.message",
            {
                content: "question",
                role: "user",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: "SYNTHETIC_OK",
                    role: "assistant",
                    stopReason: "stop",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.ended",
            {
                status: "completed",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                content: "unrelated session work",
                role: "user",
                sessionKey: "agent:other:main",
            },
            []
        );
        bridge.recordEvent(
            "model.completed",
            {
                runId: "synthetic-provider-run",
                sessionKey: MAIN,
                status: "completed",
            },
            []
        );
        expect(bridge.clearMemory()).toBe(true);
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "session.message",
            "session.message",
            "model.completed",
        ]);
        expect(
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual([
            "synthetic-provider-run",
            "synthetic-provider-run",
            "synthetic-provider-run",
        ]);
    });
    it("promotes a runless user session message when provider work starts", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.message",
            {
                content: "message from another client",
                role: "user",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "provider answer",
                runId: "provider-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0]).toMatchObject({
            event: "session.message",
            payload: {
                runId: "provider-run",
            },
        });
        expect(snapshot.events[1]).toMatchObject({
            event: "chat",
            payload: {
                runId: "provider-run",
            },
        });
    });
    it("promotes a nested runless user session message when provider work starts", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.message",
            {
                data: {
                    message: "nested message from another client",
                    role: "user",
                    sessionKey: MAIN,
                },
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "provider answer",
                runId: "nested-provider-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0]).toMatchObject({
            event: "session.message",
            payload: {
                runId: "nested-provider-run",
            },
        });
        expect(snapshot.events[1]).toMatchObject({
            event: "chat",
            payload: {
                runId: "nested-provider-run",
            },
        });
    });
    it("does not attach a session message to an older matching final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "OK",
                runId: "older-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    error: "new failure",
                    phase: "error",
                },
                runId: "newer-run",
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                content: "OK",
                role: "assistant",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    event: "session.message",
                }),
            ],
        });
    });
    it("keeps a late session echo out of an active follow-up", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "OK",
                runId: "completed-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "new work",
                },
                runId: "active-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                content: "OK",
                role: "assistant",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN).events.map((event) => event.event)).toEqual([
            "agent",
        ]);
    });
    it("does not promote stale active provisional work into a later send", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "old work",
                },
                runId: "dashboard-chat-old",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-new",
                message: "new question",
                sessionKey: MAIN,
            },
            {
                runId: "provider-new",
            },
            requestBoundary
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                runId: "dashboard-chat-old",
            }),
        ]);
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "provider-new",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            runId: "provider-new",
            sessionKey: MAIN,
        });
    });
    it("prefers newer runless work over an older concrete final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "old answer",
                runId: "old-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "new reasoning",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    error: "new failure",
                    phase: "error",
                },
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.events.map((event) => event.event)).toEqual(["agent", "agent"]);
        expect(payloads(bridge).at(-1)).toMatchObject({
            data: {
                error: "new failure",
                phase: "error",
            },
            stream: "lifecycle",
        });
    });
    it("does not classify a runless terminal failure as metadata", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "old answer",
                runId: "old-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.ended",
            {
                data: {
                    phase: "error",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                event: "session.ended",
                payload: expect.objectContaining({
                    data: {
                        phase: "error",
                    },
                }),
            }),
        ]);
    });
    it("treats lifecycle end events as completed replay runs", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                phase: "end",
                runId: "lifecycle-run",
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "agent",
                }),
            ],
        });
    });
    it("learns a run association from explicitly scoped runtime events", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                runId: "external-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "external-run",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            runId: "external-run",
            sessionKey: MAIN,
        });
    });
    it("learns explicit associations even when the scoped payload is too large to retain", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "x".repeat(1_000_001),
                },
                runId: "large-external-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "large-external-run",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            runId: "large-external-run",
            sessionKey: MAIN,
        });
    });
    it("retains multi-thousand-event runs and drops oversized individual payloads", () => {
        const bridge = new OpenClawChatBridge();
        for (let index = 0; index < 4400; index += 1) {
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: String(index),
                    },
                    runId: "bounded-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
        }
        expect(bridge.snapshot(MAIN).events).toHaveLength(4400);
        bridge.clear();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "x".repeat(1_000_001),
                },
                runId: "large-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        bridge.recordEvent(
            "chat",
            {
                message: "x".repeat(1_000_001),
                runId: "large-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                runId: "large-run",
                sessionKey: MAIN,
                state: "final",
            }),
        ]);
        bridge.clear();
        bridge.recordEvent(
            "chat",
            {
                data: {
                    message: "x".repeat(1_000_001),
                    runId: "nested-large-run",
                    sessionKey: MAIN,
                    state: "final",
                },
            },
            []
        );
        const nestedFinalSnapshot = bridge.snapshot(MAIN);
        expect(nestedFinalSnapshot.completed).toBe(true);
        expect(nestedFinalSnapshot.events).toHaveLength(1);
        expect(nestedFinalSnapshot.events[0]?.payload).toMatchObject({
            data: {
                state: "final",
            },
            runId: "nested-large-run",
            sessionKey: MAIN,
            state: "final",
        });
        bridge.clear();
        bridge.recordEvent(
            "session.ended",
            {
                data: {
                    detail: "x".repeat(1_000_001),
                    status: "aborted",
                },
                runId: "large-aborted-run",
                sessionKey: MAIN,
            },
            []
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "aborted",
                }),
                runId: "large-aborted-run",
                sessionKey: MAIN,
            }),
        ]);
        bridge.clear();
        bridge.recordEvent(
            "session.compaction",
            {
                data: {
                    detail: "x".repeat(1_000_001),
                },
                operation: "compact",
                operationId: "large-compaction",
                phase: "end",
                sessionKey: MAIN,
            },
            []
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                operation: "compact",
                operationId: "large-compaction",
                phase: "end",
                sessionKey: MAIN,
            }),
        ]);
        const oversizedSessionKey = "s".repeat(1_000_001);
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "terminal-run",
                sessionKey: oversizedSessionKey,
                state: "final",
            },
            []
        );
        expect(bridge.snapshot(oversizedSessionKey).events).toEqual([]);
    });
});
