import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

class FakeWebSocket {
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readyState = WebSocket.OPEN;

    on(event: string, listener: (...args: unknown[]) => void): this {
        this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) || []) {
            listener(...args);
        }
    }

    send(data: string): void {
        this.sent.push(data);
    }
}

async function waitForAsyncHandlers(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

const openclawHome = await mkdtemp(path.join(os.tmpdir(), "gateway-test-openclaw-"));
process.env.OPENCLAW_HOME = openclawHome;

const gatewayModule = await import("./gateway.js");
const gateway = gatewayModule.default;
const { __testing } = gatewayModule;

describe("gateway state and helper utilities", () => {
    before(() => {
        __testing.resetGatewayStateForTest();
    });

    after(async () => {
        __testing.resetGatewayStateForTest();
        await rm(openclawHome, { force: true, recursive: true });
    });

    it("transforms Gateway sessions into dashboard session summaries", () => {
        const main = __testing.transformSession({
            channel: "webchat",
            contextTokens: 12345,
            displayName: "Main session",
            key: "agent:main:main",
            label: "Main",
            model: "codex",
            sessionId: "main-id",
            totalTokens: 42,
            updatedAt: 1_700_000_000_000,
        });
        assert.equal(main.id, "main-id");
        assert.equal(main.type, "MAIN");
        assert.equal(main.agentType, "main");
        assert.equal(main.maxTokens, 12345);
        assert.equal(main.createdAt, "2023-11-14T22:13:20.000Z");

        const hook = __testing.transformSession({
            key: "agent:main:hook:discord",
            sessionId: "hook-id",
        });
        assert.equal(hook.type, "HOOK");
        assert.equal(hook.hookName, "discord");
        assert.equal(hook.displayLabel, "Discord");

        const subagent = __testing.transformSession({
            key: "agent:coder:subagent:work",
            sessionId: "sub-id",
        });
        assert.equal(subagent.type, "SUBAGENT");
        assert.equal(subagent.agentType, "coder");
        assert.equal(subagent.displayLabel, "Coder");

        const cron = __testing.transformSession({ key: "agent:main:cron:nightly" });
        assert.equal(cron.type, "CRON");
        assert.equal(cron.id, "agent:main:cron:nightly");
        assert.equal(cron.model, "Unknown");
        assert.equal(cron.channel, "unknown");
    });

    it("enriches runtime events with session keys when run ids match", () => {
        const session = __testing.transformSession({
            activeRunId: "run-active",
            key: "agent:main:main",
            runId: "run-primary",
            sessionId: "session-1",
        });
        __testing.setSessionListForTest([session]);

        assert.deepEqual(
            __testing.enrichRuntimeEventPayload("agent", { runId: "run-active" }),
            { runId: "run-active", sessionKey: "agent:main:main" }
        );
        assert.deepEqual(
            __testing.enrichRuntimeEventPayload("session.tool", {
                runId: "run-primary",
            }),
            { runId: "run-primary", sessionKey: "agent:main:main" }
        );
        assert.deepEqual(__testing.enrichRuntimeEventPayload("other", { runId: "x" }), {
            runId: "x",
        });
        assert.deepEqual(
            __testing.enrichRuntimeEventPayload("agent", {
                runId: "x",
                sessionKey: "already-present",
            }),
            { runId: "x", sessionKey: "already-present" }
        );
    });

    it("hydrates omitted chat-history images from raw transcripts", async () => {
        const transcriptDir = path.join(openclawHome, "agents", "main", "sessions");
        await mkdir(transcriptDir, { recursive: true });
        await writeFile(
            path.join(transcriptDir, "session-1.jsonl"),
            [
                "not json",
                JSON.stringify({
                    timestamp: 1_700_000_000_000,
                    message: {
                        role: "user",
                        content: [
                            { type: "text", text: "look" },
                            {
                                type: "image",
                                source: { data: "raw-image", media_type: "image/png" },
                            },
                        ],
                    },
                }),
                "",
            ].join("\n"),
            "utf8"
        );

        const payload = {
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            messages: [
                {
                    role: "user",
                    timestamp: "2023-11-14T22:13:20.000Z",
                    content: [
                        { type: "text", text: "look" },
                        { type: "image", source: { omitted: true } },
                    ],
                },
            ],
        };

        const hydrated = __testing.hydrateOmittedChatHistoryImages(
            payload
        ) as typeof payload;
        assert.deepEqual(hydrated.messages[0]?.content[1], {
            type: "image",
            data: "raw-image",
            mimeType: "image/png",
        });

        assert.deepEqual(__testing.hydrateOmittedChatHistoryImages({ messages: [] }), {
            messages: [],
        });
    });

    it("normalizes primitive helpers and disconnected gateway behavior", async () => {
        assert.equal(__testing.normalizeMessageText("  hello  "), "hello");
        assert.equal(
            __testing.normalizeMessageText([
                { text: "hello" },
                "world",
                { value: "ignored" },
            ]),
            "hello\n\nworld"
        );
        assert.equal(__testing.normalizeMessageText({ text: "ignored" }), "");
        assert.equal(__testing.normalizeTimestamp(1_700_000_000_000), 1_700_000_000_000);
        assert.equal(
            __testing.normalizeTimestamp("2023-11-14T22:13:20.000Z"),
            1_700_000_000_000
        );
        assert.equal(__testing.normalizeTimestamp("not-a-date"), undefined);
        assert.equal(__testing.imageBlockHasOmittedData({ type: "text" }), false);
        assert.equal(
            __testing.imageBlockHasOmittedData({ type: "image", data: "inline" }),
            false
        );
        assert.equal(
            __testing.imageBlockHasOmittedData({ type: "image", source: {} }),
            true
        );

        assert.deepEqual(gateway.getStatus(), {
            gateway: "disconnected",
            sessions: 1,
        });
        assert.equal(gateway.isConnected(), false);
        assert.equal(gateway.getGatewayWs(), null);
        await assert.rejects(() => gateway.request("sessions.list", {}), {
            message: "Gateway not connected",
        });
    });

    it("handles WebSocket clients and disconnected request responses", async () => {
        const ws = new FakeWebSocket();

        gateway.handleClient(ws as unknown as WebSocket);
        const initialState = JSON.parse(ws.sent[0] || "{}") as {
            gatewayConnected?: boolean;
            sessions?: Array<{ id?: string }>;
            type?: string;
        };
        assert.equal(initialState.type, "state");
        assert.equal(initialState.gatewayConnected, false);
        assert.equal(initialState.sessions?.[0]?.id, "session-1");

        ws.emit(
            "message",
            Buffer.from(
                JSON.stringify({
                    id: "client-request-1",
                    method: "sessions.list",
                    params: {},
                    type: "request",
                })
            )
        );
        await waitForAsyncHandlers();

        assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
            type: "res",
            id: "client-request-1",
            ok: false,
            error: "Gateway not connected",
        });

        ws.emit("message", Buffer.from("not json"));
        ws.emit("close");
        await waitForAsyncHandlers();
    });
});
