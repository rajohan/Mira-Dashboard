import { describe, expect, it } from "bun:test";

import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../contracts/chat.ts";
import { withCanonicalOpenClawEvents } from "../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    isSameSessionKey,
    OpenClawChatIdentityRegistry,
    sessionMessageRunId,
} from "../src/chat/openClawChatIdentity.ts";
import {
    isTerminalEvent,
    runtimeSessionBoundary,
} from "../src/chat/openClawChatLifecycle.ts";
import {
    OpenClawChatPersistenceCoordinator,
    type OpenClawChatSnapshotStore,
} from "../src/chat/openClawChatPersistence.ts";
import {
    runtimePayloadView,
    sessionMessageRole,
    sessionMessageStopReason,
    withRuntimeIdentity,
} from "../src/chat/openClawChatProviderAdapter.ts";
import {
    boundedCanonicalRuntimeEnvelope,
    compactCompletedRun,
    MAX_BYTES_PER_EVENT,
    shouldRetainRuntimeEvent,
    snapshotFromRetainedRuns,
    type RetainedRun,
} from "../src/chat/openClawChatRetention.ts";

function envelope(
    event: string,
    payload: Record<string, unknown>,
    runtimeSequence = 1
): OpenClawRuntimeEnvelope {
    return withCanonicalOpenClawEvents({
        event,
        payload,
        runtimeRecordedAt: 1000 + runtimeSequence,
        runtimeSequence,
        type: "event",
    });
}

function retainedRun(
    runId: string,
    events: OpenClawRuntimeEnvelope[],
    completed: boolean
): RetainedRun {
    const eventBytes = events.map((event) => Buffer.byteLength(JSON.stringify(event)));
    return {
        completed,
        eventBytes,
        events,
        firstSequence: events[0]?.runtimeSequence ?? 0,
        interruptionEligible: false,
        runId,
        terminalSequence: completed ? (events.at(-1)?.runtimeSequence ?? -1) : -1,
        totalBytes: eventBytes.reduce((total, bytes) => total + bytes, 0),
        updatedAt: events.at(-1)?.runtimeRecordedAt ?? 0,
    };
}

