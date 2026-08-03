import { describe, expect, it, jest } from "bun:test";

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
describe("OpenClaw chat bridge identity", () => {
    it("keeps the latest full thinking snapshot after a run completes", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            {
                runId: "completed-run",
                sessionKey: MAIN,
            },
            []
        );
        for (const progressText of ["First", "First and second"]) {
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        itemId: "preamble-1",
                        kind: "preamble",
                        phase: "update",
                        progressText,
                    },
                    runId: "completed-run",
                    sessionKey: MAIN,
                    stream: "item",
                },
                []
            );
        }
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "completed-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "session.started",
            "agent",
            "chat",
        ]);
        expect(snapshot.events[1]?.payload).toMatchObject({
            data: {
                progressText: "First and second",
            },
        });
    });
    it("sequences, enriches and quarantines ambiguous run associations", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: MAIN,
            },
            {
                runId: "shared-run",
            }
        );
        const first = bridge.recordEvent(
            "agent",
            {
                runId: "shared-run",
                stream: "thinking",
            },
            []
        );
        expect(first).toMatchObject({
            payload: {
                runId: "shared-run",
                sessionKey: MAIN,
            },
            runtimeSequence: 1,
        });
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: "agent:other:main",
            },
            {
                runId: "shared-run",
            }
        );
        const ambiguous = bridge.recordEvent(
            "agent",
            {
                runId: "shared-run",
                stream: "thinking",
            },
            []
        );
        expect(ambiguous.payload).not.toHaveProperty("sessionKey");
        expect(bridge.snapshot(MAIN).events).toHaveLength(1);
        expect(bridge.snapshot("agent:other:main").events).toHaveLength(0);
        bridge.clearSession("agent:other:main");
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "shared-run",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            runId: "shared-run",
            sessionKey: MAIN,
        });
    });
    it("keeps live sequence numbers monotonic when replay state is cleared", () => {
        const bridge = new OpenClawChatBridge();
        const first = bridge.recordEvent(
            "agent",
            {
                runId: "first",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.clear();
        const second = bridge.recordEvent(
            "agent",
            {
                runId: "second",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(first.runtimeSequence).toBe(1);
        expect(second.runtimeSequence).toBe(2);
    });
    it("treats duplicate run ids in the provider session index as ambiguous", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "shared-run",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: MAIN,
                    runId: "shared-run",
                },
                {
                    id: "other",
                    key: "agent:other:main",
                    runId: "shared-run",
                },
            ]
        );
        expect(event.payload).not.toHaveProperty("sessionKey");
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(bridge.snapshot("agent:other:main").events).toEqual([]);
    });
    it("normalizes an unambiguous provider session alias before retaining it", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "short-session-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: MAIN,
                },
            ]
        );
        expect(event.payload).toMatchObject({
            runId: "short-session-run",
            sessionKey: MAIN,
        });
        expect(bridge.snapshot(MAIN).events).toEqual([event]);
        expect(bridge.snapshot("main").events).toEqual([]);
    });
    it("quarantines a short session key until the provider index can resolve it", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "chat",
            {
                message: "early answer",
                runId: "early-run",
                sessionKey: "main",
                state: "final",
            },
            []
        );
        expect(event.payload).toMatchObject({
            sessionKey: "main",
        });
        expect(bridge.snapshot("main").events).toEqual([event]);
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        expect(bridge.snapshot("main").events).toEqual([]);
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "early answer",
                runId: "early-run",
                sessionKey: MAIN,
            }),
        ]);
        const clearedBridge = new OpenClawChatBridge();
        clearedBridge.recordEvent(
            "agent",
            {
                runId: "clear-run",
                sessionKey: "main",
                stream: "thinking",
            },
            []
        );
        clearedBridge.clearSession(MAIN);
        expect(clearedBridge.snapshot("main").events).toEqual([]);
    });
    it("moves a deferred compaction settlement timer with its canonical session", () => {
        jest.useFakeTimers();
        try {
            const deferredEnvelopes: unknown[] = [];
            const bridge = new OpenClawChatBridge(undefined, {
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: "working",
                    },
                    runId: "parent-run",
                    sessionKey: "main",
                    stream: "thinking",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    phase: "end",
                    runId: "parent-run",
                    sessionKey: "main",
                    stream: "compaction",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        phase: "end",
                        stream: "lifecycle",
                    },
                    sessionKey: "main",
                },
                []
            );
            bridge.reconcileSessions([
                {
                    id: "main",
                    key: MAIN,
                },
            ]);
            jest.advanceTimersByTime(30);
            expect(deferredEnvelopes).toHaveLength(1);
            expect(deferredEnvelopes[0]).toMatchObject({
                event: "model.completed",
                payload: {
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
            });
            expect(bridge.snapshot(MAIN).completed).toBe(true);
            expect(bridge.snapshot("main").events).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("moves a deferred compaction settlement timer to the provider run", () => {
        jest.useFakeTimers();
        try {
            const deferredEnvelopes: unknown[] = [];
            const provisionalRunId = "dashboard-chat-compaction";
            const providerRunId = "provider-compaction";
            const bridge = new OpenClawChatBridge(undefined, {
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: "working",
                    },
                    runId: provisionalRunId,
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    phase: "end",
                    runId: provisionalRunId,
                    sessionKey: MAIN,
                    stream: "compaction",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        phase: "end",
                        stream: "lifecycle",
                    },
                    sessionKey: MAIN,
                },
                []
            );
            bridge.handleSuccessfulRequest(
                "chat.send",
                {
                    idempotencyKey: provisionalRunId,
                    sessionKey: MAIN,
                },
                {
                    runId: providerRunId,
                }
            );
            jest.advanceTimersByTime(30);
            expect(deferredEnvelopes).toHaveLength(1);
            expect(deferredEnvelopes[0]).toMatchObject({
                event: "model.completed",
                payload: {
                    runId: providerRunId,
                    sessionKey: MAIN,
                },
            });
            expect(bridge.snapshot(MAIN).completed).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
    it("cancels a deferred compaction settlement timer when memory is cleared", () => {
        jest.useFakeTimers();
        try {
            const deferredEnvelopes: unknown[] = [];
            const bridge = new OpenClawChatBridge(undefined, {
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: "working",
                    },
                    runId: "parent-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    phase: "end",
                    runId: "parent-run",
                    sessionKey: MAIN,
                    stream: "compaction",
                },
                []
            );
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        phase: "end",
                        stream: "lifecycle",
                    },
                    sessionKey: MAIN,
                },
                []
            );
            expect(bridge.clearMemory()).toBe(true);
            jest.advanceTimersByTime(30);
            expect(deferredEnvelopes).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("merges quarantined and canonical replay for the same run", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "early",
                },
                runId: "shared-alias-run",
                sessionKey: "main",
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "shared-alias-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: {
                    delta: "early",
                },
                runId: "shared-alias-run",
                sessionKey: MAIN,
            }),
            expect.objectContaining({
                message: "done",
                runId: "shared-alias-run",
                sessionKey: MAIN,
            }),
        ]);
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "shared-alias-run",
                },
                []
            ).payload
        ).toMatchObject({
            sessionKey: MAIN,
        });
    });
    it("keeps conflicting index and run associations quarantined", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: MAIN,
            },
            {
                runId: "conflicting-run",
            }
        );
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "conflicting-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: "agent:other:main",
                },
            ]
        );
        expect(event.payload).not.toHaveProperty("sessionKey");
    });
    it("reconciles quarantined runs only when index and correlation agree", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "chat",
            {
                message: "correlated answer",
                runId: "delayed-correlation-run",
                sessionKey: "main",
                state: "final",
            },
            []
        );
        const otherSessionKey = "agent:other:main";
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: otherSessionKey,
            },
            {
                runId: "delayed-correlation-run",
            }
        );
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        expect(bridge.snapshot("main").events).toEqual([event]);
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
            {
                id: "other",
                key: otherSessionKey,
            },
        ]);
        expect(bridge.snapshot("main").events).toEqual([]);
        expect(payloads(bridge, otherSessionKey)).toEqual([
            expect.objectContaining({
                message: "correlated answer",
                runId: "delayed-correlation-run",
                sessionKey: otherSessionKey,
            }),
        ]);
    });
    it("does not guess between ambiguous provider session aliases", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "ambiguous-session-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: MAIN,
                },
                {
                    id: "main",
                    key: "agent:other:main",
                },
            ]
        );
        expect(event.payload).not.toHaveProperty("sessionKey");
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(bridge.snapshot("agent:other:main").events).toEqual([]);
    });
    it("uses a run association to disambiguate a short provider session alias", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: MAIN,
            },
            {
                runId: "associated-run",
            }
        );
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "associated-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: MAIN,
                },
                {
                    id: "main",
                    key: "agent:other:main",
                },
            ]
        );
        expect(event.payload).toMatchObject({
            runId: "associated-run",
            sessionKey: MAIN,
        });
        expect(bridge.snapshot(MAIN).events).toEqual([event]);
    });
    it("does not let a stale run association override an ambiguous index", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                sessionKey: "agent:stale:main",
            },
            {
                runId: "stale-associated-run",
            }
        );
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "stale-associated-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                {
                    id: "main",
                    key: MAIN,
                },
                {
                    id: "main",
                    key: "agent:other:main",
                },
            ]
        );
        expect(event.payload).not.toHaveProperty("sessionKey");
        expect(bridge.snapshot("agent:stale:main").events).toEqual([]);
    });
    it("promotes acknowledged provisional runs and prefers a concrete final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "working",
                },
                runId: "dashboard-chat-local",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: {
                    role: "assistant",
                    text: "done",
                },
                runId: "real-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-local",
                message: "question",
                sessionKey: MAIN,
            },
            {
                runId: "real-run",
            }
        );
        bridge.recordEvent(
            "session.ended",
            {
                sessionKey: MAIN,
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual(["agent", "chat"]);
        expect(payloads(bridge).at(-1)).toMatchObject({
            runId: "real-run",
            state: "final",
        });
    });
    it("does not end an unrelated provisional run with unscoped metadata", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                runId: "dashboard-chat-local",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "external answer",
                runId: "external-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.ended",
            {
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: "dashboard-chat-local",
                    }),
                }),
            ],
        });
    });
    it("prefers an unscoped final over later runless terminal metadata", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.ended",
            {
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "chat",
                    payload: expect.objectContaining({
                        message: "done",
                    }),
                }),
            ],
        });
    });
    it("does not let repeated terminal metadata displace an unscoped final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        for (let index = 0; index < 6; index += 1) {
            bridge.recordEvent(
                "model.completed",
                {
                    sessionKey: MAIN,
                },
                []
            );
        }
        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                event: "chat",
                payload: expect.objectContaining({
                    message: "done",
                }),
            }),
        ]);
    });
    it("retains terminal metadata for newer active runless work", () => {
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
            "session.ended",
            {
                sessionKey: MAIN,
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "agent",
            "session.ended",
        ]);
    });
    it("does not assign terminal metadata backward to older runless work", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "older reasoning",
                },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "new answer",
                runId: "new-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.ended",
            {
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    event: "agent",
                }),
            ],
        });
    });
    it("persists nested runtime session identities for restart replay", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        const recorded = bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "nested reasoning",
                    runId: "nested-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
            },
            []
        );
        expect(recorded.payload).toMatchObject({
            data: {
                runId: "nested-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            runId: "nested-run",
            sessionKey: MAIN,
        });
        expect(bridge.flush()).toBe(true);
        const restarted = new OpenClawChatBridge(store);
        expect(restarted.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                {
                    event: "agent",
                    payload: {
                        data: {
                            delta: "nested reasoning",
                            runId: "nested-run",
                            sessionKey: MAIN,
                        },
                        runId: "nested-run",
                        sessionKey: MAIN,
                    },
                },
            ],
        });
    });
    it("promotes an interrupted provisional chat run when the provider resumes after restart", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-interrupted";
        const providerRunId = "provider-after-restart";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: "question",
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "before restart",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.flush()).toBe(true);
        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        restarted.recordEvent(
            "agent",
            {
                data: {
                    delta: "after restart",
                },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const snapshot = restarted.snapshot(MAIN);
        expect(snapshot.completed).toBe(false);
        expect(
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual(
            Array.from(
                {
                    length: snapshot.events.length,
                },
                () => providerRunId
            )
        );
        expect(
            snapshot.events
                .map(
                    (event) =>
                        (
                            event.payload as {
                                data?: {
                                    delta?: string;
                                };
                            }
                        ).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["before restart", "after restart"]);
    });
    it("repairs a persisted snapshot that was split across an interrupted restart", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-before-restart";
        const providerRunId = "provider-after-restart";
        const now = Date.now();
        store.snapshots.set(MAIN, {
            completed: false,
            events: [
                runtimeEnvelope(
                    1,
                    "agent",
                    {
                        data: {
                            phase: "start",
                        },
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    now - 3
                ),
                runtimeEnvelope(
                    2,
                    "agent",
                    {
                        data: {
                            delta: "before restart",
                        },
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    now - 2
                ),
                runtimeEnvelope(
                    3,
                    "agent",
                    {
                        data: {
                            phase: "start",
                        },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    now - 1
                ),
                runtimeEnvelope(
                    4,
                    "agent",
                    {
                        data: {
                            delta: "after restart",
                        },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    now
                ),
            ],
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 4,
        });
        const repairedBridge = new OpenClawChatBridge(store);
        const snapshot = repairedBridge.snapshot(MAIN);
        expect(
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual(
            Array.from(
                {
                    length: snapshot.events.length,
                },
                () => providerRunId
            )
        );
        expect(
            snapshot.events
                .map(
                    (event) =>
                        (
                            event.payload as {
                                data?: {
                                    delta?: string;
                                };
                            }
                        ).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["before restart", "after restart"]);
        expect(repairedBridge.flush()).toBe(true);
        expect(
            store.snapshots.get(MAIN)?.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual(
            Array.from(
                {
                    length: snapshot.events.length,
                },
                () => providerRunId
            )
        );
    });
    it("replaces stale replay when one session key starts a new OpenClaw session", () => {
        const store = new MemorySnapshotStore();
        const oldSessionId = "872a598d-6455-4818-9259-1657696995d3";
        const newSessionId = "8eda0fdd-c025-46f6-a36f-c0beeef25aeb";
        const oldRunId = "dashboard-chat-old-synthetic-run";
        const newRunId = "dashboard-chat-new-synthetic-run";
        const oldStartedAt = 1_784_698_986_055;
        const newStartedAt = oldStartedAt + 4_845_278;
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    startedAt: oldStartedAt,
                },
                runId: oldRunId,
                sessionId: oldSessionId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "stale thinking",
                },
                runId: oldRunId,
                sessionId: oldSessionId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.flush()).toBe(true);
        expect(bridge.clearMemory()).toBe(true);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    startedAt: newStartedAt,
                },
                runId: newRunId,
                sessionId: newSessionId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "current thinking",
                },
                runId: newRunId,
                sessionId: newSessionId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const currentSnapshot = bridge.snapshot(MAIN);
        expect(
            new Set(
                currentSnapshot.events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([newRunId]));
        expect(
            currentSnapshot.events
                .map(
                    (event) =>
                        (
                            event.payload as {
                                data?: {
                                    delta?: string;
                                };
                            }
                        ).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["current thinking"]);
        expect(bridge.flush()).toBe(true);
        expect(bridge.clearMemory()).toBe(true);
        expect(
            new Set(
                bridge.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([newRunId]));
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    startedAt: oldStartedAt,
                },
                runId: oldRunId,
                sessionId: oldSessionId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        expect(
            new Set(
                bridge.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([newRunId]));
    });
});
