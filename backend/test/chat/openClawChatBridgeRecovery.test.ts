import { describe, expect, it, jest } from "bun:test";

import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat/transport.ts";
import { OpenClawChatBridge } from "../../src/services/chat/openClawChatBridge.ts";
import type { OpenClawChatSnapshotStore } from "../../src/services/chat/openClawChatPersistence.ts";
import { OpenClawChatRequestBoundaries } from "../../src/services/chat/openClawChatRequestBoundaries.ts";
const MAIN = "agent:main:main";
function logicalMainSessionKey(sessionKey: string): string {
    return sessionKey
        .trim()
        .toLowerCase()
        .replace(/^agent:main:/u, "");
}
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
describe("OpenClaw chat bridge restart recovery", () => {
    it("keeps one replay when Gateway restart retains the OpenClaw session id", () => {
        const store = new MemorySnapshotStore();
        const sessionId = "same-session-across-gateway-restart";
        const firstRunId = "dashboard-chat-before-restart";
        const resumedRunId = "provider-after-restart";
        const startedAt = Date.now();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    startedAt,
                },
                runId: firstRunId,
                sessionId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "thinking before restart",
                },
                runId: firstRunId,
                sessionId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(startedAt + 1);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    phase: "start",
                    startedAt: startedAt + 2,
                },
                runId: resumedRunId,
                sessionId,
                sessionKey: MAIN,
                stream: "lifecycle",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "thinking after restart",
                },
                runId: resumedRunId,
                sessionId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
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
                () => resumedRunId
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
        ).toEqual(["thinking before restart", "thinking after restart"]);
    });
    it("promotes an interrupted provisional run from a provider session start", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-session-start";
        const providerRunId = "provider-session-start";
        const bridge = new OpenClawChatBridge(store);
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
            "session.started",
            {
                runId: providerRunId,
                sessionKey: MAIN,
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
    it("waits for the chat.send acknowledgment before promoting a live provisional run", () => {
        const provisionalRunId = "dashboard-chat-live-send";
        const providerRunId = "provider-live-send";
        const bridge = new OpenClawChatBridge();
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "live work",
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
        const acknowledgedSnapshot = bridge.snapshot(MAIN);
        expect(
            acknowledgedSnapshot.events.map(
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
                    length: acknowledgedSnapshot.events.length,
                },
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
                        data: {
                            delta: "thinking before restart",
                        },
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
                        message: {
                            content: "steer before restart",
                            role: "user",
                        },
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
                    {
                        runId: provisionalRunId,
                    },
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
                        data: {
                            phase: "start",
                        },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "lifecycle",
                    },
                    []
                );
                bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            delta: "thinking after restart",
                        },
                        runId: providerRunId,
                        sessionKey: MAIN,
                        stream: "thinking",
                    },
                    []
                );
                bridge.recordEvent(
                    "session.message",
                    {
                        message: {
                            content: "steer after restart",
                            role: "user",
                        },
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
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
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
                        (
                            event.payload as {
                                data?: {
                                    delta?: string;
                                };
                            }
                        ).data?.delta
                )
                .filter(Boolean)
        ).toEqual(["thinking before restart", "thinking after restart"]);
    });
    it("keeps one logical provider run when recovery resumes without a lifecycle start", () => {
        const providerRunId = "provider-before-restart";
        const resumedProviderRunId = "provider-after-restart";
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
                        data: {
                            item: {
                                kind: "preamble",
                                progressText: "before restart",
                            },
                            phase: "update",
                            stream: "item",
                        },
                        runId: providerRunId,
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.recordEvent(
                    "session.tool",
                    {
                        name: "before-restart",
                        runId: providerRunId,
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.markGatewayDisconnected(disconnectedAt);
                if (shouldRestartDashboard) {
                    expect(bridge.flush()).toBe(true);
                    bridge = new OpenClawChatBridge(store);
                }
                dateNow.mockReturnValue(disconnectedAt + 1000);
                bridge.recordEvent(
                    "agent",
                    {
                        data: {
                            item: {
                                kind: "preamble",
                                progressText: "after restart",
                            },
                            phase: "update",
                            stream: "item",
                        },
                        runId: resumedProviderRunId,
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.recordEvent(
                    "session.message",
                    {
                        activeRunIds: [resumedProviderRunId],
                        message: {
                            content: "steer after restart",
                            role: "user",
                        },
                        sessionKey: MAIN,
                    },
                    []
                );
                bridge.recordEvent(
                    "session.tool",
                    {
                        name: "after-steer",
                        runId: resumedProviderRunId,
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
            snapshot.events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId || "runless"
            )
        ).toEqual(
            Array.from(
                {
                    length: snapshot.events.length,
                },
                () => resumedProviderRunId
            )
        );
        expect(snapshot.events.map((event) => event.event)).toEqual([
            "agent",
            "session.tool",
            "agent",
            "session.message",
            "session.tool",
        ]);
    });
    it("repairs every provider fragment in one persisted restart chain", () => {
        const store = new MemorySnapshotStore();
        const runIds = ["provider-first", "provider-second", "provider-third"] as const;
        const now = Date.now();
        store.snapshots.set(MAIN, {
            completed: false,
            events: [
                runtimeEnvelope(
                    1,
                    "agent",
                    {
                        data: {
                            item: {
                                kind: "preamble",
                                progressText: "first",
                            },
                            phase: "update",
                            stream: "item",
                        },
                        runId: runIds[0],
                        sessionKey: MAIN,
                    },
                    now - 3000
                ),
                runtimeEnvelope(
                    2,
                    "session.tool",
                    {
                        name: "first-tool",
                        runId: runIds[0],
                        sessionKey: MAIN,
                    },
                    now - 2900
                ),
                runtimeEnvelope(
                    3,
                    "agent",
                    {
                        data: {
                            item: {
                                kind: "preamble",
                                progressText: "second",
                            },
                            phase: "update",
                            stream: "item",
                        },
                        runId: runIds[1],
                        sessionKey: MAIN,
                    },
                    now - 2000
                ),
                runtimeEnvelope(
                    4,
                    "session.tool",
                    {
                        name: "second-tool",
                        runId: runIds[1],
                        sessionKey: MAIN,
                    },
                    now - 1900
                ),
                runtimeEnvelope(
                    5,
                    "agent",
                    {
                        data: {
                            item: {
                                kind: "preamble",
                                progressText: "third",
                            },
                            phase: "update",
                            stream: "item",
                        },
                        runId: runIds[2],
                        sessionKey: MAIN,
                    },
                    now - 1000
                ),
                runtimeEnvelope(
                    7,
                    "session.message",
                    {
                        message: {
                            content: "steer",
                            role: "user",
                        },
                        runId: runIds[2],
                        sessionKey: MAIN,
                    },
                    now - 900
                ),
            ],
            firstSequenceByRun: {
                [runIds[0]]: 1,
                [runIds[1]]: 3,
                [runIds[2]]: 5,
            },
            interruptedAtByRun: {
                [runIds[0]]: now - 1500,
                [runIds[1]]: now - 1500,
            },
            requestBoundary: 6,
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 7,
        });
        const bridge = new OpenClawChatBridge(store);
        const repaired = bridge.snapshot(MAIN);
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
                () => runIds[2]
            )
        );
        expect(repaired.events.map((event) => event.runtimeSequence)).toEqual([
            1, 2, 3, 4, 5, 7,
        ]);
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        const steerRequestId = "dashboard-chat-after-chain-repair";
        const steerBoundary = bridge.captureRequestBoundary(MAIN, steerRequestId);
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: steerRequestId,
                message: "continue",
                sessionKey: MAIN,
            },
            {},
            steerBoundary
        );
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        bridge.markGatewayDisconnected(now);
        const resumedEnvelope = bridge.recordEvent(
            "agent",
            {
                data: {
                    item: {
                        kind: "preamble",
                        progressText: "fourth",
                    },
                    phase: "update",
                    stream: "item",
                },
                runId: "provider-fourth",
                sessionKey: MAIN,
            },
            []
        );
        expect(resumedEnvelope.runtimeRunAliases).toEqual([runIds[2]]);
        const resumed = bridge.snapshot(MAIN);
        expect(
            resumed.events.map(
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
                    length: resumed.events.length,
                },
                () => "provider-fourth"
            )
        );
    });
    it("keeps steers canonical across repeated restart recovery with mid-run compaction", () => {
        const store = new MemorySnapshotStore();
        const runIds = [
            "provider-before-restart",
            "provider-after-first-restart",
            "provider-after-second-restart",
        ] as const;
        let bridge = new OpenClawChatBridge(store);
        let steerIndex = 0;
        const recordSteer = (runId: string, message: string) => {
            steerIndex += 1;
            const requestId = `dashboard-chat-restart-steer-${steerIndex}`;
            const boundary = bridge.captureRequestBoundary(MAIN, requestId);
            bridge.handleSuccessfulRequest(
                "chat.send",
                {
                    idempotencyKey: requestId,
                    message,
                    sessionKey: MAIN,
                },
                {
                    runId,
                },
                boundary
            );
            bridge.recordEvent(
                "session.message",
                {
                    activeRunIds: [runId],
                    message: {
                        content: message,
                        idempotencyKey: `${requestId}:user`,
                        role: "user",
                    },
                    sessionKey: MAIN,
                },
                []
            );
        };
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "before restart",
                },
                runId: runIds[0],
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        recordSteer(runIds[0], "steer before restart");
        bridge.markGatewayDisconnected();
        expect(bridge.flush()).toBe(true);
        bridge = new OpenClawChatBridge(store);
        const firstResume = bridge.recordEvent(
            "agent",
            {
                data: {
                    item: {
                        kind: "preamble",
                        progressText: "first resume",
                    },
                    phase: "update",
                    stream: "item",
                },
                runId: runIds[1],
                sessionKey: MAIN,
            },
            []
        );
        expect(firstResume.runtimeRunAliases).toEqual([runIds[0]]);
        bridge.recordEvent(
            "agent",
            {
                phase: "start",
                runId: runIds[1],
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        bridge.recordEvent(
            "agent",
            {
                phase: "end",
                runId: runIds[1],
                sessionKey: MAIN,
                stream: "compaction",
            },
            []
        );
        expect(bridge.snapshot(MAIN).completed).toBe(false);
        recordSteer(runIds[1], "steer after compaction");
        bridge.markGatewayDisconnected();
        expect(bridge.flush()).toBe(true);
        bridge = new OpenClawChatBridge(store);
        const secondResume = bridge.recordEvent(
            "session.tool",
            {
                args: {
                    command: "pwd",
                },
                name: "exec",
                runId: runIds[2],
                sessionKey: MAIN,
            },
            []
        );
        expect(secondResume.runtimeRunAliases).toEqual([runIds[1]]);
        recordSteer(runIds[2], "steer after second restart");
        bridge.recordEvent(
            "chat",
            {
                message: "done",
                runId: runIds[2],
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        const snapshot = bridge.snapshot(MAIN);
        const payloads = snapshot.events.map(
            (event) => event.payload as Record<string, unknown>
        );
        const parentPayloads = payloads.filter(
            (payload) => payload.stream !== "compaction"
        );
        expect(snapshot.completed).toBe(true);
        expect(parentPayloads.every((payload) => payload.runId === runIds[2])).toBe(true);
        expect(
            payloads
                .filter((payload) => payload.stream === "compaction")
                .map((payload) => payload.phase)
        ).toEqual(["start", "end"]);
        expect(
            payloads
                .map((payload) => {
                    const message = payload.message as
                        | Record<string, unknown>
                        | undefined;
                    return message?.role === "user" ? message.content : undefined;
                })
                .filter(Boolean)
        ).toEqual([
            "steer before restart",
            "steer after compaction",
            "steer after second restart",
        ]);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
    });
    it("repairs a resumed run when a queued post-restart send left an earlier boundary", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        const interruptedRunId = "provider-before-restart-queue";
        const resumedRunId = "provider-after-restart-queue";
        const firstRequestId = "dashboard-chat-queued-after-restart";
        const secondRequestId = "dashboard-chat-steer-after-restart";
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
        bridge.markGatewayDisconnected();
        const firstBoundary = bridge.captureRequestBoundary(MAIN, firstRequestId);
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: firstRequestId,
                message: "queued until the interrupted response completes",
                sessionKey: MAIN,
            },
            {
                runId: firstRequestId,
                status: "started",
            },
            firstBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [firstRequestId]: firstBoundary,
        });
        expect(store.snapshots.get(MAIN)?.acknowledgedRequestIds).toEqual([
            firstRequestId,
        ]);
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        const resumedBridge = new OpenClawChatBridge(store);
        const firstResumedEnvelope = resumedBridge.recordEvent(
            "agent",
            {
                data: {
                    item: {
                        kind: "preamble",
                        progressText: "after restart",
                    },
                    phase: "update",
                    stream: "item",
                },
                runId: resumedRunId,
                sessionKey: MAIN,
            },
            []
        );
        expect(firstResumedEnvelope.runtimeRunAliases).toEqual([interruptedRunId]);
        resumedBridge.captureRequestBoundary(MAIN, secondRequestId);
        const steerEnvelope = resumedBridge.recordEvent(
            "session.message",
            {
                activeRunIds: [resumedRunId],
                message: {
                    content: "steer after restart",
                    idempotencyKey: `${secondRequestId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(steerEnvelope.runtimeRunAliases).toBeUndefined();
        const repaired = resumedBridge.snapshot(MAIN);
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
                () => resumedRunId
            )
        );
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [firstRequestId]: firstBoundary,
        });
        expect(store.snapshots.get(MAIN)?.acknowledgedRequestIds).toEqual([
            firstRequestId,
        ]);
    });
    it("broadcasts injected controls without retaining or promoting synthetic runs", () => {
        const store = new MemorySnapshotStore();
        const interruptedRunId = "provider-before-control";
        const resumedRunId = "provider-after-control";
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
        bridge.markGatewayDisconnected();
        expect(bridge.flush()).toBe(true);
        const restarted = new OpenClawChatBridge(store);
        const control = restarted.recordEvent(
            "chat",
            {
                message: {
                    content: "Task progress: #389",
                    model: "gateway-injected",
                    provider: "openclaw",
                    role: "assistant",
                    stopReason: "stop",
                },
                runId: "inject-control-1",
                sessionKey: MAIN,
                state: "final",
            },
            []
        );
        expect(control.runtimeRunAliases).toBeUndefined();
        expect(control.canonicalEvents).toEqual([
            expect.objectContaining({
                kind: "control",
                lifecycle: "completed",
            }),
        ]);
        expect(control.canonicalEvents[0]?.runId).toBeUndefined();
        expect(restarted.snapshot(MAIN)).toMatchObject({
            completed: false,
            events: [
                expect.objectContaining({
                    payload: expect.objectContaining({
                        runId: interruptedRunId,
                    }),
                }),
            ],
        });
        const resumed = restarted.recordEvent(
            "agent",
            {
                data: {
                    item: {
                        kind: "preamble",
                        progressText: "after control",
                    },
                    phase: "update",
                    stream: "item",
                },
                runId: resumedRunId,
                sessionKey: MAIN,
            },
            []
        );
        expect(resumed.runtimeRunAliases).toEqual([interruptedRunId]);
        expect(
            restarted.snapshot(MAIN).events.map(
                (event) =>
                    (
                        event.payload as {
                            runId?: string;
                        }
                    ).runId
            )
        ).toEqual([resumedRunId, resumedRunId]);
    });
    it("repairs one active provider run after an abrupt Dashboard restart", () => {
        const store = new MemorySnapshotStore();
        const providerRunId = "provider-before-dashboard-crash";
        const resumedProviderRunId = "provider-after-dashboard-crash";
        const interruptedAt = 1_785_000_000_000;
        const dateNow = jest.spyOn(Date, "now");
        try {
            dateNow.mockReturnValue(interruptedAt);
            const bridge = new OpenClawChatBridge(store);
            bridge.recordEvent(
                "session.tool",
                {
                    name: "before-crash",
                    runId: providerRunId,
                    sessionKey: MAIN,
                },
                []
            );
            expect(bridge.flush()).toBe(true);
            dateNow.mockReturnValue(interruptedAt + 1000);
            const restarted = new OpenClawChatBridge(store);
            restarted.recordEvent(
                "agent",
                {
                    data: {
                        item: {
                            kind: "preamble",
                            progressText: "resumed",
                        },
                        phase: "update",
                        stream: "item",
                    },
                    runId: resumedProviderRunId,
                    sessionKey: MAIN,
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
            ).toEqual([resumedProviderRunId, resumedProviderRunId]);
        } finally {
            dateNow.mockRestore();
        }
    });
    it("emits canonical identity when an invisible event resumes an interrupted run", () => {
        const store = new MemorySnapshotStore();
        const interruptedRunId = "provider-before-invisible-resume";
        const resumedRunId = "provider-after-invisible-resume";
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
        bridge.markGatewayDisconnected();
        expect(bridge.flush()).toBe(true);
        const restarted = new OpenClawChatBridge(store);
        const resumed = restarted.recordEvent(
            "session.tool",
            {
                name: "typing",
                phase: "result",
                runId: resumedRunId,
                sessionKey: MAIN,
            },
            []
        );
        expect(resumed.runtimeRunAliases).toEqual([interruptedRunId]);
        expect(resumed.canonicalEvents).toEqual([
            expect.objectContaining({
                kind: "identity",
                runAliases: [interruptedRunId],
                runId: resumedRunId,
            }),
        ]);
    });
    it("measures a quiet run's reconnect window from the Gateway disconnect", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-quiet-before-restart";
        const providerRunId = "provider-after-quiet-restart";
        const disconnectedAt = 1_785_000_000_000;
        const hydratedAt = disconnectedAt - 60 * 60_000 - 1;
        const providerStartedAt = disconnectedAt + 1000;
        const dateNow = jest.spyOn(Date, "now");
        try {
            dateNow.mockReturnValue(hydratedAt);
            store.snapshots.set(
                MAIN,
                persistedSnapshot(
                    MAIN,
                    provisionalRunId,
                    disconnectedAt - 7 * 60 * 60_000
                )
            );
            const bridge = new OpenClawChatBridge(store);
            bridge.snapshot(MAIN);
            bridge.markGatewayDisconnected(disconnectedAt);
            expect(bridge.flush()).toBe(true);
            expect(store.snapshots.get(MAIN)?.interruptedAtByRun).toEqual({
                [provisionalRunId]: disconnectedAt,
            });
            const restarted = new OpenClawChatBridge(store);
            dateNow.mockReturnValue(providerStartedAt);
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
                restarted.snapshot(MAIN).events.map(
                    (event) =>
                        (
                            event.payload as {
                                runId?: string;
                            }
                        ).runId
                )
            ).toEqual([providerRunId, providerRunId]);
        } finally {
            dateNow.mockRestore();
        }
    });
    it("does not join an interrupted run across a newer chat send", () => {
        const provisionalRunId = "provider-before-reconnect-send";
        const providerRunId = "provider-after-reconnect-send";
        const disconnectedAt = 1_785_000_000_000;
        const bridge = new OpenClawChatBridge();
        const dateNow = jest.spyOn(Date, "now");
        try {
            dateNow.mockReturnValue(disconnectedAt - 1000);
            bridge.recordEvent(
                "agent",
                {
                    data: {
                        delta: "interrupted work",
                    },
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
                    data: {
                        delta: "delayed interrupted work",
                    },
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
                    data: {
                        item: {
                            kind: "preamble",
                            progressText: "new turn",
                        },
                        phase: "update",
                        stream: "item",
                    },
                    runId: providerRunId,
                    sessionKey: MAIN,
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
                {
                    runId: providerRunId,
                },
                requestBoundary
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
        } finally {
            dateNow.mockRestore();
        }
    });
    it("does not promote a hydrated provisional run across a new send boundary", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-before-new-send";
        const providerRunId = "provider-new-send";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "abandoned work",
                },
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
        ).toEqual(new Set([provisionalRunId]));
        expect(
            new Set(
                afterBoundaryRestart.snapshot(MAIN).events.map(
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
    it("fails boundary capture until persisted session hydration succeeds", () => {
        const store = new MemorySnapshotStore();
        const requestId = "dashboard-chat-after-hydration-retry";
        store.snapshots.set(
            MAIN,
            persistedSnapshot(MAIN, "dashboard-chat-persisted-before-send")
        );
        store.loadFailures = 1;
        const restarted = new OpenClawChatBridge(store);
        expect(() => restarted.captureRequestBoundary(MAIN, requestId)).toThrow(
            "Chat send boundary session could not be hydrated"
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        const requestBoundary = restarted.captureRequestBoundary(MAIN, requestId);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [requestId]: requestBoundary,
        });
    });
    it("rolls back a synthetic boundary when its durable capture fails", () => {
        const store = new MemorySnapshotStore();
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "active work",
                },
                runId: "dashboard-chat-before-boundary-write-failure",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        expect(bridge.flush()).toBe(true);
        store.saveFailures = 1;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            expect(() => bridge.captureRequestBoundary(MAIN)).toThrow(
                "Chat send boundary could not be persisted"
            );
            expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
            expect(bridge.flush()).toBe(true);
        } finally {
            warning.mockRestore();
        }
    });
    it("releases failed send boundaries without clearing concurrent requests", () => {
        const store = new MemorySnapshotStore();
        const provisionalRunId = "dashboard-chat-before-failed-send";
        const failedRequestId = "dashboard-chat-failed-send";
        const concurrentRequestId = "dashboard-chat-concurrent-after-failure";
        const providerRunId = "provider-after-failed-send";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "work before failed send",
                },
                runId: provisionalRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        bridge.markGatewayDisconnected(Date.now());
        const requestBoundary = bridge.captureRequestBoundary(MAIN, failedRequestId);
        bridge.captureRequestBoundary(MAIN, concurrentRequestId);
        bridge.handleFailedRequest(
            "chat.send",
            {
                idempotencyKey: failedRequestId,
                message: "failed request",
                sessionKey: MAIN,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [concurrentRequestId]: requestBoundary,
        });
        bridge.handleFailedRequest(
            "chat.send",
            {
                idempotencyKey: concurrentRequestId,
                message: "concurrent failed request",
                sessionKey: MAIN,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
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
        const resumed = bridge.snapshot(MAIN);
        expect(
            resumed.events.map(
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
                    length: resumed.events.length,
                },
                () => providerRunId
            )
        );
    });
    it("hydrates a persisted request boundary before settling a failed send", () => {
        const store = new MemorySnapshotStore();
        const requestId = "dashboard-chat-failed-after-eviction";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "work before memory eviction",
                },
                runId: "dashboard-chat-before-failed-eviction",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [requestId]: requestBoundary,
        });
        expect(bridge.clearMemory()).toBe(true);
        bridge.handleFailedRequest(
            "chat.send",
            {
                idempotencyKey: requestId,
                message: "request that failed after eviction",
                sessionKey: MAIN,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
    });
    it("keeps an accepted send boundary durable until hydration can settle it", () => {
        const store = new MemorySnapshotStore();
        const requestId = "dashboard-chat-success-after-eviction";
        const activeRunId = "provider-before-successful-eviction";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "work before memory eviction",
                },
                runId: activeRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, requestId);
        expect(bridge.clearMemory()).toBe(true);
        store.loadFailures = 1;
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: requestId,
                message: "continue after eviction",
                sessionKey: MAIN,
            },
            {},
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [requestId]: requestBoundary,
        });
        bridge.recordEvent(
            "session.message",
            {
                activeRunIds: [activeRunId],
                message: {
                    content: "continue after eviction",
                    idempotencyKey: `${requestId}:user`,
                    role: "user",
                },
                sessionKey: MAIN,
            },
            []
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toBeUndefined();
        expect(store.snapshots.get(MAIN)?.requestBoundary).toBeUndefined();
    });
    it("settles only a synthetic fallback when the acknowledgement gains an id", () => {
        const store = new MemorySnapshotStore();
        const activeRunId = "dashboard-chat-synthetic-boundary-run";
        const concurrentRequestId = "dashboard-chat-concurrent-real-boundary";
        const acknowledgedRequestId = "dashboard-chat-late-real-request-id";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "active work",
                },
                runId: activeRunId,
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN);
        bridge.captureRequestBoundary(MAIN, concurrentRequestId);
        bridge.handleSuccessfulRequest(
            "chat.send",
            {
                idempotencyKey: acknowledgedRequestId,
                message: "continue",
                sessionKey: MAIN,
            },
            {
                runId: activeRunId,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [concurrentRequestId]: requestBoundary,
        });
    });
    it("settles the synthetic request when an idless send shares a boundary", () => {
        const store = new MemorySnapshotStore();
        const namedRequestId = "dashboard-chat-named-same-boundary";
        const bridge = new OpenClawChatBridge(store);
        bridge.recordEvent(
            "agent",
            {
                data: {
                    delta: "active work",
                },
                runId: "provider-before-idless-failure",
                sessionKey: MAIN,
                stream: "thinking",
            },
            []
        );
        const requestBoundary = bridge.captureRequestBoundary(MAIN, namedRequestId);
        bridge.captureRequestBoundary(MAIN);
        bridge.handleFailedRequest(
            "chat.send",
            {
                message: "idless request",
                sessionKey: MAIN,
            },
            requestBoundary
        );
        expect(store.snapshots.get(MAIN)?.pendingRequestBoundaries).toEqual({
            [namedRequestId]: requestBoundary,
        });
    });
    it("uses the maximum exact request boundary across persisted aliases", () => {
        const boundaries = new OpenClawChatRequestBoundaries(
            (sessionKey) => sessionKey.trim().toLowerCase(),
            (left, right) => logicalMainSessionKey(left) === logicalMainSessionKey(right)
        );
        const requestId = "dashboard-chat-shared-alias-request";
        boundaries.restore(MAIN, {
            pendingRequestBoundaries: {
                [requestId]: 10,
            },
        });
        boundaries.restore("main", {
            pendingRequestBoundaries: {
                [requestId]: 20,
            },
        });
        expect(boundaries.pending(MAIN, requestId)).toBe(20);
        expect(boundaries.settle(MAIN, requestId, undefined, false)).toEqual([
            MAIN,
            "main",
        ]);
        expect(boundaries.metadata(MAIN)).toEqual({
            requestBoundary: 20,
        });
        boundaries.forgetExact(MAIN);
        expect(boundaries.metadata("main")).toEqual({
            requestBoundary: 20,
        });
    });
    it("blocks recovery only on unacknowledged pending requests", () => {
        const boundaries = new OpenClawChatRequestBoundaries(
            (sessionKey) => sessionKey.trim().toLowerCase(),
            (left, right) => logicalMainSessionKey(left) === logicalMainSessionKey(right)
        );
        const acceptedRequestId = "dashboard-chat-accepted-unplaced";
        const capturedRequestId = "dashboard-chat-captured-unacknowledged";
        boundaries.restore(MAIN, {
            acknowledgedRequestIds: [acceptedRequestId],
            pendingRequestBoundaries: {
                [acceptedRequestId]: 20,
                [capturedRequestId]: 15,
            },
            requestBoundary: 5,
        });
        expect(boundaries.latest(MAIN)).toBe(20);
        expect(boundaries.blocking(MAIN)).toBe(15);
        expect(boundaries.acknowledge(MAIN, capturedRequestId)).toEqual([MAIN]);
        expect(boundaries.blocking(MAIN)).toBe(5);
    });
    it("does not acknowledge an unrelated synthetic alias request", () => {
        const boundaries = new OpenClawChatRequestBoundaries(
            (sessionKey) => sessionKey.trim().toLowerCase(),
            (left, right) => logicalMainSessionKey(left) === logicalMainSessionKey(right)
        );
        const namedRequestId = "dashboard-chat-named-alias-request";
        const syntheticRequestId = "request:20:0";
        boundaries.restore(MAIN, {
            pendingRequestBoundaries: {
                [namedRequestId]: 20,
            },
        });
        boundaries.restore("main", {
            pendingRequestBoundaries: {
                [syntheticRequestId]: 20,
            },
        });
        expect(boundaries.acknowledge(MAIN, namedRequestId)).toEqual([MAIN]);
        expect(boundaries.metadata(MAIN).acknowledgedRequestIds).toEqual([
            namedRequestId,
        ]);
        expect(boundaries.blocking(MAIN)).toBe(20);
        expect(boundaries.acknowledge(MAIN, undefined, 20)).toEqual(["main"]);
        expect(boundaries.blocking(MAIN)).toBeUndefined();
    });
    it("keeps an equivalent alias boundary when one owner is evicted", () => {
        const boundaries = new OpenClawChatRequestBoundaries(
            (sessionKey) => sessionKey.trim().toLowerCase(),
            (left, right) => logicalMainSessionKey(left) === logicalMainSessionKey(right)
        );
        const requestId = "dashboard-chat-surviving-alias-request";
        boundaries.restore("main", {
            pendingRequestBoundaries: {
                [requestId]: 10,
            },
        });
        boundaries.restore(MAIN, {
            pendingRequestBoundaries: {
                [requestId]: 20,
            },
        });
        boundaries.forgetExact("main");
        expect(boundaries.pending(MAIN, requestId)).toBe(20);
        expect(boundaries.metadata(MAIN)).toEqual({
            pendingRequestBoundaries: {
                [requestId]: 20,
            },
        });
    });
});
