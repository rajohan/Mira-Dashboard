import { describe, expect, it } from "bun:test";

import type { OpenClawRuntimeEnvelope } from "../../contracts/chat.ts";
import { withCanonicalOpenClawEvents } from "../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    isSameSessionKey,
    sessionMessageRunId,
} from "../src/chat/openClawChatIdentity.ts";
import {
    isTerminalEvent,
    runtimeSessionBoundary,
} from "../src/chat/openClawChatLifecycle.ts";
import {
    runtimePayloadView,
    sessionMessageRole,
    sessionMessageStopReason,
    withRuntimeIdentity,
} from "../src/chat/openClawChatProviderAdapter.ts";
import {
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
    });

    it("owns provider filtering and replay selection in the retention seam", () => {
        expect(
            shouldRetainRuntimeEvent("agent", {
                stream: "codex_app_server.internal",
            })
        ).toBe(false);
        expect(shouldRetainRuntimeEvent("session.started", {})).toBe(false);

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
});
