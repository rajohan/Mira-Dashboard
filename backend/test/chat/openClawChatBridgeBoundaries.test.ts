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
describe("OpenClaw chat bridge request boundaries", () => {
    it("rejects more pending request boundaries than snapshots can restore", () => {
        const bridge = new OpenClawChatBridge(new MemorySnapshotStore());
        bridge.recordEvent(
            "agent",
            {
                runId: "dashboard-chat-boundary-limit",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        for (let index = 0; index < 100; index += 1) {
            bridge.captureRequestBoundary(MAIN, `dashboard-chat-pending-${index}`);
        }
        expect(() =>
            bridge.captureRequestBoundary(MAIN, "dashboard-chat-pending-overflow")
        ).toThrow("Too many pending chat requests for one session");
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
                data: {
                    delta: "interrupted work",
                },
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
                data: {
                    phase: "start",
                },
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
            {
                runId: providerRunId,
            },
            requestBoundary
        );
        expect(bridge.flush()).toBe(true);
        expect(store.snapshots.get(MAIN)).toMatchObject({
            requestBoundary,
        });
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(
            new Set(
                new OpenClawChatBridge(store).snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
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
                data: {
                    delta: "before steer",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
        const steerEcho = bridge.recordEvent(
            "session.message",
            {
                activeRunIds: [provisionalRunId],
                message: {
                    content: "keep going",
                    idempotencyKey: `${steerRequestId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(steerEcho.payload).toMatchObject({
            runId: provisionalRunId,
        });
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
                data: {
                    phase: "start",
                },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        const snapshot = restarted.snapshot(MAIN);
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
    });
    it("repairs a resumed provider run that starts before a runless steer ack", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-pre-ack-live-steer";
        const steerRequestId = "dashboard-chat-pre-ack-steer-request";
        const providerRunId = "provider-before-runless-steer-ack";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "before steer",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        const requestBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
        bridge.recordEvent(
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
        ).toEqual(new Set([provisionalRunId, providerRunId]));
        const throughSequenceBeforeIdentity = bridge.snapshot(MAIN).throughSequence;
        const identityEnvelope = bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: steerRequestId,
                message: "keep going",
                sessionKey: MAIN,
            },
            {},
            requestBoundary
        );
        expect(identityEnvelope).toMatchObject({
            payload: {
                runId: providerRunId,
                sessionKey: MAIN,
            },
            runtimeRunAliases: [provisionalRunId],
        });
        expect(identityEnvelope?.runtimeSequence).toBeGreaterThan(
            throughSequenceBeforeIdentity
        );
        const repaired = bridge.snapshot(MAIN);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(
            repaired.events.map(
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
                    length: repaired.events.length,
                },
                () => providerRunId
            )
        );
    });
    it("repairs an interrupted provider run when its continuation stays provisional", () => {
        const store = new MemorySnapshotStore();
        const interruptedRunId = "provider-before-provisional-continuation";
        const continuationRequestId = "dashboard-chat-provisional-continuation";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "before restart",
                },
                runId: interruptedRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        bridge.captureRequestBoundary(MAIN, continuationRequestId);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                },
                runId: continuationRequestId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        const userEcho = bridge.recordEvent(
            "session.message",
            {
                activeRunIds: [continuationRequestId],
                message: {
                    content: "continue after restart",
                    idempotencyKey: `${continuationRequestId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(userEcho.runtimeRunAliases).toEqual([interruptedRunId]);
        const repaired = bridge.snapshot(MAIN);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(
            repaired.events.map(
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
                    length: repaired.events.length,
                },
                () => continuationRequestId
            )
        );
        expect(
            repaired.events
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
        ).toEqual(["before restart"]);
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
        expect(liveSteer.payload).toMatchObject({
            runId: providerRunId,
        });
        expect(newTurn.payload).toMatchObject({
            runId: provisionalRunId,
        });
    });
    it("reads a top-level idempotency key from a user session echo", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        const requestId = "dashboard-chat-top-level-user-echo";
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "older active work",
                },
                runId: "dashboard-chat-before-top-level-user-echo",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        const userEcho = bridge.recordEvent(
            "session.message",
            {
                content: "start a new request",
                idempotencyKey: `${requestId}:user`,
                role: "user",
                sessionKey: MAIN,
            },
            []
        );
        expect(userEcho.payload).toMatchObject({
            runId: requestId,
        });
        expect(store.snapshots.get(MAIN)).toMatchObject({
            requestBoundary,
        });
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
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
        restarted.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
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
        expect(
            new Set(
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
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
                data: {
                    delta: "short-key work",
                },
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
                data: {
                    phase: "start",
                },
                runId: providerRunId,
                sessionKey: "main",
                stream: "lifecycle",
            },
            []
        );
        expect(
            new Set(
                restarted.snapshot("main").events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });
    it("protects an active alias when the exact replay is already completed", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-active-short-alias";
        const requestId = "dashboard-chat-canonical-over-completed-request";
        const providerRunId = "provider-after-completed-exact-replay";
        const now = Date.now();
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "completed-canonical-run", now - 2, "final", 1)
        );
        const activeAlias = persistedSnapshot("main", provisionalRunId, now - 1);
        activeAlias.interruptedAtByRun = {
            [provisionalRunId]: now,
        };
        store.snapshots.set("main", activeAlias);
        const bridge = new OpenClawChatBridge(store);
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(store.snapshots.get("main")?.pendingRequestBoundaries).toEqual({
            [requestId]: requestBoundary,
        });
        const restarted = new OpenClawChatBridge(store);
        restarted.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                },
                runId: providerRunId,
                sessionKey: "main",
                stream: "lifecycle",
            },
            []
        );
        expect(
            new Set(
                restarted.snapshot("main").events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });
    it("persists a run start sequence across tool-event coalescing", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-coalesced-before-boundary";
        const requestId = "dashboard-chat-after-coalesced-tool";
        const providerRunId = "provider-after-coalesced-tool";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    stream: "tool",
                    toolCallId: "coalesced-tool",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "update",
                    stream: "tool",
                    toolCallId: "coalesced-tool",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
            },
            []
        );
        expect(bridge.flush()).toBe(true);
        const persisted = store.snapshots.get(MAIN)!;
        expect(persisted.events[0]?.runtimeSequence).toBeGreaterThan(requestBoundary);
        expect(persisted.firstSequenceByRun).toEqual({
            [provisionalRunId]: requestBoundary,
        });
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
        expect(
            new Set(
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });
    it("merges restored alias boundaries before interrupted-run recovery", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-between-alias-boundaries";
        const providerRunId = "provider-after-alias-boundary-merge";
        const now = Date.now();
        store.snapshots.set(MAIN, {
            completed: false,
            events: [
                runtimeEnvelope(
                    15,
                    "agent",
                    {
                        runId: provisionalRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    now - 1
                ),
            ],
            interruptedAtByRun: {
                [provisionalRunId]: now,
            },
            pendingRequestBoundaries: {
                "dashboard-chat-newer-alias-request": 20,
            },
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 20,
        });
        store.snapshots.set("main", {
            completed: true,
            events: [
                runtimeEnvelope(
                    10,
                    "chat",
                    {
                        message: "older alias answer",
                        runId: "older-alias-run",
                        sessionKey: "main",
                        state: "final",
                    },
                    now - 2
                ),
            ],
            requestBoundary: 10,
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 10,
        });
        const restarted = new OpenClawChatBridge(store);
        restarted.hydratePersistedSessions();
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
        expect(
            new Set(
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            )
        ).toEqual(new Set([provisionalRunId, providerRunId]));
    });
    it("flushes the original boundary owner after a later alias hydrates", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-canonical-boundary-owner";
        const steerRequestId = "dashboard-chat-owner-preserving-steer";
        const providerRunId = "provider-after-owner-preserving-steer";
        store.snapshots.set(MAIN, persistedSnapshot(MAIN, provisionalRunId));
        store.snapshots.set(
            "main",
            persistedSnapshot(
                "main",
                "completed-short-key-before-steer",
                Date.now() - 1,
                "final",
                2
            )
        );
        const bridge = new OpenClawChatBridge(store);
        const requestBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
        bridge.snapshot("main");
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: steerRequestId,
                message: "continue",
                sessionKey: MAIN,
            },
            {
                runId: provisionalRunId,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        bridge.markGatewayDisconnected(Date.now());
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
        const snapshot = restarted.snapshot(MAIN);
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
    });
    it("classifies duplicate active alias copies as one runless steer", () => {
        const store = new MemorySnapshotStore();
        const activeRunId = "provider-shared-across-aliases";
        const requestId = "dashboard-chat-shared-alias-steer";
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, activeRunId, Date.now(), undefined, 2)
        );
        const shortAlias = persistedSnapshot(
            "main",
            activeRunId,
            Date.now() - 1,
            undefined,
            1
        );
        shortAlias.requestBoundary = 2;
        store.snapshots.set("main", shortAlias);
        const bridge = new OpenClawChatBridge(store);
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: requestId,
                message: "continue",
                sessionKey: MAIN,
            },
            {},
            requestBoundary
        );
        expect(bridge.flush()).toBe(true);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        expect(store.snapshots.get("main")?.pendingRequestBoundaries).toBeUndefined();
        expect(store.snapshots.get("main")?.requestBoundary).toBeUndefined();
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
            data: {
                phase: "start",
            },
            runId: providerRunId,
            sessionKey: MAIN,
            stream: "lifecycle",
        };
        store.snapshots.set(MAIN, providerSnapshot);
        store.snapshots.set("main", {
            completed: false,
            events: [
                runtimeEnvelope(
                    1,
                    "agent",
                    {
                        runId: provisionalRunId,
                        sessionKey: "main",
                        stream: "thinking",
                    },
                    now - 2
                ),
                runtimeEnvelope(
                    2,
                    "chat",
                    {
                        message: "older completed work",
                        runId: "completed-short-key-run",
                        sessionKey: "main",
                        state: "final",
                    },
                    now - 1
                ),
            ],
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 2,
        });
        const restarted = new OpenClawChatBridge(store);
        restarted.hydratePersistedSessions();
        restarted.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        const snapshot = restarted.snapshot(MAIN);
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
        expect(store.snapshots.has("main")).toBe(false);
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
        expect(
            restarted.recordEvent(
                "agent",
                {
                    runId: provisionalRunId,
                    stream: "thinking",
                },
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
                    data: {
                        delta: "thinking before restart",
                    },
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
                    data: {
                        phase: "start",
                    },
                    runId: providerRunId,
                    sessionKey: MAIN,
                    stream: "lifecycle",
                },
                []
            );
        } finally {
            dateNow.mockRestore();
        }
        bridge.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        const snapshot = bridge.snapshot(MAIN);
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
            data: {
                phase: "start",
            },
            runId: providerRunId,
            sessionKey: MAIN,
            stream: "lifecycle",
        };
        store.snapshots.set(MAIN, providerSnapshot);
        store.snapshots.set("main", {
            completed: false,
            events: provisionalRunIds.map((runId, index) =>
                runtimeEnvelope(
                    index + 1,
                    "agent",
                    {
                        runId,
                        sessionKey: "main",
                        stream: "thinking",
                    },
                    now - 2 + index
                )
            ),
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 2,
        });
        const restarted = new OpenClawChatBridge(store);
        restarted.hydratePersistedSessions();
        restarted.reconcileSessions([
            {
                id: "main",
                key: MAIN,
            },
        ]);
        expect(
            new Set(
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
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
                data: {
                    phase: "start",
                },
                runId: providerRunId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        expect(
            new Set(
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
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
                    data: {
                        phase: "start",
                    },
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
                data: {
                    phase: "start",
                },
                runId: "provider-concurrent",
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
            {
                runId: "provider-nested",
            }
        );
        expect(bridge.flush()).toBe(true);
        const restored = new OpenClawChatBridge(store).snapshot(MAIN).events[0]!;
        expect(restored.payload).toMatchObject({
            data: {
                runId: "provider-nested",
                sessionKey: MAIN,
            },
            runId: "provider-nested",
            sessionKey: MAIN,
        });
        expect(restored.canonicalEvents).toEqual([
            expect.objectContaining({
                kind: "status",
                runId: "provider-nested",
                sessionKey: MAIN,
            }),
            expect.objectContaining({
                kind: "thinking",
                message: expect.objectContaining({
                    runId: "provider-nested",
                    thinking: [
                        {
                            snapshot: false,
                            text: "nested reasoning",
                        },
                    ],
                }),
                runId: "provider-nested",
                sessionKey: MAIN,
            }),
        ]);
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
            {
                content: "new answer",
                role: "assistant",
                sessionKey: MAIN,
            },
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
                payload: expect.objectContaining({
                    content: "new answer",
                }),
            }),
        ]);
    });
    it("clears replay data after abort, delete and reset acknowledgements", () => {
        const bridge = new OpenClawChatBridge();
        const retain = () =>
            bridge.recordEvent(
                "agent",
                {
                    runId: crypto.randomUUID(),
                    sessionKey: MAIN,
                    stream: "thinking",
                },
                []
            );
        retain();
        bridge.handleSuccessfulRequest(
            "chat.abort",
            {
                sessionKey: MAIN,
            },
            {}
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        retain();
        bridge.handleSuccessfulRequest(
            "sessions.delete",
            {
                key: MAIN,
            },
            {}
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        retain();
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                message: "/reset now",
                sessionKey: MAIN,
            },
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
            {
                message: "next question",
                sessionKey: MAIN,
            },
            {
                runId: "new-run",
            }
        );
        expect(bridge.snapshot(MAIN).events).toEqual([]);
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "new-run",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            sessionKey: MAIN,
        });
        expect(
            bridge.recordEvent(
                "agent",
                {
                    runId: "old-run",
                    stream: "thinking",
                },
                []
            ).payload
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
            {
                runId: "provider-fast",
            }
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
                {
                    runId: "provider-fast",
                    stream: "thinking",
                },
                []
            ).payload
        ).toMatchObject({
            sessionKey: MAIN,
        });
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
            {
                runId: "provider-notify-123",
            }
        );
        expect(payloads(bridge)).toEqual([
            expect.objectContaining({
                message: "notification delivered",
                runId: "provider-notify-123",
                state: "final",
            }),
        ]);
    });
});
