import { describe, expect, it, jest } from "bun:test";

import { MAX_CANONICAL_TOOL_RESULT_CHARACTERS } from "../../../contracts/chat/canonicalUtilities.ts";
import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat/transport.ts";
import { OpenClawChatBridge } from "../../src/services/chat/openClawChatBridge.ts";
import type { OpenClawChatSnapshotStore } from "../../src/services/chat/openClawChatPersistence.ts";
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
describe("OpenClaw chat bridge retention", () => {
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
            {
                runId: "next-run",
            },
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
                data: {
                    delta: "working",
                },
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
            {
                runId: "active-run",
            },
            bridge.captureRequestBoundary()
        );
        const steer = bridge.recordEvent(
            "session.message",
            {
                message: {
                    content: "steer",
                    role: "user",
                },
                sessionKey: MAIN,
            },
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
            {
                message: "done",
                runId: "run-1",
                sessionKey: MAIN,
                state: "final",
            },
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
                data: {
                    delta: "working",
                },
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
                data: {
                    delta: "working",
                },
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
            data: {
                runId: "run-1",
                sessionKey: MAIN,
            },
            runId: "run-1",
            sessionKey: MAIN,
        });
        expect(store.snapshots.has("main")).toBe(false);
        expect(store.snapshots.has(MAIN)).toBe(true);
        expect(
            new OpenClawChatBridge(store).snapshot(MAIN).events[0]?.payload
        ).toMatchObject({
            data: {
                runId: "run-1",
                sessionKey: MAIN,
            },
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
                data: {
                    delta: "continued",
                },
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
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
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
            bridge.reconcileSessions([
                {
                    id: "main",
                    key: MAIN,
                },
            ]);
            expect(store.snapshots.get("main")?.events).toHaveLength(1);
            expect(store.snapshots.get(MAIN)?.events).toHaveLength(1);
            expect(bridge.snapshot("main").events).toHaveLength(1);
            bridge.reconcileSessions([
                {
                    id: "main",
                    key: MAIN,
                },
            ]);
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
                {
                    runId: "next-run",
                },
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
                    data: {
                        delta: "new run",
                    },
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
        expect(bridge.getMetrics().replay.sessionEvictions).toBe(1);
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
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [],
        });
        expect(store.snapshots.has(MAIN)).toBe(false);
    });
    it("deletes an expired persisted alias requested through its canonical key", () => {
        const store = new MemorySnapshotStore();
        store.snapshots.set(
            "main",
            persistedSnapshot("main", "stale-run", Date.now() - 6 * 60 * 60_000 - 1)
        );
        const bridge = new OpenClawChatBridge(store);
        expect(bridge.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [],
        });
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
                    payload: expect.objectContaining({
                        runId: "completed-run",
                    }),
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
            {
                runId: "next-run",
            },
            bridge.captureRequestBoundary(MAIN)
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
    });
    it("retains run activity while coalescing full item progress snapshots", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            {
                runId: "long-run",
                sessionKey: MAIN,
            },
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
            data: {
                progressText: "Working 599",
            },
        });
    });
    it("stores one replay event per visible native tool bubble", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.started",
            {
                runId: "tool-run",
                sessionKey: MAIN,
            },
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
                    args: {
                        command: "true",
                    },
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
                    result: {
                        exitCode: 0,
                        status: "completed",
                    },
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
                args: {
                    command: "true",
                },
                phase: "result",
                result: {
                    exitCode: 0,
                    status: "completed",
                },
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
                    args: {
                        command: "true",
                    },
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
                    result: {
                        exitCode: 0,
                        status: "completed",
                    },
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
        expect(snapshot.events[0]).toMatchObject({
            event: "agent",
        });
        expect(snapshot.events[0]?.payload).toMatchObject({
            data: {
                args: {
                    command: "true",
                },
                phase: "result",
                result: {
                    exitCode: 0,
                    status: "completed",
                },
                toolCallId: "call-1",
            },
        });
    });
    it("bounds compacted tool-call arguments while preserving a later result", () => {
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "session.tool",
            {
                args: {
                    input: "x".repeat(600_000),
                },
                phase: "start",
                runId: "large-tool-run",
                sessionKey: MAIN,
                toolCallId: "large-call",
                toolName: "large-tool",
            },
            []
        );
        bridge.recordEvent(
            "session.tool",
            {
                phase: "result",
                result: "done",
                runId: "large-tool-run",
                sessionKey: MAIN,
                toolCallId: "large-call",
                toolName: "large-tool",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.events).toHaveLength(1);
        const toolEvents = snapshot.events[0]!.canonicalEvents.filter(
            (event) => event.kind === "tool"
        );
        const compactedArguments = toolEvents.find(
            (event) => event.message.toolCalls?.[0]?.arguments !== undefined
        )?.message.toolCalls?.[0]?.arguments;
        const serializedArguments = JSON.stringify(compactedArguments);
        if (serializedArguments === undefined) {
            throw new Error("Compacted tool fixture is missing its arguments");
        }
        expect(serializedArguments.length).toBeLessThan(
            MAX_CANONICAL_TOOL_RESULT_CHARACTERS + 100
        );
        expect(serializedArguments).toContain("[truncated by Dashboard]");
        expect(
            toolEvents.some(
                (event) =>
                    event.message.toolResult?.content === "done" ||
                    event.message.toolCalls?.[0]?.toolResult?.content === "done"
            )
        ).toBe(true);
    });
    it("retains compacted item thinking from the original provider payload", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        const progressText = "thinking ".repeat(75_000);
        const thinking = bridge.recordEvent(
            "agent",
            {
                data: {
                    itemId: "thinking-large",
                    kind: "reasoning",
                    phase: "start",
                    progressText,
                },
                runId: "large-thinking-run",
                sessionKey: MAIN,
                stream: "item",
            },
            []
        );
        expect(
            (
                thinking.payload as {
                    data?: {
                        progressText?: string;
                    };
                }
            ).data?.progressText
        ).toBeUndefined();
        expect(
            thinking.canonicalEvents.find((event) => event.kind === "thinking")
        ).toMatchObject({
            message: {
                thinking: [
                    {
                        text: progressText,
                    },
                ],
            },
        });
        expect(bridge.snapshot(MAIN).events).toEqual([thinking]);
        expect(bridge.flush()).toBe(true);
        expect(new OpenClawChatBridge(store).snapshot(MAIN).events).toEqual([thinking]);
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
                        arguments: {
                            command: "true",
                        },
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
        bridge.recordEvent(
            "session.started",
            {
                sessionKey: MAIN,
            },
            []
        );
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
                data: {
                    phase: "started",
                },
                runId: "run-1",
                sessionKey: MAIN,
                stream: "codex_app_server.hook",
            },
            []
        );
        const retained = bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "reasoning",
                },
                runId: "run-1",
                stream: "thinking",
            },
            []
        );
        expect(ignored.runtimeSequence).toBe(1);
        expect(retained.runtimeSequence).toBe(2);
        expect(retained.payload).toMatchObject({
            sessionKey: MAIN,
        });
        expect(bridge.snapshot(MAIN).events).toEqual([retained]);
    });
});
