import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import WebSocket from "ws";

import type { OpenClawGatewayClientOptions } from "./lib/openclawGatewayClient.js";
import { __testing as logsTesting } from "./routes/logs.js";

/** Provides a minimal WebSocket stand-in for gateway client tests. */
class FakeWebSocket {
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readyState: number = WebSocket.OPEN;

    /** Registers one fake WebSocket event listener. */
    on(event: string, listener: (...args: unknown[]) => void): this {
        this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
        return this;
    }

    /** Emits one fake WebSocket event to registered listeners. */
    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) || []) {
            listener(...args);
        }
    }

    /** Captures outbound WebSocket data for assertions. */
    send(data: string): void {
        this.sent.push(data);
    }
}

class ThrowingWebSocket extends FakeWebSocket {
    throwOnSend = false;

    override send(data: string): void {
        if (this.throwOnSend) {
            throw new Error("socket closed");
        }
        super.send(data);
    }
}

/** Provides a minimal Gateway client stand-in for connected-state tests. */
class FakeGatewayClient {
    readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    responses = new Map<string, unknown>();
    failures = new Map<string, Error>();

    /** Captures Gateway requests and returns configured responses. */
    async request(method: string, params: unknown = {}): Promise<unknown> {
        assert.ok(params && typeof params === "object" && !Array.isArray(params));
        this.calls.push({ method, params: params as Record<string, unknown> });
        const failure = this.failures.get(method);
        if (failure) {
            throw failure;
        }
        return this.responses.get(method) ?? {};
    }

    /** No-op start method matching the real Gateway client surface. */
    start(): void {}

    /** No-op stop method matching the real Gateway client surface. */
    stop(): void {}
}

/** Captures Gateway init options without opening network sockets. */
class CapturingGatewayClient extends FakeGatewayClient {
    static instances: CapturingGatewayClient[] = [];
    readonly options: OpenClawGatewayClientOptions;
    started = false;
    stopped = false;

    constructor(options: OpenClawGatewayClientOptions) {
        super();
        this.options = options;
        CapturingGatewayClient.instances.push(this);
    }

    override start(): void {
        this.started = true;
    }

    override stop(): void {
        this.stopped = true;
    }
}

/** Throws synchronously from start to exercise init rollback. */
class ThrowingStartGatewayClient extends CapturingGatewayClient {
    override start(): void {
        throw new Error("start failed");
    }
}

