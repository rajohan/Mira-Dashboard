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

    it("rewrites runless and active provisional replay payloads on promotion", () => {
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
