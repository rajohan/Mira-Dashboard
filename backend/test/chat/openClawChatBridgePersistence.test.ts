import { describe, expect, it, jest } from "bun:test";

import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat/transport.ts";
import { OpenClawChatBridge } from "../../src/services/chat/openClawChatBridge.ts";
import type { OpenClawChatSnapshotStore } from "../../src/services/chat/openClawChatPersistence.ts";
import { envelopeBytes } from "../../src/services/chat/openClawChatProviderAdapter.ts";
import { MAX_BYTES_PER_ACTIVE_RUN } from "../../src/services/chat/openClawChatRetention.ts";
import { SqliteOpenClawChatSnapshotStore } from "../../src/services/chat/openClawChatSnapshotStore.ts";
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
function persistedSnapshot(
    sessionKey: string,
    runId: string,
    runtimeRecordedAt = Date.now(),
    state?: "final",
    sequence = 1
): OpenClawRuntimeSnapshot {
    return {
        completed: state === "final",
        events: [
            withCanonicalOpenClawEvents({
                event: state ? "chat" : "agent",
                payload: state
                    ? {
                          message: "done",
                          runId,
                          sessionKey,
                          state,
                      }
                    : {
                          runId,
                          sessionKey,
                          stream: "thinking",
                      },
                runtimeRecordedAt,
                runtimeSequence: sequence,
                type: "event",
            }),
        ],
        schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        throughSequence: sequence,
    };
}
describe("OpenClaw chat bridge persistence and compaction", () => {
    it("restores the latest run after process memory is replaced", () => {
        const store = new MemorySnapshotStore();
        const firstBridge = new OpenClawChatBridge(store);
        const thinking = firstBridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "still working",
                },
                runId: "persisted-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        firstBridge.flush();
        const restoredBridge = new OpenClawChatBridge(store);
        expect(restoredBridge.snapshot(MAIN)).toEqual({
            completed: false,
            events: [thinking],
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: thinking.runtimeSequence,
        });
        restoredBridge.recordEvent(
            "chat",
            {
                message: "finished",
                runId: "persisted-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        restoredBridge.clearMemory();
        expect(restoredBridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                thinking,
                expect.objectContaining({
                    event: "chat",
                }),
            ],
        });
    });
    it("preserves thinking while a long active replay round-trips through SQLite", () => {
        const store = new SqliteOpenClawChatSnapshotStore(
            `thinking-retention-${crypto.randomUUID()}`
        );
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const runId = "long-running-job";
        try {
            const bridge = new OpenClawChatBridge(store);
            const thinkingTexts = [
                "Started the long job",
                "Reached the review phase",
                "Checking the final result",
            ];
            for (const delta of thinkingTexts) {
                bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            delta,
                        },
                        runId,
                        sessionKey,
                        stream: "thinking",
                    },
                    []
                );
            }
            for (let index = 0; index < 130; index += 1) {
                const toolCallId = `call-${index}`;
                bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            args: {
                                command: "x".repeat(2000),
                            },
                            phase: "start",
                            stream: "tool",
                            toolCallId,
                        },
                        runId,
                        sessionKey,
                    },
                    []
                );
                bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            phase: "result",
                            result: {
                                output: "y".repeat(8000),
                            },
                            stream: "tool",
                            toolCallId,
                        },
                        runId,
                        sessionKey,
                    },
                    []
                );
            }
            expect(bridge.flush()).toBe(true);
            const restoredBridge = new OpenClawChatBridge(store);
            const activeSnapshot = restoredBridge.snapshot(sessionKey);
            const activeThinking = activeSnapshot.events.flatMap((event) => {
                const payload = event.payload as {
                    data?: {
                        delta?: string;
                        stream?: string;
                    };
                };
                return payload.data?.stream === undefined && payload.data?.delta
                    ? [payload.data.delta]
                    : [];
            });
            const activeToolCount = activeSnapshot.events.filter((event) => {
                const payload = event.payload as {
                    data?: {
                        stream?: string;
                    };
                };
                return payload.data?.stream === "tool";
            }).length;
            expect(activeSnapshot.completed).toBe(false);
            expect(activeThinking).toEqual(thinkingTexts);
            expect(activeToolCount).toBe(130);
            restoredBridge.recordEvent(
                "chat",
                {
                    message: "done",
                    runId,
                    sessionKey,
                    state: "final",
                },
                []
            );
            expect(restoredBridge.flush()).toBe(true);
            const completedSnapshot = new OpenClawChatBridge(store).snapshot(sessionKey);
            const completedThinking = completedSnapshot.events.flatMap((event) => {
                const payload = event.payload as {
                    data?: {
                        delta?: string;
                    };
                };
                return payload.data?.delta ? [payload.data.delta] : [];
            });
            const completedToolCount = completedSnapshot.events.filter((event) => {
                const payload = event.payload as {
                    data?: {
                        stream?: string;
                    };
                };
                return payload.data?.stream === "tool";
            }).length;
            expect(completedSnapshot.completed).toBe(true);
            expect(completedThinking).toEqual(thinkingTexts);
            expect(completedToolCount).toBe(0);
        } finally {
            store.clear();
        }
    });
    it("evicts item-stream tool variants before thinking after an active run crosses 64 MB", () => {
        const bridge = new OpenClawChatBridge();
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const runId = "bounded-long-run";
        const thinkingTexts = ["started", "reviewing", "finishing"];
        for (const delta of thinkingTexts) {
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta,
                    },
                    runId,
                    sessionKey,
                    stream: "thinking",
                },
                []
            );
        }
        const largeOutput = "x".repeat(975_000);
        const itemTypes = [
            "custom_tool_call",
            "custom_tool_call_output",
            "function_call",
            "function_call_output",
            "tool_call",
            "tool_call_output",
            "tool_result",
            "tool_use",
        ];
        const itemEventCount = 250;
        for (let index = 0; index < itemEventCount; index += 1) {
            const type = itemTypes[index % itemTypes.length];
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        item: {
                            content: largeOutput,
                            id: `large-call-${index}`,
                            name: "exec",
                            type,
                        },
                        stream: "item",
                    },
                    runId,
                    sessionKey,
                },
                []
            );
        }
        const snapshot = bridge.snapshot(sessionKey);
        const thinking = snapshot.events.flatMap((event) => {
            const payload = event.payload as {
                data?: {
                    delta?: string;
                };
            };
            return payload.data?.delta ? [payload.data.delta] : [];
        });
        const itemToolCount = snapshot.events.filter((event) => {
            const payload = event.payload as {
                data?: {
                    stream?: string;
                };
            };
            return payload.data?.stream === "item";
        }).length;
        expect(snapshot.completed).toBe(false);
        expect(thinking).toEqual(thinkingTexts);
        expect(itemToolCount).toBeGreaterThan(0);
        expect(itemToolCount).toBeLessThan(itemEventCount);
        expect(
            snapshot.events.reduce(
                (totalBytes, event) => totalBytes + envelopeBytes(event),
                0
            )
        ).toBeLessThanOrEqual(MAX_BYTES_PER_ACTIVE_RUN);
    });
    it("bounds aggregate replay memory across independent sessions", () => {
        const bridge = new OpenClawChatBridge(undefined, {
            maxReplayBytes: 900_000,
        });
        const oldSession = "agent:main:old-budget-session";
        const currentSession = "agent:ops:current-budget-session";
        const largeThinking = "x".repeat(600_000);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: largeThinking,
                },
                runId: "old-run",
                sessionKey: oldSession,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "old-run",
                sessionKey: oldSession,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: largeThinking,
                },
                runId: "current-run",
                sessionKey: currentSession,
                stream: "thinking",
            },
            []
        );
        expect(bridge.snapshot(oldSession).events).toEqual([]);
        expect(bridge.snapshot(currentSession).events).toHaveLength(1);
        expect(bridge.getMetrics().replay).toMatchObject({
            currentBytes: expect.any(Number),
            memoryEvictions: 1,
            peakBytes: expect.any(Number),
        });
        expect(bridge.getMetrics().replay.currentBytes).toBeLessThanOrEqual(900_000);
        expect(bridge.getMetrics().replay.peakBytes).toBeGreaterThan(900_000);
    });
    it("rehydrates an oversized protected session without retaining it in memory", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store, {
            maxReplayBytes: 500_000,
        });
        const sessionKey = "agent:main:oversized-protected-session";
        const retained = bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "x".repeat(600_000),
                },
                runId: "oversized-run",
                sessionKey,
                stream: "thinking",
            },
            []
        );
        expect(
            (
                retained.payload as {
                    data?: {
                        delta?: string;
                    };
                }
            ).data?.delta
        ).toBeUndefined();
        expect(
            retained.canonicalEvents.find((event) => event.kind === "thinking")
        ).toMatchObject({
            message: {
                thinking: [
                    {
                        text: "x".repeat(600_000),
                    },
                ],
            },
        });
        expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThanOrEqual(
            1_000_000
        );
        expect(store.snapshots.get(sessionKey)?.events).toEqual([retained]);
        expect(store.loadedKeys).toEqual([]);
        expect(bridge.snapshot(sessionKey).events).toEqual([retained]);
        expect(store.loadedKeys).toEqual([sessionKey]);
        expect(bridge.snapshot(sessionKey).events).toEqual([retained]);
        expect(store.loadedKeys).toEqual([sessionKey, sessionKey]);
    });
    it("rehydrates an aggregate-budget eviction from the snapshot store", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store, {
            maxReplayBytes: 900_000,
        });
        const oldSession = "agent:main:persisted-budget-session";
        const currentSession = "agent:ops:persisted-budget-session";
        const largeThinking = "x".repeat(600_000);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: largeThinking,
                },
                runId: "old-run",
                sessionKey: oldSession,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "old-run",
                sessionKey: oldSession,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: largeThinking,
                },
                runId: "current-run",
                sessionKey: currentSession,
                stream: "thinking",
            },
            []
        );
        expect(store.snapshots.has(oldSession)).toBe(true);
        expect(bridge.snapshot(oldSession).events).toHaveLength(2);
        expect(store.snapshots.has(currentSession)).toBe(true);
        expect(bridge.snapshot(currentSession).events).toHaveLength(1);
    });
    it("rebuilds an incrementally persisted tool bubble across a restart", () => {
        const store = new SqliteOpenClawChatSnapshotStore(
            `incremental-tool-${crypto.randomUUID()}`
        );
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const runId = "incremental-tool-run";
        try {
            const bridge = new OpenClawChatBridge(store);
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        args: {
                            command: "true",
                        },
                        phase: "start",
                        stream: "tool",
                        toolCallId: "call-1",
                    },
                    runId,
                    sessionKey,
                },
                []
            );
            expect(bridge.flush()).toBe(true);
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        phase: "result",
                        result: {
                            exitCode: 0,
                        },
                        stream: "tool",
                        toolCallId: "call-1",
                    },
                    runId,
                    sessionKey,
                },
                []
            );
            expect(bridge.flush()).toBe(true);
            const restored = new OpenClawChatBridge(store).snapshot(sessionKey);
            expect(restored.events).toHaveLength(1);
            expect(restored.events[0]?.payload).toMatchObject({
                data: {
                    args: {
                        command: "true",
                    },
                    phase: "result",
                    result: {
                        exitCode: 0,
                    },
                    toolCallId: "call-1",
                },
            });
        } finally {
            store.clear();
        }
    });
    it("seeds the global sequence from unhydrated persisted sessions", () => {
        const store = new MemorySnapshotStore();
        const otherSession = "agent:other:main";
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "main-run", Date.now(), undefined, 100)
        );
        store.snapshots.set(
            otherSession,
            persistedSnapshot(otherSession, "other-run", Date.now(), undefined, 200)
        );
        const bridge = new OpenClawChatBridge(store);
        expect(store.loadedKeys).toEqual([]);
        expect(bridge.captureRequestBoundary(MAIN)).toBe(200);
        expect(store.loadedKeys).toEqual([MAIN]);
        const nextEvent = bridge.recordEvent(
            "agent",
            {
                runId: "next-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(nextEvent.runtimeSequence).toBe(201);
        expect(store.loadedKeys).not.toContain(otherSession);
    });
    it("retries a transient sequence-watermark failure before recording", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "persisted-run", Date.now(), undefined, 73)
        );
        store.maximumSequenceFailures = 2;
        const bridge = new OpenClawChatBridge(store);
        expect(() => bridge.captureRequestBoundary(MAIN)).toThrow(
            "Runtime snapshot sequence watermark is unavailable"
        );
        const nextEvent = bridge.recordEvent(
            "agent",
            {
                runId: "next-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(nextEvent.runtimeSequence).toBe(74);
    });
    it("hydrates durable replay before retrying a write after lookup failures", () => {
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            for (const failure of ["keysFailures", "loadFailures"] as const) {
                const store = new MemorySnapshotStore();
                store.snapshots.set(
                    MAIN,
                    persistedSnapshot(MAIN, "shared-run", Date.now(), undefined, 1)
                );
                store[failure] = 2;
                const bridge = new OpenClawChatBridge(store);
                const nextEvent = bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            delta: "continued after hydration retry",
                        },
                        runId: "shared-run",
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    []
                );
                expect(store.snapshots.get(MAIN)?.events).toHaveLength(1);
                expect(bridge.flush()).toBe(false);
                expect(store.snapshots.get(MAIN)?.events).toHaveLength(1);
                expect(bridge.flush()).toBe(true);
                expect(store.snapshots.get(MAIN)?.events).toEqual([
                    expect.objectContaining({
                        runtimeSequence: 1,
                    }),
                    nextEvent,
                ]);
            }
        } finally {
            warning.mockRestore();
        }
    });
    it("persists manual compaction without displacing the latest completed run", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "chat",
            {
                message: "latest answer",
                runId: "latest-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "session.compaction",
            {
                operation: "compact",
                operationId: "compact-operation",
                phase: "start",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.compaction",
            {
                completed: true,
                operation: "compact",
                operationId: "compact-operation",
                phase: "end",
                sessionKey: MAIN,
            },
            []
        );
        bridge.flush();
        const restored = new OpenClawChatBridge(store).snapshot(MAIN);
        expect(restored.completed).toBe(true);
        expect(restored.events.map((event) => event.payload)).toEqual([
            expect.objectContaining({
                message: "latest answer",
                state: "final",
            }),
            expect.objectContaining({
                operationId: "compact-operation",
                phase: "start",
            }),
            expect.objectContaining({
                completed: true,
                operationId: "compact-operation",
                phase: "end",
            }),
        ]);
    });
    it("persists runless agent compaction with the latest completed answer", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "chat",
            {
                message: "latest answer",
                runId: "latest-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    stream: "compaction",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "end",
                    stream: "compaction",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.flush();
        const restored = new OpenClawChatBridge(store).snapshot(MAIN);
        expect(restored.completed).toBe(true);
        expect(restored.events.map((event) => event.event)).toEqual([
            "chat",
            "agent",
            "agent",
        ]);
        expect(restored.events[0]?.payload).toMatchObject({
            message: "latest answer",
            state: "final",
        });
    });
    it("persists detached agent compaction with the latest completed answer", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "latest answer",
                runId: "latest-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        for (const phase of ["start", "end"]) {
            bridge.recordEvent(
                "agent",
                {
                    phase,
                    runId: "detached-compaction-run",
                    sessionKey: MAIN,
                    stream: "compaction",
                },
                []
            );
        }
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "chat",
            "agent",
            "agent",
        ]);
    });
    it("completes a standalone agent compaction replay", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                phase: "start",
                runId: "compaction-only-run",
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                phase: "error",
                runId: "compaction-only-run",
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
        });
    });
    it("does not let agent compaction finish its active parent chat run", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                runId: "parent-run",
                sessionKey: MAIN,
                stream: "thinking",
                text: "working",
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
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
        });
        bridge.recordEvent(
            "chat",
            {
                message: "answer after compaction",
                runId: "parent-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
        });
    });
    it("does not let the lifecycle settlement after auto-compaction finish its active parent chat run", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "still working",
                },
                runId: "parent-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "session.tool",
            {
                callId: "call-before-compaction",
                name: "exec",
                phase: "result",
                result: "kept",
                runId: "parent-run",
                sessionKey: MAIN,
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
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(false);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "agent",
            "session.tool",
            "agent",
            "agent",
        ]);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "resumed after compaction",
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
                data: {
                    phase: "end",
                    stream: "lifecycle",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN).completed).toBe(true);
    });
    it("terminalizes an auto-compaction settlement when no response resumes", () => {
        jest.useFakeTimers();
        try {
            const store = new MemorySnapshotStore();
            const deferredEnvelopes: unknown[] = [];
            const bridge = new OpenClawChatBridge(store, {
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
                "session.tool",
                {
                    callId: "call-before-timeout",
                    name: "exec",
                    phase: "result",
                    result: "retained tool output",
                    runId: "parent-run",
                    sessionKey: MAIN,
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
            expect(bridge.snapshot(MAIN).completed).toBe(false);
            jest.advanceTimersByTime(30);
            const snapshot = bridge.snapshot(MAIN);
            expect(snapshot.completed).toBe(true);
            expect(snapshot.events.at(-1)).toMatchObject({
                canonicalEvents: [
                    expect.objectContaining({
                        kind: "finish",
                        outcome: "completed",
                    }),
                ],
                event: "model.completed",
                payload: {
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
            });
            expect(snapshot.events.some((event) => event.event === "session.tool")).toBe(
                true
            );
            expect(deferredEnvelopes).toHaveLength(1);
            expect(bridge.clearMemory()).toBe(true);
            const restarted = new OpenClawChatBridge(store);
            expect(
                restarted
                    .snapshot(MAIN)
                    .events.some((event) => event.event === "session.tool")
            ).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
    it("resumes a persisted auto-compaction settlement after reconnect", () => {
        jest.useFakeTimers();
        try {
            const store = new MemorySnapshotStore();
            const bridge = new OpenClawChatBridge(store, {
                nestedCompactionSettlementGraceMs: 10,
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
            bridge.markGatewayDisconnected();
            expect(bridge.flush()).toBe(true);
            expect(bridge.clearMemory()).toBe(true);
            const deferredEnvelopes: unknown[] = [];
            const restarted = new OpenClawChatBridge(store, {
                gatewayConnected: false,
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            expect(restarted.snapshot(MAIN).completed).toBe(false);
            jest.advanceTimersByTime(30);
            expect(deferredEnvelopes).toEqual([]);
            restarted.markGatewayConnected();
            jest.advanceTimersByTime(1000);
            expect(restarted.snapshot(MAIN).completed).toBe(true);
            expect(deferredEnvelopes).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });
    it("backs off before retrying a failed deferred compaction settlement", () => {
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
            const recordEvent = jest.spyOn(bridge, "recordEvent");
            recordEvent.mockImplementationOnce(() => {
                throw new Error("completion temporarily unavailable");
            });
            jest.advanceTimersByTime(10);
            expect(recordEvent).toHaveBeenCalledTimes(1);
            expect(deferredEnvelopes).toEqual([]);
            jest.advanceTimersByTime(999);
            expect(recordEvent).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            expect(recordEvent).toHaveBeenCalledTimes(2);
            expect(deferredEnvelopes).toHaveLength(1);
        } finally {
            jest.restoreAllMocks();
            jest.useRealTimers();
        }
    });
    it("completes the parent run when a lifecycle after auto-compaction fails", () => {
        const bridge = new OpenClawChatBridge();
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
                    error: "Compaction failed",
                    phase: "error",
                    stream: "lifecycle",
                },
                sessionKey: MAIN,
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.at(-1)?.canonicalEvents).toContainEqual(
            expect.objectContaining({
                error: "Compaction failed",
                kind: "finish",
                outcome: "error",
            })
        );
    });
    it("does not defer a failed lifecycle end after auto-compaction", () => {
        const bridge = new OpenClawChatBridge();
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
                    error: "Compaction failed",
                    phase: "end",
                    status: "failed",
                    stream: "lifecycle",
                },
                sessionKey: MAIN,
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.at(-1)?.canonicalEvents).toContainEqual(
            expect.objectContaining({
                error: "Compaction failed",
                kind: "finish",
                outcome: "error",
            })
        );
    });
    it("cancels deferred completion when a filtered item resumes the parent", () => {
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
            const eventCountBeforeContinuation = bridge.snapshot(MAIN).events.length;
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        item: {
                            kind: "reasoning",
                            phase: "start",
                        },
                        phase: "start",
                        stream: "item",
                    },
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
                []
            );
            jest.advanceTimersByTime(30);
            const snapshot = bridge.snapshot(MAIN);
            expect(snapshot.completed).toBe(false);
            expect(snapshot.events).toHaveLength(eventCountBeforeContinuation + 1);
            expect(snapshot.events.at(-1)).toMatchObject({
                canonicalEvents: [],
                event: "agent",
                payload: {
                    miraReplayMarker: "nested-compaction-continuation",
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
            });
            expect(deferredEnvelopes).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("keeps a filtered compaction continuation durable across restart", () => {
        jest.useFakeTimers();
        try {
            const store = new MemorySnapshotStore();
            const bridge = new OpenClawChatBridge(store, {
                nestedCompactionSettlementGraceMs: 10,
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
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        item: {
                            kind: "reasoning",
                            phase: "start",
                        },
                        phase: "start",
                        stream: "item",
                    },
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
                []
            );
            expect(bridge.flush()).toBe(true);
            expect(store.snapshots.get(MAIN)?.events.at(-1)?.payload).toMatchObject({
                miraReplayMarker: "nested-compaction-continuation",
            });
            expect(bridge.clearMemory()).toBe(true);
            const deferredEnvelopes: unknown[] = [];
            const restarted = new OpenClawChatBridge(store, {
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            expect(restarted.snapshot(MAIN).completed).toBe(false);
            jest.advanceTimersByTime(30);
            expect(restarted.snapshot(MAIN).completed).toBe(false);
            expect(deferredEnvelopes).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("keeps an oversized compaction continuation durable across restart", () => {
        jest.useFakeTimers();
        try {
            const store = new MemorySnapshotStore();
            const bridge = new OpenClawChatBridge(store, {
                nestedCompactionSettlementGraceMs: 10,
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
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: "x".repeat(1_100_000),
                    },
                    runId: "parent-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
            expect(bridge.snapshot(MAIN).events.at(-1)).toMatchObject({
                canonicalEvents: [],
                payload: {
                    miraReplayMarker: "nested-compaction-continuation",
                    runId: "parent-run",
                    sessionKey: MAIN,
                },
            });
            expect(bridge.flush()).toBe(true);
            expect(bridge.clearMemory()).toBe(true);
            const deferredEnvelopes: unknown[] = [];
            const restarted = new OpenClawChatBridge(store, {
                nestedCompactionSettlementGraceMs: 10,
                onDeferredEnvelope: (envelope) => deferredEnvelopes.push(envelope),
            });
            expect(restarted.snapshot(MAIN).completed).toBe(false);
            jest.advanceTimersByTime(30);
            expect(restarted.snapshot(MAIN).completed).toBe(false);
            expect(deferredEnvelopes).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("keeps deferred settlement interrupted until provider run promotion", () => {
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
            bridge.markGatewayDisconnected(Date.now());
            jest.advanceTimersByTime(30);
            expect(bridge.snapshot(MAIN).completed).toBe(false);
            expect(deferredEnvelopes).toEqual([]);
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        phase: "start",
                    },
                    runId: "provider-after-reconnect",
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
            jest.advanceTimersByTime(30);
            const snapshot = bridge.snapshot(MAIN);
            expect(snapshot.completed).toBe(false);
            expect(snapshot.events).toHaveLength(4);
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
                "provider-after-reconnect",
                "provider-after-reconnect",
                "provider-after-reconnect",
                "provider-after-reconnect",
            ]);
            expect(deferredEnvelopes).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
    it("keeps an unscoped final visible while dedicated compaction settles", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                phase: "start",
                runId: "compaction-run",
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                runId: "chat-run",
                sessionKey: MAIN,
                stream: "thinking",
                text: "working",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    event: "agent",
                }),
                expect.objectContaining({
                    event: "agent",
                }),
            ],
        });
        bridge.recordEvent(
            "chat",
            {
                message: "answer after compaction",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    event: "agent",
                }),
                expect.objectContaining({
                    event: "agent",
                }),
                expect.objectContaining({
                    event: "chat",
                    payload: expect.objectContaining({
                        message: "answer after compaction",
                    }),
                }),
            ],
        });
        bridge.recordEvent(
            "agent",
            {
                phase: "end",
                runId: "compaction-run",
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "agent",
                }),
                expect.objectContaining({
                    event: "chat",
                    payload: expect.objectContaining({
                        message: "answer after compaction",
                    }),
                }),
            ],
        });
    });
    it("keeps retrying compaction active until its settling lifecycle arrives", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    completed: true,
                    phase: "end",
                    stream: "compaction",
                    willRetry: true,
                },
                runId: "retrying-compaction",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
        });
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
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot).toMatchObject({
            completed: true,
        });
        expect(snapshot.events).toHaveLength(2);
    });
    it("completes a standalone manual compaction replay", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.compaction",
            {
                operation: "compact",
                operationId: "compact-operation",
                phase: "start",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.compaction",
            {
                operation: "compact",
                operationId: "compact-operation",
                phase: "end",
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
        });
    });
    it("does not let a nested completed compaction displace a later final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.compaction",
            {
                data: {
                    operation: "compact",
                    phase: "start",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.compaction",
            {
                data: {
                    operation: "compact",
                    phase: "end",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: "answer after compaction",
                runId: "final-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "chat",
                    payload: expect.objectContaining({
                        message: "answer after compaction",
                        state: "final",
                    }),
                }),
            ],
        });
    });
    it("marks a nested failed compaction replay terminal", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.compaction",
            {
                data: {
                    operation: "compact",
                    phase: "error",
                    status: "failed",
                },
                sessionKey: MAIN,
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events[0]).toMatchObject({
            event: "session.compaction",
            payload: {
                data: {
                    status: "failed",
                },
            },
        });
    });
    it("marks a nested completed compaction status terminal", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.compaction",
            {
                data: {
                    operation: "compact",
                    status: "completed",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
        });
    });
});
