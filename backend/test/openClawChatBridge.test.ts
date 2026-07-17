import { describe, expect, it } from "bun:test";

import { OpenClawChatBridge } from "../src/chat/openClawChatBridge.ts";

const MAIN = "agent:main:main";

function payloads(bridge: OpenClawChatBridge, sessionKey = MAIN) {
    return bridge
        .snapshot(sessionKey)
        .events.map((event) => event.payload as Record<string, unknown>);
}

describe("OpenClaw chat bridge", () => {
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

    it("promotes provisional runs and prefers a concrete final over runless metadata", () => {
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
        bridge.recordEvent("session.ended", { sessionKey: MAIN }, []);

        const snapshot = bridge.snapshot(MAIN);
        expect(snapshot.completed).toBe(true);
        expect(snapshot.events.map((event) => event.event)).toEqual(["agent", "chat"]);
        expect(payloads(bridge).at(-1)).toMatchObject({
            runId: "real-run",
            state: "final",
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

    it("rewrites an active provisional replay when the provider run arrives", () => {
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

        expect(
            payloads(bridge)
                .filter(
                    (payload) => (payload.data as { delta?: unknown } | undefined)?.delta
                )
                .map((payload) => payload.runId)
        ).toEqual(["provider-run", "provider-run"]);
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

    it("retains an unscoped assistant session echo with its completed final", () => {
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
                content: "done",
                role: "assistant",
                sessionKey: MAIN,
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
                data: { phase: "end" },
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

    it("bounds event count and drops oversized non-terminal payloads", () => {
        const bridge = new OpenClawChatBridge();
        for (let index = 0; index < 510; index += 1) {
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
        expect(bridge.snapshot(MAIN).events).toHaveLength(500);

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
