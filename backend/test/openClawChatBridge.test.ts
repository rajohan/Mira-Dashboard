import { describe, expect, it, jest } from "bun:test";

import {
    OpenClawChatBridge,
    type OpenClawChatSnapshotStore,
    type OpenClawRuntimeSnapshot,
} from "../src/chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "../src/chat/openClawChatSnapshotStore.ts";

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
            {
                event: state ? "chat" : "agent",
                payload: state
                    ? { message: "done", runId, sessionKey, state }
                    : { runId, sessionKey, stream: "thinking" },
                runtimeRecordedAt,
                runtimeSequence: sequence,
                type: "event",
            },
        ],
        throughSequence: sequence,
    };
}

describe("OpenClaw chat bridge", () => {
    it("restores the latest run after process memory is replaced", () => {
        const store = new MemorySnapshotStore();
        const firstBridge = new OpenClawChatBridge(store);
        const thinking = firstBridge.recordEvent(
            "agent",
            {
                data: { delta: "still working" },
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
            events: [thinking, expect.objectContaining({ event: "chat" })],
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
                        data: { delta },
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
                            args: { command: "x".repeat(2000) },
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
                            result: { output: "y".repeat(8000) },
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
                    data?: { delta?: string; stream?: string };
                };
                return payload.data?.stream === undefined && payload.data?.delta
                    ? [payload.data.delta]
                    : [];
            });
            const activeToolCount = activeSnapshot.events.filter((event) => {
                const payload = event.payload as { data?: { stream?: string } };
                return payload.data?.stream === "tool";
            }).length;

            expect(activeSnapshot.completed).toBe(false);
            expect(activeThinking).toEqual(thinkingTexts);
            expect(activeToolCount).toBe(130);

            restoredBridge.recordEvent(
                "chat",
                { message: "done", runId, sessionKey, state: "final" },
                []
            );
            expect(restoredBridge.flush()).toBe(true);
            const completedSnapshot = new OpenClawChatBridge(store).snapshot(sessionKey);
            const completedThinking = completedSnapshot.events.flatMap((event) => {
                const payload = event.payload as { data?: { delta?: string } };
                return payload.data?.delta ? [payload.data.delta] : [];
            });
            const completedToolCount = completedSnapshot.events.filter((event) => {
                const payload = event.payload as { data?: { stream?: string } };
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
                    data: { delta },
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
        for (let index = 0; index < 66; index += 1) {
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
            const payload = event.payload as { data?: { delta?: string } };
            return payload.data?.delta ? [payload.data.delta] : [];
        });
        const itemToolCount = snapshot.events.filter((event) => {
            const payload = event.payload as { data?: { stream?: string } };
            return payload.data?.stream === "item";
        }).length;

        expect(snapshot.completed).toBe(false);
        expect(thinking).toEqual(thinkingTexts);
        expect(itemToolCount).toBeGreaterThan(0);
        expect(itemToolCount).toBeLessThan(66);
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
                data: { delta: largeThinking },
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
                data: { delta: largeThinking },
                runId: "current-run",
                sessionKey: currentSession,
                stream: "thinking",
            },
            []
        );

        expect(bridge.snapshot(oldSession).events).toEqual([]);
        expect(bridge.snapshot(currentSession).events).toHaveLength(1);
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
                data: { delta: "x".repeat(600_000) },
                runId: "oversized-run",
                sessionKey,
                stream: "thinking",
            },
            []
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
                data: { delta: largeThinking },
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
                data: { delta: largeThinking },
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
                        args: { command: "true" },
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
                        result: { exitCode: 0 },
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
                    args: { command: "true" },
                    phase: "result",
                    result: { exitCode: 0 },
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
            { runId: "next-run", sessionKey: MAIN, stream: "thinking" },
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
            { runId: "next-run", sessionKey: MAIN, stream: "thinking" },
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
                        data: { delta: "continued after hydration retry" },
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
                    expect.objectContaining({ runtimeSequence: 1 }),
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
            expect.objectContaining({ message: "latest answer", state: "final" }),
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
                data: { phase: "start", stream: "compaction" },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: { phase: "end", stream: "compaction" },
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

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: true });
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

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: false });

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
        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: true });
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
                expect.objectContaining({ event: "agent" }),
                expect.objectContaining({ event: "agent" }),
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
                expect.objectContaining({ event: "agent" }),
                expect.objectContaining({ event: "agent" }),
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
                expect.objectContaining({ event: "agent" }),
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

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: false });

        bridge.recordEvent(
            "agent",
            {
                data: { phase: "end", stream: "lifecycle" },
                sessionKey: MAIN,
            },
            []
        );

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot).toMatchObject({ completed: true });
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

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: true });
    });

    it("does not let a nested completed compaction displace a later final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.compaction",
            {
                data: { operation: "compact", phase: "start" },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.compaction",
            {
                data: { operation: "compact", phase: "end" },
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
            payload: { data: { status: "failed" } },
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

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: true });
    });

    it("removes the previous persisted replay when a new send starts", () => {
        const store = new MemorySnapshotStore();
        const firstBridge = new OpenClawChatBridge(store);
        firstBridge.recordEvent(
            "chat",
            {
                message: "old final",
                runId: "old-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );

        const restoredBridge = new OpenClawChatBridge(store);
        restoredBridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-next",
                message: "next question",
                sessionKey: MAIN,
            },
            { runId: "next-run" },
            restoredBridge.captureRequestBoundary()
        );

        expect(new OpenClawChatBridge(store).snapshot(MAIN).events).toEqual([]);
    });

    it("keeps the active persisted run when chat.send is a live steer", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        const thinking = bridge.recordEvent(
            "agent",
            {
                data: { delta: "working" },
                runId: "active-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-steer",
                message: "steer",
                sessionKey: MAIN,
            },
            { runId: "active-run" },
            bridge.captureRequestBoundary()
        );
        const steer = bridge.recordEvent(
            "session.message",
            { message: { content: "steer", role: "user" }, sessionKey: MAIN },
            []
        );
        bridge.flush();

        expect(new OpenClawChatBridge(store).snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [thinking, steer],
        });
    });

    it("coalesces progress persistence and flushes terminal events immediately", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        for (const progressText of ["one", "two", "three"]) {
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        itemId: "progress-1",
                        kind: "preamble",
                        phase: "update",
                        progressText,
                    },
                    runId: "run-1",
                    sessionKey: MAIN,
                    stream: "item",
                },
                []
            );
        }

        expect(store.saveCount).toBe(0);
        expect(store.keysCount).toBe(1);
        bridge.flush();
        expect(store.saveCount).toBe(1);

        bridge.recordEvent(
            "chat",
            { message: "done", runId: "run-1", sessionKey: MAIN, state: "final" },
            []
        );
        expect(store.saveCount).toBe(2);
        expect(store.snapshots.get(MAIN)?.completed).toBe(true);
    });

    it("keeps a failed coalesced write pending for the next flush", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "working" },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        store.saveFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            expect(bridge.flush()).toBe(false);
            expect(store.snapshots.has(MAIN)).toBe(false);

            expect(bridge.flush()).toBe(true);
            expect(store.snapshots.get(MAIN)?.events).toHaveLength(1);
        } finally {
            warning.mockRestore();
        }
    });

    it("retains process memory when a final persistence flush fails", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "working" },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        store.saveFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            expect(bridge.clearMemory()).toBe(false);
            expect(bridge.snapshot(MAIN).events).toHaveLength(1);
            expect(bridge.clearMemory()).toBe(true);
            expect(new OpenClawChatBridge(store).snapshot(MAIN).events).toHaveLength(1);
        } finally {
            warning.mockRestore();
        }
    });

    it("promotes an already-loaded short session alias to its canonical key", () => {
        const store = new MemorySnapshotStore();
        const snapshot = persistedSnapshot("main", "run-1");
        snapshot.events[0]!.payload = {
            data: {
                runId: "run-1",
                sessionKey: "main",
                stream: "thinking",
            },
            runId: "run-1",
            sessionKey: "main",
            stream: "thinking",
        };
        store.snapshots.set("main", snapshot);
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot("main").events).toHaveLength(1);
        expect(bridge.snapshot(MAIN).events[0]?.payload).toMatchObject({
            data: { runId: "run-1", sessionKey: MAIN },
            runId: "run-1",
            sessionKey: MAIN,
        });
        expect(store.snapshots.has("main")).toBe(false);
        expect(store.snapshots.has(MAIN)).toBe(true);
        expect(
            new OpenClawChatBridge(store).snapshot(MAIN).events[0]?.payload
        ).toMatchObject({
            data: { runId: "run-1", sessionKey: MAIN },
            runId: "run-1",
            sessionKey: MAIN,
        });
    });

    it("preserves normalized persistence during case-only canonical promotion", () => {
        const store = new SqliteOpenClawChatSnapshotStore(
            `bridge-scope-${crypto.randomUUID()}`
        );
        const canonicalSessionKey = MAIN.toUpperCase();
        store.save(MAIN, persistedSnapshot(MAIN, "run-1"));

        try {
            const bridge = new OpenClawChatBridge(store);
            expect(bridge.snapshot(canonicalSessionKey).events).toHaveLength(1);

            const restoredBridge = new OpenClawChatBridge(store);
            expect(restoredBridge.snapshot(canonicalSessionKey).events).toHaveLength(1);
        } finally {
            store.clear();
        }
    });

    it("uses one replay entry for equivalent session-key spellings", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(MAIN, persistedSnapshot(MAIN, "run-1"));
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot(MAIN).events).toHaveLength(1);
        expect(bridge.snapshot(` ${MAIN.toUpperCase()} `).events).toHaveLength(1);

        bridge.recordEvent(
            "agent",
            {
                data: { delta: "continued" },
                runId: "run-1",
                sessionKey: MAIN.toUpperCase(),
                stream: "thinking",
            },
            []
        );
        expect(bridge.snapshot(MAIN).events).toHaveLength(2);
        expect(bridge.snapshot(MAIN.toUpperCase()).events).toHaveLength(2);

        expect(bridge.flush()).toBe(true);
        expect(store.snapshots.keys().toArray()).toEqual([MAIN]);
    });

    it("retries canonical alias promotion after persistence fails", () => {
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            for (const hydrationMode of ["cold", "alias-loaded"] as const) {
                const store = new MemorySnapshotStore();
                store.snapshots.set("main", persistedSnapshot("main", "run-1"));
                const bridge = new OpenClawChatBridge(store);
                if (hydrationMode === "alias-loaded") {
                    expect(bridge.snapshot("main").events).toHaveLength(1);
                }
                store.saveFailures = 1;

                expect(bridge.snapshot(MAIN).events).toEqual([]);
                expect(store.snapshots.has("main")).toBe(true);
                expect(store.snapshots.has(MAIN)).toBe(false);

                expect(bridge.snapshot(MAIN).events[0]?.payload).toMatchObject({
                    runId: "run-1",
                    sessionKey: MAIN,
                });
                expect(store.snapshots.has("main")).toBe(false);
                expect(store.snapshots.has(MAIN)).toBe(true);
            }
        } finally {
            warning.mockRestore();
        }
    });

    it("hydrates and merges an unloaded canonical replay before alias promotion", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "shared-run", Date.now(), undefined, 1)
        );
        store.snapshots.set(
            "main",
            persistedSnapshot("main", "shared-run", Date.now() + 1, "final", 2)
        );
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot("main").events).toHaveLength(1);
        bridge.reconcileSessions([{ id: "main", key: MAIN }]);

        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    runId: "shared-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                }),
            }),
            expect.objectContaining({
                payload: expect.objectContaining({
                    message: "done",
                    runId: "shared-run",
                    sessionKey: MAIN,
                    state: "final",
                }),
            }),
        ]);
        expect(store.snapshots.has("main")).toBe(false);
        expect(store.snapshots.get(MAIN)?.events).toHaveLength(2);
    });

    it("keeps the source replay intact when canonical promotion cannot persist", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "shared-run", Date.now(), undefined, 1)
        );
        store.snapshots.set(
            "main",
            persistedSnapshot("main", "shared-run", Date.now() + 1, "final", 2)
        );
        const bridge = new OpenClawChatBridge(store);
        bridge.snapshot("main");
        store.saveFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.reconcileSessions([{ id: "main", key: MAIN }]);

            expect(store.snapshots.get("main")?.events).toHaveLength(1);
            expect(store.snapshots.get(MAIN)?.events).toHaveLength(1);
            expect(bridge.snapshot("main").events).toHaveLength(1);

            bridge.reconcileSessions([{ id: "main", key: MAIN }]);

            expect(store.snapshots.has("main")).toBe(false);
            expect(store.snapshots.get(MAIN)?.events).toHaveLength(2);
        } finally {
            warning.mockRestore();
        }
    });

    it("does not delete a promoted canonical replay while retrying its old alias", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set("main", persistedSnapshot("main", "run-1"));
        const bridge = new OpenClawChatBridge(store);
        bridge.snapshot("main");
        store.deleteFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.snapshot(MAIN);
            bridge.clearMemory();

            expect(bridge.snapshot(MAIN).events[0]?.payload).toMatchObject({
                runId: "run-1",
                sessionKey: MAIN,
            });
            expect(store.snapshots.has("main")).toBe(false);
            expect(store.snapshots.has(MAIN)).toBe(true);
        } finally {
            warning.mockRestore();
        }
    });

    it("retries a failed replay delete before the session can hydrate again", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "old-run", Date.now(), "final")
        );
        const bridge = new OpenClawChatBridge(store);
        bridge.snapshot(MAIN);
        store.deleteFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.handleSuccessfulRequest(
                "chat.send",
                {
                    idempotencyKey: "dashboard-chat-next",
                    message: "next",
                    sessionKey: MAIN,
                },
                { runId: "next-run" },
                bridge.captureRequestBoundary()
            );
            bridge.clearMemory();

            expect(bridge.snapshot(MAIN).events).toEqual([]);
            expect(store.snapshots.has(MAIN)).toBe(false);
        } finally {
            warning.mockRestore();
        }
    });

    it("blocks hydration until a failed full clear succeeds", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(MAIN, persistedSnapshot(MAIN, "old-run"));
        const bridge = new OpenClawChatBridge(store);
        bridge.snapshot(MAIN);
        store.clearFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.clear();
            expect(bridge.snapshot(MAIN).events).toEqual([]);
            expect(store.snapshots.size).toBe(0);
        } finally {
            warning.mockRestore();
        }
    });

    it("retains a broad tombstone when stored alias enumeration fails", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set("main", persistedSnapshot("main", "old-run"));
        store.keysFailures = 1;
        const bridge = new OpenClawChatBridge(store);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.clearSession(MAIN);
            expect(bridge.snapshot(MAIN).events).toEqual([]);
            expect(store.snapshots.has("main")).toBe(false);
        } finally {
            warning.mockRestore();
        }
    });

    it("clears an old broad tombstone before persisting a new run", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set("main", persistedSnapshot("main", "old-run"));
        store.keysFailures = 1;
        const bridge = new OpenClawChatBridge(store);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            bridge.clearSession(MAIN);
            store.deleteFailures = 1;
            const nextEvent = bridge.recordEvent(
                "agent",
                {
                    data: { delta: "new run" },
                    runId: "new-run",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
            bridge.flush();

            expect(store.snapshots.has("main")).toBe(false);
            expect(store.snapshots.get(MAIN)?.events).toEqual([nextEvent]);
        } finally {
            warning.mockRestore();
        }
    });

    it("deletes persisted snapshots when the in-memory session limit evicts them", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        for (let index = 0; index <= 50; index += 1) {
            bridge.recordEvent(
                "chat",
                {
                    message: `done ${index}`,
                    runId: `run-${index}`,
                    sessionKey: `agent:test:${index}`,
                    state: "final",
                },
                []
            );
        }

        expect(store.snapshots.size).toBe(50);
        expect(store.snapshots.has("agent:test:0")).toBe(false);
        expect(store.snapshots.has("agent:test:50")).toBe(true);
    });

    it("protects the requested persisted replay while hydrating at the session limit", () => {
        const store = new MemorySnapshotStore();
        const now = Date.now();
        for (let index = 0; index <= 50; index += 1) {
            const sessionKey = `agent:test:${index}`;
            store.snapshots.set(
                sessionKey,
                persistedSnapshot(
                    sessionKey,
                    `run-${index}`,
                    now + index,
                    "final",
                    index + 1
                )
            );
        }
        const bridge = new OpenClawChatBridge(store);
        for (let index = 1; index <= 50; index += 1) {
            expect(bridge.snapshot(`agent:test:${index}`).events).toHaveLength(1);
        }

        expect(bridge.snapshot("agent:test:0").events[0]?.payload).toMatchObject({
            runId: "run-0",
            sessionKey: "agent:test:0",
        });
        expect(store.snapshots.has("agent:test:0")).toBe(true);
        expect(store.snapshots.has("agent:test:1")).toBe(false);
        expect(store.snapshots.size).toBe(50);
    });

    it("expires an active persisted replay from more than six hours ago", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "stale-run", Date.now() - 6 * 60 * 60_000 - 1)
        );
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: false, events: [] });
        expect(store.snapshots.has(MAIN)).toBe(false);
    });

    it("deletes an expired persisted alias requested through its canonical key", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            "main",
            persistedSnapshot("main", "stale-run", Date.now() - 6 * 60 * 60_000 - 1)
        );
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot(MAIN)).toMatchObject({ completed: false, events: [] });
        expect(store.snapshots.has("main")).toBe(false);
        expect(store.snapshots.has(MAIN)).toBe(false);
    });

    it("retains an old completed replay until a new send replaces it", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(
                MAIN,
                "completed-run",
                Date.now() - 7 * 24 * 60 * 60_000,
                "final"
            )
        );
        const bridge = new OpenClawChatBridge(store);

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({ runId: "completed-run" }),
                }),
            ],
        });

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-next",
                message: "next",
                sessionKey: MAIN,
            },
            { runId: "next-run" },
            bridge.captureRequestBoundary(MAIN)
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
    });

    it("retains run activity while coalescing full item progress snapshots", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            { runId: "long-run", sessionKey: MAIN },
            []
        );
        for (let index = 0; index < 600; index += 1) {
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        itemId: "preamble-1",
                        kind: "preamble",
                        phase: "update",
                        progressText: `Working ${index}`,
                        stream: "item",
                    },
                    runId: "long-run",
                    sessionKey: MAIN,
                },
                []
            );
        }

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(false);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "session.started",
            "agent",
        ]);
        expect(snapshot.events[1]?.payload).toMatchObject({
            data: { progressText: "Working 599" },
        });
    });

    it("stores one replay event per visible native tool bubble", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            { runId: "tool-run", sessionKey: MAIN },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    itemId: "call-1",
                    kind: "command",
                    phase: "start",
                    stream: "item",
                    suppressChannelProgress: true,
                },
                runId: "tool-run",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.tool",
            {
                data: {
                    args: { command: "true" },
                    itemId: "call-1",
                    name: "bash",
                    phase: "start",
                    toolCallId: "call-1",
                },
                runId: "tool-run",
                sessionKey: MAIN,
                stream: "tool",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    itemId: "call-1",
                    kind: "command",
                    phase: "end",
                    stream: "item",
                    suppressChannelProgress: true,
                },
                runId: "tool-run",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.tool",
            {
                data: {
                    isError: false,
                    itemId: "call-1",
                    name: "bash",
                    phase: "result",
                    result: { exitCode: 0, status: "completed" },
                    toolCallId: "call-1",
                },
                runId: "tool-run",
                sessionKey: MAIN,
                stream: "tool",
            },
            []
        );

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "session.started",
            "session.tool",
        ]);
        expect(snapshot.events[1]?.payload).toMatchObject({
            data: {
                args: { command: "true" },
                phase: "result",
                result: { exitCode: 0, status: "completed" },
                toolCallId: "call-1",
            },
        });
    });

    it("coalesces agent tool phases into one replay event", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    args: { command: "true" },
                    phase: "start",
                    stream: "tool",
                    toolCallId: "call-1",
                },
                runId: "tool-run",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "result",
                    result: { exitCode: 0, status: "completed" },
                    stream: "tool",
                    toolCallId: "call-1",
                },
                runId: "tool-run",
                sessionKey: MAIN,
            },
            []
        );

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).toMatchObject({ event: "agent" });
        expect(snapshot.events[0]?.payload).toMatchObject({
            data: {
                args: { command: "true" },
                phase: "result",
                result: { exitCode: 0, status: "completed" },
                toolCallId: "call-1",
            },
        });
    });

    it("retains suppressed item diagnostics for snapshot replay", () => {
        const bridge = new OpenClawChatBridge();
        const thinking = bridge.recordEvent(
            "agent",
            {
                data: {
                    itemId: "thinking-1",
                    kind: "reasoning",
                    phase: "update",
                    progressText: "private reasoning",
                    suppressChannelProgress: true,
                },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "item",
            },
            []
        );
        const tool = bridge.recordEvent(
            "agent",
            {
                data: {
                    item: {
                        arguments: { command: "true" },
                        id: "call-1",
                        name: "exec",
                        type: "toolCall",
                    },
                    suppressChannelProgress: true,
                },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "item",
            },
            []
        );

        expect(bridge.snapshot(MAIN).events).toEqual([thinking, tool]);
    });

    it("does not let a runless session start displace an explicit completed run", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent("session.started", { sessionKey: MAIN }, []);
        const final = bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: "provider-run",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [final],
        });
    });

    it("drops provider-internal replay noise without affecting live sequencing", () => {
        const bridge = new OpenClawChatBridge();
        const ignored = bridge.recordEvent(
            "agent",
            {
                data: { phase: "started" },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "codex_app_server.hook",
            },
            []
        );
        const retained = bridge.recordEvent(
            "agent",
            {
                data: { delta: "reasoning" },
                runId: "run-1",
                stream: "thinking",
            },
            []
        );

        expect(ignored.runtimeSequence).toBe(1);
        expect(retained.runtimeSequence).toBe(2);
        expect(retained.payload).toMatchObject({ sessionKey: MAIN });
        expect(bridge.snapshot(MAIN).events).toEqual([retained]);
    });

    it("keeps the latest full thinking snapshot after a run completes", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            { runId: "completed-run", sessionKey: MAIN },
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
            data: { progressText: "First and second" },
        });
    });

    it("sequences, enriches and quarantines ambiguous run associations", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            { sessionKey: MAIN },
            { runId: "shared-run" }
        );
        const first = bridge.recordEvent(
            "agent",
            { runId: "shared-run", stream: "thinking" },
            []
        );
        expect(first).toMatchObject({
            payload: { runId: "shared-run", sessionKey: MAIN },
            runtimeSequence: 1,
        });

        bridge.handleSuccessfulRequest(
            "chat.send",
            { sessionKey: "agent:other:main" },
            { runId: "shared-run" }
        );
        const ambiguous = bridge.recordEvent(
            "agent",
            { runId: "shared-run", stream: "thinking" },
            []
        );
        expect(ambiguous.payload).not.toHaveProperty("sessionKey");
        expect(bridge.snapshot(MAIN).events).toHaveLength(1);
        expect(bridge.snapshot("agent:other:main").events).toHaveLength(0);

        bridge.clearSession("agent:other:main");
        expect(
            bridge.recordEvent("agent", { runId: "shared-run", stream: "thinking" }, [])
                .payload
        ).toMatchObject({ runId: "shared-run", sessionKey: MAIN });
    });

    it("keeps live sequence numbers monotonic when replay state is cleared", () => {
        const bridge = new OpenClawChatBridge();
        const first = bridge.recordEvent(
            "agent",
            { runId: "first", sessionKey: MAIN, stream: "thinking" },
            []
        );
        bridge.clear();
        const second = bridge.recordEvent(
            "agent",
            { runId: "second", sessionKey: MAIN, stream: "thinking" },
            []
        );

        expect(first.runtimeSequence).toBe(1);
        expect(second.runtimeSequence).toBe(2);
    });

    it("treats duplicate run ids in the provider session index as ambiguous", () => {
        const bridge = new OpenClawChatBridge();
        const event = bridge.recordEvent(
            "agent",
            { runId: "shared-run", stream: "thinking" },
            [
                { id: "main", key: MAIN, runId: "shared-run" },
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
            { runId: "short-session-run", sessionKey: "main", stream: "thinking" },
            [{ id: "main", key: MAIN }]
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

        expect(event.payload).toMatchObject({ sessionKey: "main" });
        expect(bridge.snapshot("main").events).toEqual([event]);

        bridge.reconcileSessions([{ id: "main", key: MAIN }]);

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
            { runId: "clear-run", sessionKey: "main", stream: "thinking" },
            []
        );
        clearedBridge.clearSession(MAIN);
        expect(clearedBridge.snapshot("main").events).toEqual([]);
    });

    it("merges quarantined and canonical replay for the same run", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "early" },
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

        bridge.reconcileSessions([{ id: "main", key: MAIN }]);

        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: { delta: "early" },
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
            bridge.recordEvent("agent", { runId: "shared-alias-run" }, []).payload
        ).toMatchObject({ sessionKey: MAIN });
    });

    it("keeps conflicting index and run associations quarantined", () => {
        const bridge = new OpenClawChatBridge();
        bridge.handleSuccessfulRequest(
            "chat.send",
            { sessionKey: MAIN },
            { runId: "conflicting-run" }
        );

        const event = bridge.recordEvent(
            "agent",
            {
                runId: "conflicting-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [{ id: "main", key: "agent:other:main" }]
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
            { sessionKey: otherSessionKey },
            { runId: "delayed-correlation-run" }
        );

        bridge.reconcileSessions([{ id: "main", key: MAIN }]);
        expect(bridge.snapshot("main").events).toEqual([event]);
        expect(bridge.snapshot(MAIN).events).toEqual([]);

        bridge.reconcileSessions([
            { id: "main", key: MAIN },
            { id: "other", key: otherSessionKey },
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
            { runId: "ambiguous-session-run", sessionKey: "main", stream: "thinking" },
            [
                { id: "main", key: MAIN },
                { id: "main", key: "agent:other:main" },
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
            { sessionKey: MAIN },
            { runId: "associated-run" }
        );
        const event = bridge.recordEvent(
            "agent",
            { runId: "associated-run", sessionKey: "main", stream: "thinking" },
            [
                { id: "main", key: MAIN },
                { id: "main", key: "agent:other:main" },
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
            { sessionKey: "agent:stale:main" },
            { runId: "stale-associated-run" }
        );
        const event = bridge.recordEvent(
            "agent",
            {
                runId: "stale-associated-run",
                sessionKey: "main",
                stream: "thinking",
            },
            [
                { id: "main", key: MAIN },
                { id: "main", key: "agent:other:main" },
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
                data: { delta: "working" },
                runId: "dashboard-chat-local",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "chat",
            {
                message: { role: "assistant", text: "done" },
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
            { runId: "real-run" }
        );
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

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
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

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
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "chat",
                    payload: expect.objectContaining({ message: "done" }),
                }),
            ],
        });
    });

    it("does not let repeated terminal metadata displace an unscoped final", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            { message: "done", sessionKey: MAIN, state: "final" },
            []
        );
        for (let index = 0; index < 6; index += 1) {
            bridge.recordEvent("model.completed", { sessionKey: MAIN }, []);
        }

        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                event: "chat",
                payload: expect.objectContaining({ message: "done" }),
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
                data: { delta: "new reasoning" },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

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
                data: { delta: "older reasoning" },
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
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [expect.objectContaining({ event: "agent" })],
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
                data: { phase: "start" },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            {
                message: { content: "question", role: "user" },
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "before restart" },
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
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        restarted.recordEvent(
            "agent",
            {
                data: { delta: "after restart" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );

        const snapshot = restarted.snapshot(MAIN);
        expect(snapshot.completed).toBe(false);
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
        expect(
            snapshot.events
                .map(
                    (event) =>
                        (event.payload as { data?: { delta?: string } }).data?.delta
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
                {
                    event: "agent",
                    payload: {
                        data: { phase: "start" },
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    runtimeRecordedAt: now - 3,
                    runtimeSequence: 1,
                    type: "event",
                },
                {
                    event: "agent",
                    payload: {
                        data: { delta: "before restart" },
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    runtimeRecordedAt: now - 2,
                    runtimeSequence: 2,
                    type: "event",
                },
                {
                    event: "agent",
                    payload: {
                        data: { phase: "start" },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    runtimeRecordedAt: now - 1,
                    runtimeSequence: 3,
                    type: "event",
                },
                {
                    event: "agent",
                    payload: {
                        data: { delta: "after restart" },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    runtimeRecordedAt: now,
                    runtimeSequence: 4,
                    type: "event",
                },
            ],
            throughSequence: 4,
        });

        const repairedBridge = new OpenClawChatBridge(store);
        const snapshot = repairedBridge.snapshot(MAIN);

        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
        expect(
            snapshot.events
                .map(
                    (event) =>
                        (event.payload as { data?: { delta?: string } }).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["before restart", "after restart"]);
        expect(repairedBridge.flush()).toBe(true);
        expect(
            store.snapshots
                .get(MAIN)
                ?.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
    });

    it("promotes an interrupted provisional run from a provider session start", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-session-start";
        const providerRunId = "provider-session-start";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "before restart" },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.flush()).toBe(true);

        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "session.started",
            { runId: providerRunId, sessionKey: MAIN },
            []
        );

        const snapshot = restarted.snapshot(MAIN);
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
    });

    it("waits for the chat.send acknowledgment before promoting a live provisional run", () => {
        const provisionalRunId = "dashboard-chat-live-send";
        const providerRunId = "provider-live-send";
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "live work" },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                bridge
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));

        bridge.handleSuccessfulRequest(
            "chat.send",
            { idempotencyKey: provisionalRunId, sessionKey: MAIN },
            { runId: providerRunId }
        );

        const acknowledgedSnapshot = bridge.snapshot(MAIN);
        expect(
            acknowledgedSnapshot.events.map(
                (event) => (event.payload as { runId?: string }).runId
            )
        ).toEqual(
            Array.from(
                { length: acknowledgedSnapshot.events.length },
                () => providerRunId
            )
        );
    });

    it("keeps identical ordered replay across Gateway and Dashboard restarts", () => {
        const provisionalRunId = "dashboard-chat-before-gateway-restart";
        const providerRunId = "provider-after-gateway-restart";
        const disconnectedAt = 1_785_000_000_000;
        const dateNow = jest.spyOn(Date, "now");
        let snapshots: OpenClawRuntimeSnapshot[];
        try {
            snapshots = [false, true].map((shouldRestartDashboard) => {
                const store = new MemorySnapshotStore();
                let bridge = new OpenClawChatBridge(store);
                dateNow.mockReturnValue(disconnectedAt - 1000);
                bridge.recordEvent(
                    "agent",
                    {
                        data: { delta: "thinking before restart" },
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    []
                );
                const steerRequestId = "dashboard-chat-steer-before-restart";
                const steerBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
                bridge.recordEvent(
                    "session.message",
                    {
                        message: { content: "steer before restart", role: "user" },
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.recordEvent(
                    "session.tool",
                    {
                        name: "before-restart",
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.handleSuccessfulRequest(
                    "chat.send",
                    {
                        idempotencyKey: steerRequestId,
                        message: "steer before restart",
                        sessionKey: MAIN,
                    },
                    { runId: provisionalRunId },
                    steerBoundary
                );
                expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
                bridge.markGatewayDisconnected(disconnectedAt);
                if (shouldRestartDashboard) {
                    expect(bridge.flush()).toBe(true);
                    bridge = new OpenClawChatBridge(store);
                }

                dateNow.mockReturnValue(disconnectedAt + 1000);
                bridge.recordEvent(
                    "agent",
                    {
                        data: { phase: "start" },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    []
                );
                bridge.recordEvent(
                    "agent",
                    {
                        data: { delta: "thinking after restart" },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    []
                );
                bridge.recordEvent(
                    "session.message",
                    {
                        message: { content: "steer after restart", role: "user" },
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.recordEvent(
                    "session.tool",
                    {
                        name: "after-steer",
                        runId: providerRunId,
                        sessionKey: MAIN,
                    },
                    []
                );
                return bridge.snapshot(MAIN);
            });
        } finally {
            dateNow.mockRestore();
        }

        expect(snapshots[1]).toEqual(snapshots[0]);
        const snapshot = snapshots[0]!;
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual([
            providerRunId,
            providerRunId,
            providerRunId,
            providerRunId,
            providerRunId,
            undefined,
            providerRunId,
        ]);
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "agent",
            "session.message",
            "session.tool",
            "agent",
            "agent",
            "session.message",
            "session.tool",
        ]);
        expect(
            snapshot.events
                .filter((event) => event.event === "agent")
                .map(
                    (event) =>
                        (event.payload as { data?: { delta?: string } }).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["thinking before restart", "thinking after restart"]);
    });

    it("measures a quiet run's reconnect window from the Gateway disconnect", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-quiet-before-restart";
        const providerRunId = "provider-after-quiet-restart";
        const disconnectedAt = 1_785_000_000_000;
        const providerStartedAt = disconnectedAt + 1000;
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, provisionalRunId, disconnectedAt - 7 * 60 * 60_000)
        );
        const bridge = new OpenClawChatBridge(store);

        bridge.snapshot(MAIN);
        bridge.markGatewayDisconnected(disconnectedAt);
        expect(bridge.flush()).toBe(true);
        expect(store.snapshots.get(MAIN)?.interruptedAtByRun).toEqual({
            [provisionalRunId]: disconnectedAt,
        });
        const restarted = new OpenClawChatBridge(store);
        const dateNow = jest.spyOn(Date, "now").mockReturnValue(providerStartedAt);
        try {
            restarted.recordEvent(
                "agent",
                {
                    data: { phase: "start" },
                    runId: providerRunId,
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
        } finally {
            dateNow.mockRestore();
        }

        expect(
            restarted
                .snapshot(MAIN)
                .events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual([providerRunId, providerRunId]);
    });

    it("does not join an interrupted run across a newer chat send", () => {
        const provisionalRunId = "dashboard-chat-before-reconnect-send";
        const providerRunId = "provider-after-reconnect-send";
        const disconnectedAt = 1_785_000_000_000;
        const bridge = new OpenClawChatBridge();
        const dateNow = jest.spyOn(Date, "now");
        try {
            dateNow.mockReturnValue(disconnectedAt - 1000);
            bridge.recordEvent(
                "agent",
                {
                    data: { delta: "interrupted work" },
                    runId: provisionalRunId,
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
            bridge.markGatewayDisconnected(disconnectedAt);
            const requestBoundary = bridge.captureRequestBoundary(MAIN);
            bridge.recordEvent(
                "agent",
                {
                    data: { delta: "delayed interrupted work" },
                    runId: provisionalRunId,
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );

            dateNow.mockReturnValue(disconnectedAt + 1000);
            bridge.recordEvent(
                "agent",
                {
                    data: { phase: "start" },
                    runId: providerRunId,
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
            bridge.handleSuccessfulRequest(
                "chat.send",
                {
                    idempotencyKey: "dashboard-chat-new-send",
                    message: "new question",
                    sessionKey: MAIN,
                },
                { runId: providerRunId },
                requestBoundary
            );
        } finally {
            dateNow.mockRestore();
        }

        expect(
            new Set(
                bridge
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });

    it("does not promote a hydrated provisional run across a new send boundary", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-before-new-send";
        const providerRunId = "provider-new-send";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "abandoned work" },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        expect(bridge.flush()).toBe(true);

        const restarted = new OpenClawChatBridge(store);
        restarted.captureRequestBoundary(MAIN);
        expect(
            Object.values(store.snapshots.get(MAIN)?.pendingRequestBoundaries || {})
        ).toEqual([1]);
        const afterBoundaryRestart = new OpenClawChatBridge(store);
        afterBoundaryRestart.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                restarted
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId]));
        expect(
            new Set(
                afterBoundaryRestart
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });

    it("keeps overlapping request boundaries isolated after a late steer acknowledgement", () => {
        const store = new MemorySnapshotStore();
        const interruptedRunId = "dashboard-chat-overlapping-run";
        const steerRequestId = "dashboard-chat-overlapping-steer";
        const newRequestId = "dashboard-chat-overlapping-new-turn";
        const providerRunId = "provider-overlapping-new-turn";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "interrupted work" },
                runId: interruptedRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        const requestBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
        expect(bridge.captureRequestBoundary(MAIN, newRequestId)).toBe(requestBoundary);

        bridge.recordEvent(
            "session.message",
            {
                activeRunIds: [interruptedRunId],
                message: {
                    content: "continue the active turn",
                    idempotencyKey: `${steerRequestId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: steerRequestId,
                message: "continue the active turn",
                sessionKey: MAIN,
            },
            {},
            requestBoundary
        );

        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [newRequestId]: requestBoundary,
        });

        bridge.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: newRequestId,
                message: "start a new turn",
                sessionKey: MAIN,
            },
            { runId: providerRunId },
            requestBoundary
        );
        expect(bridge.flush()).toBe(true);

        expect(store.snapshots.get(MAIN)).toMatchObject({
            requestBoundary,
        });
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(
            new Set(
                new OpenClawChatBridge(store)
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([interruptedRunId, providerRunId]));
    });

    it("clears a runless live-steer boundary before reconnecting the active run", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-runless-live-steer";
        const steerRequestId = "dashboard-chat-runless-steer-request";
        const providerRunId = "provider-after-runless-steer";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "before steer" },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: steerRequestId,
                message: "keep going",
                sessionKey: MAIN,
            },
            {},
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();

        bridge.markGatewayDisconnected(Date.now());
        expect(bridge.flush()).toBe(true);
        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        const snapshot = restarted.snapshot(MAIN);
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
    });

    it("uses session message identity instead of timing to assign live steers", () => {
        const bridge = new OpenClawChatBridge();
        const providerRunId = "provider-active";
        const provisionalRunId = "dashboard-chat-current-steer";
        const liveSteer = bridge.recordEvent(
            "session.message",
            {
                activeRunIds: [providerRunId, "dashboard-chat-stale"],
                message: {
                    content: "steer",
                    idempotencyKey: `${provisionalRunId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        const newTurn = bridge.recordEvent(
            "session.message",
            {
                activeRunIds: ["dashboard-chat-stale"],
                message: {
                    content: "new turn",
                    idempotencyKey: `${provisionalRunId}:user`,
                    role: "user",
                },
                sessionKey: "agent:main:other",
            },
            []
        );

        expect(liveSteer.payload).toMatchObject({ runId: providerRunId });
        expect(newTurn.payload).toMatchObject({ runId: provisionalRunId });
    });

    it("preserves a short-key send boundary after session canonicalization", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-short-key-send";
        const providerRunId = "provider-after-canonicalization";
        store.snapshots.set(
            "main",
            persistedSnapshot("main", provisionalRunId, Date.now())
        );
        const restarted = new OpenClawChatBridge(store);

        restarted.captureRequestBoundary("main");
        restarted.reconcileSessions([{ id: "main", key: MAIN }]);
        restarted.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                restarted
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });

    it("captures a canonical send boundary for an active short-key alias", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-short-key-alias-send";
        const requestId = "dashboard-chat-canonical-alias-request";
        const providerRunId = "provider-short-key-alias-send";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "short-key work" },
                runId: provisionalRunId,
                sessionKey: "main",
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());

        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        expect(store.snapshots.get("main")?.pendingRequestBoundaries).toEqual({
            [requestId]: requestBoundary,
        });

        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: "main",
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                restarted
                    .snapshot("main")
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });

    it("repairs an interrupted run split across persisted session aliases", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-short-key-restart";
        const providerRunId = "provider-canonical-restart";
        const now = Date.now();
        const providerSnapshot = persistedSnapshot(
            MAIN,
            providerRunId,
            now,
            undefined,
            3
        );
        providerSnapshot.events[0]!.payload = {
            data: { phase: "start" },
            runId: providerRunId,
            sessionKey: MAIN,
            stream: "lifecycle",
        };
        store.snapshots.set(MAIN, providerSnapshot);
        store.snapshots.set("main", {
            completed: false,
            events: [
                {
                    event: "agent",
                    payload: {
                        runId: provisionalRunId,
                        sessionKey: "main",
                        stream: "thinking",
                    },
                    runtimeRecordedAt: now - 2,
                    runtimeSequence: 1,
                    type: "event",
                },
                {
                    event: "chat",
                    payload: {
                        message: "older completed work",
                        runId: "completed-short-key-run",
                        sessionKey: "main",
                        state: "final",
                    },
                    runtimeRecordedAt: now - 1,
                    runtimeSequence: 2,
                    type: "event",
                },
            ],
            throughSequence: 2,
        });
        const restarted = new OpenClawChatBridge(store);

        restarted.hydratePersistedSessions();
        restarted.reconcileSessions([{ id: "main", key: MAIN }]);

        const snapshot = restarted.snapshot(MAIN);
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
        expect(store.snapshots.has("main")).toBe(false);
        expect(
            store.snapshots
                .get(MAIN)
                ?.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
        expect(
            restarted.recordEvent(
                "agent",
                { runId: provisionalRunId, stream: "thinking" },
                []
            ).payload
        ).not.toHaveProperty("sessionKey");
    });

    it("repairs an interrupted alias when the provider run starts before canonicalization", () => {
        const provisionalRunId = "dashboard-chat-live-short-key-restart";
        const providerRunId = "provider-live-canonical-restart";
        const disconnectedAt = 1_785_000_000_000;
        const bridge = new OpenClawChatBridge();
        const dateNow = jest.spyOn(Date, "now");
        try {
            dateNow.mockReturnValue(disconnectedAt - 1000);
            bridge.recordEvent(
                "agent",
                {
                    data: { delta: "thinking before restart" },
                    runId: provisionalRunId,
                    sessionKey: "main",
                    stream: "thinking",
                },
                []
            );
            bridge.markGatewayDisconnected(disconnectedAt);

            dateNow.mockReturnValue(disconnectedAt + 1000);
            bridge.recordEvent(
                "agent",
                {
                    data: { phase: "start" },
                    runId: providerRunId,
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
        } finally {
            dateNow.mockRestore();
        }

        bridge.reconcileSessions([{ id: "main", key: MAIN }]);

        const snapshot = bridge.snapshot(MAIN);
        expect(
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
        ).toEqual(Array.from({ length: snapshot.events.length }, () => providerRunId));
    });

    it("keeps concurrent persisted alias runs separate from a provider run", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunIds = [
            "dashboard-chat-short-key-first",
            "dashboard-chat-short-key-second",
        ];
        const providerRunId = "provider-canonical-concurrent";
        const now = Date.now();
        const providerSnapshot = persistedSnapshot(
            MAIN,
            providerRunId,
            now,
            undefined,
            3
        );
        providerSnapshot.events[0]!.payload = {
            data: { phase: "start" },
            runId: providerRunId,
            sessionKey: MAIN,
            stream: "lifecycle",
        };
        store.snapshots.set(MAIN, providerSnapshot);
        store.snapshots.set("main", {
            completed: false,
            events: provisionalRunIds.map((runId, index) => ({
                event: "agent",
                payload: { runId, sessionKey: "main", stream: "thinking" },
                runtimeRecordedAt: now - 2 + index,
                runtimeSequence: index + 1,
                type: "event" as const,
            })),
            throughSequence: 2,
        });
        const restarted = new OpenClawChatBridge(store);

        restarted.hydratePersistedSessions();
        restarted.reconcileSessions([{ id: "main", key: MAIN }]);

        expect(
            new Set(
                restarted
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([...provisionalRunIds, providerRunId]));
    });

    it("does not promote a provisional run long after an interrupted restart", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-stale-interruption";
        const providerRunId = "provider-much-later";
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, provisionalRunId, Date.now() - 30 * 60_000)
        );

        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                restarted
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });

    it("keeps concurrent provisional chat runs separate from a new provider run", () => {
        const bridge = new OpenClawChatBridge();
        const provisionalRunIds = ["dashboard-chat-first", "dashboard-chat-second"];
        for (const runId of provisionalRunIds) {
            bridge.recordEvent(
                "agent",
                {
                    data: { phase: "start" },
                    runId,
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
        }

        bridge.recordEvent(
            "agent",
            {
                data: { phase: "start" },
                runId: "provider-concurrent",
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        expect(
            new Set(
                bridge
                    .snapshot(MAIN)
                    .events.map((event) => (event.payload as { runId?: string }).runId)
            )
        ).toEqual(new Set([...provisionalRunIds, "provider-concurrent"]));
    });

    it("rewrites nested run identities when a provisional run is promoted", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "nested reasoning",
                    runId: "dashboard-chat-nested",
                    sessionKey: MAIN,
                    stream: "thinking",
                },
            },
            []
        );

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-nested",
                message: "question",
                sessionKey: MAIN,
            },
            { runId: "provider-nested" }
        );
        expect(bridge.flush()).toBe(true);

        expect(
            new OpenClawChatBridge(store).snapshot(MAIN).events[0]?.payload
        ).toMatchObject({
            data: { runId: "provider-nested", sessionKey: MAIN },
            runId: "provider-nested",
            sessionKey: MAIN,
        });
    });

    it("selects completed replay by terminal order after delayed older events", () => {
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
            "session.message",
            {
                content: "old answer",
                role: "assistant",
                runId: "old-run",
                sessionKey: MAIN,
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            { content: "new answer", role: "assistant", sessionKey: MAIN },
            []
        );

        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                event: "chat",
                payload: expect.objectContaining({
                    message: "new answer",
                    runId: "new-run",
                }),
            }),
            expect.objectContaining({
                event: "session.message",
                payload: expect.objectContaining({ content: "new answer" }),
            }),
        ]);
    });

    it("clears replay data after abort, delete and reset acknowledgements", () => {
        const bridge = new OpenClawChatBridge();
        const retain = () =>
            bridge.recordEvent(
                "agent",
                { runId: crypto.randomUUID(), sessionKey: MAIN, stream: "thinking" },
                []
            );

        retain();
        bridge.handleSuccessfulRequest("chat.abort", { sessionKey: MAIN }, {});
        expect(bridge.snapshot(MAIN).events).toEqual([]);

        retain();
        bridge.handleSuccessfulRequest("sessions.delete", { key: MAIN }, {});
        expect(bridge.snapshot(MAIN).events).toEqual([]);

        retain();
        bridge.handleSuccessfulRequest(
            "chat.send",
            { message: "/reset now", sessionKey: MAIN },
            {}
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
    });

    it("does not replay an older completed turn after a new send starts", () => {
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

        bridge.handleSuccessfulRequest(
            "chat.send",
            { message: "next question", sessionKey: MAIN },
            { runId: "new-run" }
        );

        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(
            bridge.recordEvent("agent", { runId: "new-run", stream: "thinking" }, [])
                .payload
        ).toMatchObject({ sessionKey: MAIN });
        expect(
            bridge.recordEvent("agent", { runId: "old-run", stream: "thinking" }, [])
                .payload
        ).not.toHaveProperty("sessionKey");
    });

    it("retains a completed provisional run when its acknowledgement arrives later", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "fast answer",
                runId: "dashboard-chat-fast",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-fast",
                message: "fast question",
                sessionKey: MAIN,
            },
            { runId: "provider-fast" }
        );

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        message: "fast answer",
                        runId: "provider-fast",
                    }),
                }),
            ],
        });
        expect(
            bridge.recordEvent(
                "agent",
                { runId: "provider-fast", stream: "thinking" },
                []
            ).payload
        ).toMatchObject({ sessionKey: MAIN });
    });

    it("promotes an explicit non-dashboard idempotency run on acknowledgement", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "chat",
            {
                message: "notification delivered",
                runId: "tasks-notify-123",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "tasks-notify-123",
                message: "notify",
                sessionKey: MAIN,
            },
            { runId: "provider-notify-123" }
        );

        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "notification delivered",
                runId: "provider-notify-123",
                state: "final",
            }),
        ]);
    });

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
            { runId: "provider-notify-early" }
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
            { runId: "provider-runless-final" },
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
                {
                    event: "chat",
                    payload: {
                        message: "persisted old answer",
                        sessionKey: MAIN,
                        state: "final",
                    },
                    runtimeRecordedAt: Date.now() - 1000,
                    runtimeSequence: 7,
                    type: "event",
                },
            ],
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
            { runId: "provider-new" },
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
                { runId: "dashboard-chat-runless-only", stream: "thinking" },
                []
            ).payload
        ).toMatchObject({ sessionKey: MAIN });
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
            { runId: "provider-new" },
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
                data: { delta: "runless" },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        runlessBridge.handleSuccessfulRequest(
            "chat.send",
            { message: "question", sessionKey: MAIN },
            { runId: "provider-runless" }
        );
        expect(payloads(runlessBridge)).toEqual([
            expect.objectContaining({ runId: "provider-runless" }),
        ]);
    });

    it("keeps an explicit provider replay separate until send acknowledgement", () => {
        const activeBridge = new OpenClawChatBridge();
        activeBridge.recordEvent(
            "agent",
            {
                data: { delta: "provisional" },
                runId: "dashboard-chat-active",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        activeBridge.recordEvent(
            "agent",
            {
                data: { delta: "provider" },
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
            { runId: "provider-active" }
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
                { runId, sessionKey: MAIN, stream: "thinking" },
                []
            );
        }
        const requestBoundary = bridge.captureRequestBoundary();
        bridge.recordEvent(
            "agent",
            { data: { delta: "first" }, sessionKey: MAIN, stream: "thinking" },
            []
        );
        bridge.recordEvent(
            "agent",
            { data: { delta: "second" }, sessionKey: MAIN, stream: "thinking" },
            []
        );
        bridge.recordEvent(
            "agent",
            { runId: "provider-run", sessionKey: MAIN, stream: "thinking" },
            []
        );

        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: "dashboard-chat-grouped",
                message: "question",
                sessionKey: MAIN,
            },
            { runId: "provider-run" },
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
                data: { delta: "provider tail" },
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
            { runId: "provider-completed" }
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
            { runId: "provider-new" }
        );

        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(
            bridge.recordEvent("agent", { runId: "provider-new", stream: "thinking" }, [])
                .payload
        ).toMatchObject({ runId: "provider-new", sessionKey: MAIN });
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
                data: { delta: "new reasoning" },
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
            { runId: "provider-new" },
            requestBoundary
        );

        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: { delta: "new reasoning" },
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
                    content: [{ text: "done", type: "text" }],
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
                expect.objectContaining({ event: "chat" }),
                expect.objectContaining({ event: "session.message" }),
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
                        { thinking: "inspect repository", type: "thinking" },
                        {
                            arguments: { command: "pwd" },
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
                        { thinking: "report result", type: "thinking" },
                        { text: "SYNTHETIC_OK", type: "text" },
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
                    payload: expect.objectContaining({ runId: "synthetic-run" }),
                }),
                expect.objectContaining({
                    payload: expect.objectContaining({ runId: "synthetic-run" }),
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

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: true,
            events: [
                expect.objectContaining({
                    event: "session.message",
                    payload: expect.objectContaining({
                        role: "assistant",
                        runId: "large-synthetic-run",
                        sessionKey: MAIN,
                        stopReason: "stop",
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
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
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
        bridge.recordEvent("session.ended", { status: "completed" }, []);
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
            snapshot.events.map((event) => (event.payload as { runId?: string }).runId)
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
            payload: { runId: "provider-run" },
        });
        expect(snapshot.events[1]).toMatchObject({
            event: "chat",
            payload: { runId: "provider-run" },
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
            payload: { runId: "nested-provider-run" },
        });
        expect(snapshot.events[1]).toMatchObject({
            event: "chat",
            payload: { runId: "nested-provider-run" },
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
                data: { error: "new failure", phase: "error" },
                runId: "newer-run",
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            { content: "OK", role: "assistant", sessionKey: MAIN },
            []
        );

        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [expect.objectContaining({ event: "session.message" })],
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
                data: { delta: "new work" },
                runId: "active-run",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "session.message",
            { content: "OK", role: "assistant", sessionKey: MAIN },
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
                data: { delta: "old work" },
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
            { runId: "provider-new" },
            requestBoundary
        );

        expect(payloads(bridge)).toEqual([
            expect.objectContaining({ runId: "dashboard-chat-old" }),
        ]);
        expect(
            bridge.recordEvent("agent", { runId: "provider-new", stream: "thinking" }, [])
                .payload
        ).toMatchObject({ runId: "provider-new", sessionKey: MAIN });
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
                data: { delta: "new reasoning" },
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: { error: "new failure", phase: "error" },
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.events.map((event) => event.event)).toEqual(["agent", "agent"]);
        expect(payloads(bridge).at(-1)).toMatchObject({
            data: { error: "new failure", phase: "error" },
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
            { data: { phase: "error" }, sessionKey: MAIN },
            []
        );

        expect(bridge.snapshot(MAIN).events).toEqual([
            expect.objectContaining({
                event: "session.ended",
                payload: expect.objectContaining({
                    data: { phase: "error" },
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
            events: [expect.objectContaining({ event: "agent" })],
        });
    });

    it("learns a run association from explicitly scoped runtime events", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            { runId: "external-run", sessionKey: MAIN, stream: "thinking" },
            []
        );

        expect(
            bridge.recordEvent("agent", { runId: "external-run", stream: "thinking" }, [])
                .payload
        ).toMatchObject({ runId: "external-run", sessionKey: MAIN });
    });

    it("learns explicit associations even when the scoped payload is too large to retain", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: { delta: "x".repeat(1_000_001) },
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
                { runId: "large-external-run", stream: "thinking" },
                []
            ).payload
        ).toMatchObject({ runId: "large-external-run", sessionKey: MAIN });
    });

    it("retains multi-thousand-event runs and drops oversized individual payloads", () => {
        const bridge = new OpenClawChatBridge();
        for (let index = 0; index < 4400; index += 1) {
            bridge.recordEvent(
                "agent",
                {
                    data: { delta: String(index) },
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
                data: { delta: "x".repeat(1_000_001) },
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
            data: { state: "final" },
            runId: "nested-large-run",
            sessionKey: MAIN,
            state: "final",
        });

        bridge.clear();
        bridge.recordEvent(
            "session.ended",
            {
                data: { detail: "x".repeat(1_000_001), status: "aborted" },
                runId: "large-aborted-run",
                sessionKey: MAIN,
            },
            []
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                data: expect.objectContaining({ status: "aborted" }),
                runId: "large-aborted-run",
                sessionKey: MAIN,
            }),
        ]);

        bridge.clear();
        bridge.recordEvent(
            "session.compaction",
            {
                data: { detail: "x".repeat(1_000_001) },
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