/** Waits one tick so async WebSocket handlers can settle. */
async function waitForAsyncHandlers(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

const openclawHome = await mkdtemp(path.join(os.tmpdir(), "gateway-test-openclaw-"));
const previousOpenclawHome = process.env.OPENCLAW_HOME;
process.env.OPENCLAW_HOME = openclawHome;

const gatewayModule = await import("./gateway.js");
const gateway = gatewayModule.default;
const { __testing } = gatewayModule;

describe("gateway state and helper utilities", () => {
    before(() => {
        __testing.resetGatewayStateForTest();
    });

    beforeEach(() => {
        __testing.resetGatewayStateForTest();
    });

    after(async () => {
        __testing.resetGatewayStateForTest();
        if (previousOpenclawHome === undefined) {
            delete process.env.OPENCLAW_HOME;
        } else {
            process.env.OPENCLAW_HOME = previousOpenclawHome;
        }
        await rm(openclawHome, { force: true, recursive: true });
    });

    it("initializes the Gateway client lifecycle and avoids duplicate starts", async () => {
        const warn = mock.method(console, "warn", () => {});
        const error = mock.method(console, "error", () => {});
        CapturingGatewayClient.instances = [];
        __testing.setGatewayClientConstructorForTest(CapturingGatewayClient);
        const originalGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;

        try {
            process.env.OPENCLAW_GATEWAY_URL = "";
            gateway.init("token-a");
            assert.equal(gateway.isConnected(), false);
            gateway.init("token-a");
            gateway.init("token-b");
            assert.equal(CapturingGatewayClient.instances.length, 2);
            assert.equal(CapturingGatewayClient.instances[0]?.started, true);
            assert.equal(CapturingGatewayClient.instances[0]?.stopped, true);
            assert.equal(CapturingGatewayClient.instances[1]?.started, true);

            const latest = CapturingGatewayClient.instances[1];
            assert.equal(latest?.options.clientName, "gateway-client");
            assert.equal(latest?.options.url, "ws://127.0.0.1:18789");
            latest?.failures.set("sessions.subscribe", new Error("subscribe failed"));
            latest?.failures.set("sessions.list", new Error("refresh failed"));
            latest?.options.onHelloOk?.({ type: "hello.ok" });
            assert.equal(gateway.isConnected(), true);
            await new Promise((resolve) => setTimeout(resolve, 550));
            latest?.options.onEvent?.({
                event: "sessions.updated",
                payload: { runId: "run-1" },
            });
            latest?.options.onConnectError?.(new Error("connect failed"));
            latest?.options.onClose?.(1006, "closed");
            assert.equal(gateway.isConnected(), false);
            await waitForAsyncHandlers();

            gateway.init("token-c");
            const successful = CapturingGatewayClient.instances[2];
            successful?.options.onHelloOk?.({ type: "hello.ok" });
            await waitForAsyncHandlers();
            assert.deepEqual(successful?.calls.at(-1), {
                method: "sessions.list",
                params: {},
            });

            process.env.OPENCLAW_GATEWAY_URL = "ws://gateway.example";
            gateway.init("token-d");
            const active = CapturingGatewayClient.instances[3];
            assert.equal(active?.options.url, "ws://gateway.example");
            active?.options.onHelloOk?.({ type: "hello.ok" });
            assert.equal(gateway.isConnected(), true);
            successful?.options.onHelloOk?.({ type: "hello.ok" });
            successful?.options.onEvent?.({ event: "sessions.updated", payload: {} });
            successful?.options.onConnectError?.(new Error("stale connect failed"));
            successful?.options.onClose?.(1006, "stale");
            assert.equal(gateway.isConnected(), true);

            __testing.setGatewayClientConstructorForTest(ThrowingStartGatewayClient);
            assert.throws(() => gateway.init("token-throws"), /start failed/u);
            __testing.setGatewayClientConstructorForTest(CapturingGatewayClient);
            gateway.init("token-throws");
            assert.equal(
                CapturingGatewayClient.instances.at(-1)?.options.token,
                "token-throws"
            );
        } finally {
            if (originalGatewayUrl === undefined) {
                delete process.env.OPENCLAW_GATEWAY_URL;
            } else {
                process.env.OPENCLAW_GATEWAY_URL = originalGatewayUrl;
            }
            __testing.resetGatewayStateForTest();
            warn.mock.restore();
            error.mock.restore();
        }
    });

    it("covers Gateway init warning fallback branches", async () => {
        const warn = mock.method(console, "warn", () => {});
        const originalSetTimeout = globalThis.setTimeout;
        const scheduledDelays: number[] = [];
        CapturingGatewayClient.instances = [];
        __testing.setGatewayClientConstructorForTest(CapturingGatewayClient);

        globalThis.setTimeout = ((callback: () => void, delay?: number) => {
            scheduledDelays.push(delay ?? 0);
            queueMicrotask(callback);
            return { unref: () => {} } as unknown as NodeJS.Timeout;
        }) as typeof setTimeout;

        try {
            assert.equal(
                __testing.loadOrCreateDashboardDeviceIdentity("/tmp/device.json", () => {
                    throw new Error("identity unavailable");
                }),
                undefined
            );

            gateway.init("token-warning");
            const latest = CapturingGatewayClient.instances.at(-1);
            assert.ok(latest);
            latest.failures.set("sessions.subscribe", new Error("subscribe failed"));
            latest.options.onHelloOk?.({ type: "hello.ok" });
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            assert.deepEqual(scheduledDelays, [500, 1000, 2000]);
            assert.equal(
                warn.mock.calls.some((call) =>
                    String(call.arguments[0]).includes(
                        "Failed to subscribe to session index events"
                    )
                ),
                true
            );
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            __testing.resetGatewayStateForTest();
            warn.mock.restore();
        }
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

        const agent = __testing.transformSession({ key: "agent:researcher:main" });
        assert.equal(agent.type, "SUBAGENT");
        assert.equal(agent.displayLabel, "Researcher");

        const unknown = __testing.transformSession({});
        assert.equal(unknown.id, "unknown");
        assert.equal(unknown.type, "UNKNOWN");
        assert.equal(unknown.createdAt, null);
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
        assert.deepEqual(
            __testing.enrichRuntimeEventPayload("session.message", {
                runId: "run-active",
            }),
            { runId: "run-active", sessionKey: "agent:main:main" }
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
        assert.deepEqual(__testing.enrichRuntimeEventPayload("agent", null), null);
        assert.deepEqual(__testing.enrichRuntimeEventPayload("agent", {}), {});
        assert.deepEqual(__testing.enrichRuntimeEventPayload("agent", { runId: "x" }), {
            runId: "x",
        });
    });

    it("hydrates omitted chat-history images from raw transcripts", async () => {
        const transcriptDir = path.join(openclawHome, "agents", "main", "sessions");
        await mkdir(transcriptDir, { recursive: true });
        await writeFile(
            path.join(transcriptDir, "session-1.jsonl"),
            [
                "not json",
                '{"type":"image",',
                JSON.stringify({ type: "image", message: null }),
                JSON.stringify({ timestamp: 1, message: null }),
                JSON.stringify({
                    timestamp: 2,
                    type: "image",
                    message: { role: "user", content: "not-array" },
                }),
                JSON.stringify({
                    type: "image",
                    message: {
                        role: "user",
                        content: [{ type: "image", source: {} }],
                    },
                }),
                JSON.stringify({
                    timestamp: 4,
                    message: {
                        content: [
                            {
                                type: "image",
                                data: "raw-direct",
                                mimeType: "image/webp",
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    timestamp: 3,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "no image blocks" }],
                    },
                }),
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
                JSON.stringify({
                    timestamp: 1_700_000_000_001,
                    message: {
                        role: "user",
                        content: [
                            {
                                type: "image",
                                source: { data: "raw-default-mime" },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    timestamp: 1_700_000_000_002,
                    message: {
                        role: "user",
                        content: [
                            {
                                type: "image",
                                data: "   ",
                                source: {
                                    data: "raw-source-fallback",
                                    media_type: "image/gif",
                                },
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
        assert.equal(
            __testing.readRawTranscriptImageMessages("agent:main:main", "missing").length,
            0
        );
        assert.deepEqual(__testing.readRawTranscriptImageMessages("malformed-key"), []);
        const rawMessages = __testing.readRawTranscriptImageMessages(
            "agent:main:main",
            "session-1"
        );
        assert.equal(rawMessages.length, 4);
        assert.equal(rawMessages[0]?.role, "unknown");
        assert.deepEqual(rawMessages[0]?.images[0], {
            type: "image",
            data: "raw-direct",
            mimeType: "image/webp",
        });
        assert.ok(
            rawMessages.some(
                (message) =>
                    message.images[0]?.data === "raw-default-mime" &&
                    message.images[0]?.mimeType === "image/jpeg"
            )
        );
        assert.ok(
            rawMessages.some(
                (message) =>
                    message.images[0]?.data === "raw-source-fallback" &&
                    message.images[0]?.mimeType === "image/gif"
            )
        );
        const readFileSync = mock.method(fs, "readFileSync", () => {
            throw new Error("read denied");
        });
        try {
            assert.deepEqual(
                __testing.readRawTranscriptImageMessages("agent:main:main", "session-1"),
                []
            );
        } finally {
            readFileSync.mock.restore();
        }

        assert.deepEqual(__testing.hydrateOmittedChatHistoryImages({ messages: [] }), {
            messages: [],
        });
        assert.equal(__testing.getTranscriptPath("agent:main:unknown"), null);
        assert.equal(
            __testing.getTranscriptPath("channel:discord:main", "session-1"),
            null
        );
        const dottedAgentDir = path.join(openclawHome, "agents", "my.agent", "sessions");
        await mkdir(dottedAgentDir, { recursive: true });
        await writeFile(path.join(dottedAgentDir, "session-1.jsonl"), "", "utf8");
        assert.equal(__testing.getTranscriptPath("agent:", "session-1"), null);
        assert.equal(__testing.getTranscriptPath("agent::main", "session-1"), null);
        assert.match(
            __testing.getTranscriptPath("agent:my.agent:main", "session-1") || "",
            /agents\/my\.agent\/sessions\/session-1\.jsonl$/u
        );
        assert.equal(
            __testing.getTranscriptPath("agent:../main:main", "session-1"),
            null
        );
        assert.equal(
            __testing.getTranscriptPath("agent:main:main", "../session-1"),
            null
        );
        await writeFile(path.join(transcriptDir, "agent:main:main.jsonl"), "", "utf8");
        assert.match(
            __testing.getTranscriptPath("agent:main:main", "agent:main:main") || "",
            /agents\/main\/sessions\/agent:main:main\.jsonl$/u
        );
        const outsideTranscript = path.join(openclawHome, "outside.jsonl");
        await writeFile(outsideTranscript, "", "utf8");
        await symlink(
            outsideTranscript,
            path.join(transcriptDir, "linked-session.jsonl")
        );
        assert.equal(
            __testing.getTranscriptPath("agent:main:main", "linked-session"),
            null
        );
        await symlink(
            path.join(openclawHome, "agents", "main"),
            path.join(openclawHome, "agents", "linked-agent")
        );
        assert.equal(
            __testing.getTranscriptPath("agent:linked-agent:main", "session-1"),
            null
        );
        assert.equal(
            __testing.isPathInsideRoot("/tmp/openclaw", "/tmp/elsewhere/file"),
            false
        );
        assert.equal(
            __testing.resolvePathInsideRoot("/tmp/openclaw", "/tmp/elsewhere/file"),
            null
        );
        assert.deepEqual(
            __testing.hydrateOmittedChatHistoryImages(
                {
                    sessionId: "session-1",
                    messages: [
                        "primitive",
                        { role: "user", content: [{ type: "text", text: "no image" }] },
                        {
                            role: "user",
                            timestamp: "2024-01-01T00:00:00.000Z",
                            content: [
                                { type: "text", text: "different" },
                                { type: "image", source: { omitted: true } },
                            ],
                        },
                    ],
                },
                "agent:main:main"
            ),
            {
                sessionId: "session-1",
                messages: [
                    "primitive",
                    { role: "user", content: [{ type: "text", text: "no image" }] },
                    {
                        role: "user",
                        timestamp: "2024-01-01T00:00:00.000Z",
                        content: [
                            { type: "text", text: "different" },
                            { type: "image", source: { omitted: true } },
                        ],
                    },
                ],
            }
        );

        const roleFallbackHydrated = __testing.hydrateOmittedChatHistoryImages(
            {
                sessionId: "session-1",
                messages: [
                    {
                        content: [{ type: "image", source: { omitted: true } }],
                    },
                ],
            },
            "agent:main:main"
        ) as { messages: Array<{ content: unknown[] }> };
        assert.deepEqual(roleFallbackHydrated.messages[0]?.content[0], {
            type: "image",
            data: "raw-direct",
            mimeType: "image/webp",
        });

        const missingRawImageHydrated = __testing.hydrateOmittedChatHistoryImages(
            {
                sessionId: "session-1",
                messages: [
                    {
                        role: "user",
                        timestamp: "2023-11-14T22:13:20.000Z",
                        content: [
                            { type: "text", text: "look" },
                            { type: "image", source: { omitted: true } },
                            { type: "image", source: { omitted: true } },
                        ],
                    },
                ],
            },
            "agent:main:main"
        ) as { messages: Array<{ content: unknown[] }> };
        assert.deepEqual(missingRawImageHydrated.messages[0]?.content[2], {
            type: "image",
            source: { omitted: true },
        });
    });

    it("normalizes primitive helpers and disconnected gateway behavior", async () => {
        __testing.setSessionListForTest([
            __testing.transformSession({
                key: "agent:main:main",
                sessionId: "session-1",
            }),
        ]);

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
        assert.equal(__testing.shouldRetrySessionIndexSubscription(2), true);
        assert.equal(__testing.shouldRetrySessionIndexSubscription(3), false);

        assert.deepEqual(gateway.getStatus(), {
            gateway: "disconnected",
            sessions: 1,
        });
        assert.equal(gateway.isConnected(), false);
        assert.equal(gateway.getGatewayWs(), null);
        await __testing.refreshSessions();
        await assert.rejects(() => gateway.request("sessions.list", {}), {
            message: "Gateway not connected",
        });
    });

    it("handles WebSocket clients and disconnected request responses", async () => {
        __testing.setSessionListForTest([
            __testing.transformSession({
                key: "agent:main:main",
                sessionId: "session-1",
            }),
        ]);
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

        const throwingWs = new ThrowingWebSocket();
        gateway.handleClient(throwingWs as unknown as WebSocket);
        throwingWs.throwOnSend = true;
        __testing.setGatewayClientForTest(new FakeGatewayClient() as never);
        __testing.setGatewayConnectedForTest(true);
        await __testing.refreshSessions();
        throwingWs.emit("close");
    });

    it("discards stale session refresh results from replaced clients", async () => {
        const staleClient = new FakeGatewayClient();
        let releaseRefresh!: () => void;
        staleClient.request = async () => {
            await new Promise<void>((resolve) => {
                releaseRefresh = resolve;
            });
            return {
                sessions: [{ key: "agent:main:main", updatedAt: 1 }],
            };
        };

        __testing.setGatewayClientForTest(staleClient as never);
        __testing.setGatewayConnectedForTest(true);
        const refresh = __testing.refreshSessions(staleClient as never);
        const currentClient = new FakeGatewayClient();
        __testing.setGatewayClientForTest(currentClient as never);
        releaseRefresh();
        await refresh;

        assert.deepEqual(gateway.getSessions(), []);
    });

    it("discards session refresh results when the Gateway disconnects mid-request", async () => {
        const client = new FakeGatewayClient();
        let releaseRefresh!: () => void;
        client.request = async () => {
            await new Promise<void>((resolve) => {
                releaseRefresh = resolve;
            });
            return {
                sessions: [{ key: "agent:main:main", updatedAt: 1 }],
            };
        };

        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);
        const refresh = __testing.refreshSessions(client as never);
        __testing.setGatewayConnectedForTest(false);
        releaseRefresh();
        await refresh;

        assert.deepEqual(gateway.getSessions(), []);
    });

    it("treats malformed session list payloads as empty", async () => {
        const client = new FakeGatewayClient();
        client.responses.set("sessions.list", { sessions: { key: "agent:main:main" } });
        __testing.setSessionListForTest([
            __testing.transformSession({
                key: "agent:main:main",
                sessionId: "session-1",
            }),
        ]);
        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);

        await __testing.refreshSessions(client as never);

        assert.deepEqual(gateway.getSessions(), []);
    });

    it("handles log subscription request aliases", async () => {
        const ws = new FakeWebSocket();
        gateway.handleClient(ws as unknown as WebSocket);

        try {
            ws.emit(
                "message",
                Buffer.from(
                    JSON.stringify({
                        id: "subscribe-1",
                        method: "subscribe",
                        params: { channel: "logs" },
                        type: "req",
                    })
                )
            );
            ws.emit(
                "message",
                Buffer.from(
                    JSON.stringify({
                        id: "unsubscribe-1",
                        method: "unsubscribe",
                        params: { channel: "logs" },
                        type: "request",
                    })
                )
            );
            ws.emit(
                "message",
                Buffer.from(JSON.stringify({ channel: "logs", type: "subscribe" }))
            );
            ws.emit(
                "message",
                Buffer.from(JSON.stringify({ channel: "logs", type: "unsubscribe" }))
            );
            await waitForAsyncHandlers();

            const responses = ws.sent.map(
                (entry) => JSON.parse(entry) as { id?: string }
            );
            assert.deepEqual(
                responses.find((entry) => entry.id === "subscribe-1"),
                {
                    type: "res",
                    id: "subscribe-1",
                    ok: true,
                }
            );
            assert.deepEqual(
                responses.find((entry) => entry.id === "unsubscribe-1"),
                {
                    type: "res",
                    id: "unsubscribe-1",
                    ok: true,
                }
            );
        } finally {
            ws.emit("close");
            logsTesting.resetLogWatcherForTest();
        }
    });

    it("refreshes sessions and broadcasts connected request results", async () => {
        const client = new FakeGatewayClient();
        client.responses.set("sessions.list", {
            sessions: [
                {
                    key: "agent:main:main",
                    sessionId: "session-2",
                    totalTokens: 10,
                },
            ],
        });
        client.responses.set("chat.history", {
            messages: [],
            sessionKey: "agent:main:main",
        });
        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);

        const ws = new FakeWebSocket();
        gateway.handleClient(ws as unknown as WebSocket);
        await __testing.refreshSessions();

        assert.equal(gateway.isConnected(), true);
        assert.equal(gateway.getStatus().gateway, "connected");
        assert.equal(gateway.getSessions()[0]?.id, "session-2");
        const sessionsBroadcast = JSON.parse(ws.sent.at(-1) || "{}") as {
            sessions?: Array<{ id?: string }>;
            type?: string;
        };
        assert.equal(sessionsBroadcast.type, "sessions");
        assert.equal(sessionsBroadcast.sessions?.[0]?.id, "session-2");

        const forwarded = await __testing.forwardRequest(
            "chat.history",
            { sessionKey: "agent:main:main" },
            ws as unknown as WebSocket,
            "client-request-2"
        );
        assert.equal(forwarded, true);
        assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
            type: "res",
            id: "client-request-2",
            ok: true,
            payload: {
                messages: [],
                sessionKey: "agent:main:main",
            },
        });

        const sessionsForwarded = await __testing.forwardRequest(
            "sessions.delete",
            { key: "agent:main:main" },
            ws as unknown as WebSocket,
            "client-request-4"
        );
        assert.equal(sessionsForwarded, true);

        ws.emit(
            "message",
            Buffer.from(
                JSON.stringify({
                    id: "client-request-5",
                    method: "chat.history",
                    type: "req",
                })
            )
        );
        await waitForAsyncHandlers();
        assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
            type: "res",
            id: "client-request-5",
            ok: true,
            payload: {
                messages: [],
                sessionKey: "agent:main:main",
            },
        });

        await gateway.sendSessionMessage("agent:main:main", "hello");
        await gateway.abortSessionRun("agent:main:main");
        const deleted = await gateway.deleteSession("agent:main:main");

        assert.deepEqual(deleted, {});
        assert.deepEqual(
            client.calls.map((call) => call.method),
            [
                "sessions.list",
                "chat.history",
                "sessions.delete",
                "sessions.list",
                "chat.history",
                "chat.send",
                "chat.abort",
                "sessions.delete",
                "sessions.list",
            ]
        );
        assert.equal(
            (client.calls.find((call) => call.method === "chat.send")?.params || {})
                .sessionKey,
            "agent:main:main"
        );
    });

    it("reports connected request failures and non-client forwarding results", async () => {
        const client = new FakeGatewayClient();
        client.failures.set("chat.history", new Error("history failed"));
        client.failures.set("chat.send", new Error("send failed"));
        client.failures.set("sessions.delete", new Error("delete failed"));
        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);

        const ws = new FakeWebSocket();
        const forwarded = await __testing.forwardRequest(
            "chat.history",
            {},
            ws as unknown as WebSocket,
            "client-request-3"
        );

        assert.equal(forwarded, true);
        assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
            type: "res",
            id: "client-request-3",
            ok: false,
            error: "history failed",
        });
        client.failures.delete("sessions.delete");
        assert.equal(await __testing.forwardRequest("chat.send", {}), false);
        assert.equal(await __testing.forwardRequest("sessions.delete", {}), true);
        client.failures.set("sessions.delete", new Error("delete failed"));
        await assert.rejects(() => gateway.deleteSession("agent:main:main"), {
            message: "delete failed",
        });
    });

    it("skips responses for closed client sockets and reports delete refresh warnings", async () => {
        await __testing.refreshSessions();

        const warn = mock.method(console, "warn", () => {});
        const client = new FakeGatewayClient();
        client.responses.set("chat.history", { ok: true });
        client.responses.set("sessions.delete", { deleted: true });
        client.failures.set("sessions.list", new Error("refresh unavailable"));
        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);

        try {
            const ws = new FakeWebSocket();
            ws.readyState = WebSocket.CLOSED;

            assert.equal(
                await __testing.forwardRequest(
                    "chat.history",
                    {},
                    ws as unknown as WebSocket,
                    "closed-success"
                ),
                true
            );
            client.failures.set("chat.history", new Error("closed failure"));
            assert.equal(
                await __testing.forwardRequest(
                    "chat.history",
                    {},
                    ws as unknown as WebSocket,
                    "closed-failure"
                ),
                true
            );
            assert.equal(ws.sent.length, 0);

            assert.deepEqual(await gateway.deleteSession("agent:main:main"), {
                deleted: true,
            });
            assert.equal(warn.mock.callCount(), 1);
        } finally {
            warn.mock.restore();
        }
    });

    it("sends session request responses before refresh failures are reported", async () => {
        const client = new FakeGatewayClient();
        client.responses.set("sessions.delete", { deleted: true });
        client.failures.set("sessions.list", new Error("refresh unavailable"));
        __testing.setGatewayClientForTest(client as never);
        __testing.setGatewayConnectedForTest(true);

        const ws = new FakeWebSocket();
        const forwarded = await __testing.forwardRequest(
            "sessions.delete",
            { key: "agent:main:main" },
            ws as unknown as WebSocket,
            "session-delete"
        );

        assert.equal(forwarded, true);
        assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
            type: "res",
            id: "session-delete",
            ok: true,
            payload: { deleted: true },
        });
    });
});