describe("OpenClaw chat architecture seams", () => {
    it("normalizes nested Codex and Synthetic payload variants at one provider boundary", () => {
        const codexPayload = {
            runId: "outer-run",
            sessionKey: "outer",
            data: {
                runId: "codex-run",
                sessionKey: "agent:main:main",
                stream: "item",
            },
        };
        expect(runtimePayloadView(codexPayload)).toMatchObject({
            runId: "codex-run",
            sessionKey: "agent:main:main",
            stream: "item",
        });
        expect(
            withRuntimeIdentity(codexPayload, {
                runId: "canonical-run",
                sessionKey: "agent:main:canonical",
            })
        ).toMatchObject({
            data: {
                runId: "canonical-run",
                sessionKey: "agent:main:canonical",
            },
            runId: "canonical-run",
            sessionKey: "agent:main:canonical",
        });

        const syntheticPayload = {
            activeRunIds: ["synthetic-run"],
            message: {
                role: "assistant",
                stopReason: "stop",
            },
        };
        expect(sessionMessageRole(syntheticPayload)).toBe("assistant");
        expect(sessionMessageStopReason(syntheticPayload)).toBe("stop");
    });

    it("keeps provider lifecycle classification outside retention and bridge state", () => {
        expect(
            isTerminalEvent("session.message", {
                message: { role: "assistant", stopReason: "stop" },
            })
        ).toBe(true);
        expect(
            isTerminalEvent("session.message", {
                message: { role: "user", stopReason: "stop" },
            })
        ).toBe(false);
        expect(
            isTerminalEvent("session.compaction", {
                operation: "compact",
                phase: "retrying",
            })
        ).toBe(false);
        expect(
            isTerminalEvent("session.compaction", {
                operation: "compact",
                phase: "completed",
            })
        ).toBe(true);

        expect(
            runtimeSessionBoundary(
                envelope("session.message", {
                    data: {
                        messageSeq: 1,
                        role: "user",
                        sessionId: "synthetic-session",
                        ts: 42,
                    },
                })
            )
        ).toEqual({ id: "synthetic-session", startedAt: 42 });
    });

    it("owns session aliases and provider run inference in the identity seam", () => {
        expect(isSameSessionKey("main", "agent:main:main")).toBe(true);
        expect(isSameSessionKey("agent:ops:main", "agent:main:main")).toBe(false);
        expect(
            sessionMessageRunId("session.message", {
                activeRunIds: ["synthetic-provider-run"],
                message: { role: "user" },
            })
        ).toBe("synthetic-provider-run");
        expect(
            sessionMessageRunId("session.message", {
                idempotencyKey: "dashboard-chat-codex:user",
                role: "user",
            })
        ).toBe("dashboard-chat-codex");

        const registry = new OpenClawChatIdentityRegistry();
        registry.rememberRunSession("provider-run", "agent:main:main");
        expect(
            registry.sessionCandidates("main", "provider-run", [
                { id: "main", key: "agent:main:main" },
                { id: "main", key: "agent:ops:main" },
            ])
        ).toEqual(new Map([["agent:main:main", "agent:main:main"]]));
        registry.setRuntimeSession("main", {
            id: "provider-session",
            startedAt: 42,
        });
        registry.promoteRuntimeSession("main", "agent:main:main", false);
        expect(registry.runtimeSession("agent:main:main")).toEqual({
            id: "provider-session",
            startedAt: 42,
        });
        registry.forgetSession("agent:main:main");
        expect(registry.sessionKeyForRun("provider-run", [])).toBeUndefined();
    });

    it("owns hydration, write queues and durable deletes in the persistence seam", () => {
        const snapshots = new Map<string, OpenClawRuntimeSnapshot>();
        let saveCount = 0;
        const store: OpenClawChatSnapshotStore = {
            clear: () => snapshots.clear(),
            delete: (sessionKey) => snapshots.delete(sessionKey),
            keys: () => snapshots.keys().toArray(),
            load: (sessionKey) => snapshots.get(sessionKey),
            maximumSequence: () =>
                Math.max(
                    0,
                    ...snapshots.values().map((snapshot) => snapshot.throughSequence)
                ),
            promote: (
                sourceSessionKey,
                canonicalSessionKey,
                sourceSnapshot,
                canonicalSnapshot
            ) => {
                snapshots.set(sourceSessionKey, sourceSnapshot);
                snapshots.set(canonicalSessionKey, canonicalSnapshot);
            },
            save: (sessionKey, snapshot) => {
                saveCount += 1;
                snapshots.set(sessionKey, snapshot);
            },
        };
        const memorySnapshot: OpenClawRuntimeSnapshot = {
            completed: false,
            events: [
                envelope("agent", {
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                }),
            ],
            schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            throughSequence: 1,
        };
        const persistence = new OpenClawChatPersistenceCoordinator(store, {
            ensureSessionLoaded: () => true,
            snapshotFromMemory: () => memorySnapshot,
        });

        persistence.markHydratedLookup("agent:main:main");
        persistence.queueSession("agent:main:main");
        expect(persistence.pendingSessionKeys()).toEqual(["agent:main:main"]);
        expect(persistence.flush()).toBe(true);
        expect(saveCount).toBe(1);
        expect(persistence.isLoaded("agent:main:main")).toBe(true);
        expect(persistence.deleteSession("agent:main:main")).toBe(true);
        expect(snapshots.size).toBe(0);
    });

    it("owns provider filtering and replay selection in the retention seam", () => {
        expect(
            shouldRetainRuntimeEvent(
                "agent",
                {
                    stream: "codex_app_server.internal",
                },
                []
            )
        ).toBe(false);
        expect(shouldRetainRuntimeEvent("session.started", {}, [])).toBe(false);

        const conversation = retainedRun(
            "conversation",
            [
                envelope(
                    "chat",
                    {
                        runId: "conversation",
                        sessionKey: "agent:main:main",
                        state: "final",
                    },
                    1
                ),
            ],
            true
        );
        const compaction = retainedRun(
            "compaction",
            [
                envelope(
                    "session.compaction",
                    {
                        operation: "compact",
                        phase: "completed",
                        runId: "compaction",
                        sessionKey: "agent:main:main",
                    },
                    2
                ),
            ],
            true
        );
        const snapshot = snapshotFromRetainedRuns(
            new Map([
                [conversation.runId, conversation],
                [compaction.runId, compaction],
            ]),
            2
        );

        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.runtimeSequence)).toEqual([1]);
    });

    it("reuses retained byte accounting when completed tool events compact", () => {
        const run = retainedRun(
            "completed",
            [
                envelope("chat", { runId: "completed", state: "delta" }, 1),
                envelope("session.tool", { runId: "completed" }, 2),
                envelope("chat", { runId: "completed", state: "final" }, 3),
            ],
            true
        );
        run.eventBytes = [11, 22, 33];
        run.totalBytes = 66;

        compactCompletedRun(run);

        expect(run.events.map((event) => event.runtimeSequence)).toEqual([1, 3]);
        expect(run.eventBytes).toEqual([11, 33]);
        expect(run.totalBytes).toBe(44);
    });

    it("strips oversized Codex and Synthetic provider content from retained replay", () => {
        const providerContent = "provider-content".repeat(
            Math.ceil(MAX_BYTES_PER_EVENT / 16)
        );
        const codex = boundedCanonicalRuntimeEnvelope(
            envelope(
                "agent",
                {
                    data: {
                        phase: "end",
                        providerContent,
                        runId: "codex-run",
                        sessionKey: "agent:main:main",
                        status: "completed",
                        stream: "lifecycle",
                    },
                },
                1
            )
        );
        const synthetic = boundedCanonicalRuntimeEnvelope(
            envelope(
                "session.message",
                {
                    message: {
                        providerContent,
                        role: "assistant",
                        stopReason: "stop",
                    },
                    runId: "synthetic-run",
                    sessionKey: "agent:main:main",
                },
                2
            )
        );
        const snapshot = snapshotFromRetainedRuns(
            new Map([
                ["codex-run", retainedRun("codex-run", [codex], false)],
                ["synthetic-run", retainedRun("synthetic-run", [synthetic], false)],
            ]),
            2
        );

        expect(snapshot.events).toHaveLength(2);
        expect(JSON.stringify(snapshot.events)).not.toContain("providerContent");
        expect(snapshot.events[0]?.payload).toMatchObject({
            data: {
                phase: "end",
                runId: "codex-run",
                sessionKey: "agent:main:main",
                status: "completed",
                stream: "lifecycle",
            },
            runId: "codex-run",
            sessionKey: "agent:main:main",
        });
        expect(snapshot.events[1]?.payload).toMatchObject({
            message: {
                role: "assistant",
                stopReason: "stop",
            },
            runId: "synthetic-run",
            sessionKey: "agent:main:main",
        });
        expect(
            snapshot.events.flatMap((event) =>
                event.canonicalEvents.map((canonicalEvent) => ({
                    lifecycle: canonicalEvent.lifecycle,
                    origin: canonicalEvent.origin,
                    runId: canonicalEvent.runId,
                    sessionKey: canonicalEvent.sessionKey,
                }))
            )
        ).toEqual([
            {
                lifecycle: "completed",
                origin: "openclaw-runtime",
                runId: "codex-run",
                sessionKey: "agent:main:main",
            },
            {
                lifecycle: "completed",
                origin: "openclaw-session",
                runId: "synthetic-run",
                sessionKey: "agent:main:main",
            },
        ]);
    });
});
