import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import { OpenClawChatBridge } from "../src/chat/openClawChatBridge.ts";
import type { DashboardSocket } from "../src/dashboardSocket.ts";
import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
    OpenClawGatewayRequestOptions,
} from "../src/lib/openclawGatewayClient.ts";

const cleanupCallbacks: Array<() => void> = [];
const fakeClients: FakeOpenClawGatewayClient[] = [];

function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function waitFor(isReady: () => boolean, timeoutMilliseconds = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    return new Promise((resolve, reject) => {
        const tick = () => {
            try {
                if (isReady()) {
                    resolve();
                    return;
                }
            } catch (error) {
                reject(error);
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error("Timed out waiting for gateway test condition"));
                return;
            }
            setTimeout(tick, 10);
        };
        tick();
    });
}

class FakeOpenClawGatewayClient implements OpenClawGatewayClientInstance {
    readonly requests: Array<{
        method: string;
        options?: OpenClawGatewayRequestOptions;
        parameters: Record<string, unknown>;
    }> = [];
    isStarted = false;
    isStopped = false;
    closeOnStop = false;

    constructor(readonly options: OpenClawGatewayClientOptions) {
        fakeClients.push(this);
    }

    start(): void {
        this.isStarted = true;
    }

    stop(): void {
        this.isStopped = true;
        if (this.closeOnStop) {
            this.options.onClose?.(1000, "Gateway client stopped");
        }
    }

    async request(
        method: string,
        parameters?: unknown,
        options?: OpenClawGatewayRequestOptions
    ): Promise<unknown> {
        const requestParameters =
            parameters && typeof parameters === "object"
                ? (parameters as Record<string, unknown>)
                : {};
        this.requests.push({ method, options, parameters: requestParameters });
        if (method === "sessions.list") {
            return {
                defaults: {
                    contextTokens: 32_000,
                    model: "openai/gpt-test",
                    modelProvider: "openai",
                    fastMode: true,
                    thinkingDefault: "minimal",
                    thinkingLevels: [
                        { id: "minimal", label: "minimal" },
                        { id: "high", label: "high" },
                    ],
                    thinkingOptions: ["minimal", "high"],
                },
                sessions: [
                    {
                        activeRunId: "run-1",
                        hasActiveRun: true,
                        channel: "main",
                        contextTokens: 20_000,
                        displayName: "Main",
                        key: "agent:main:main",
                        kind: "chat",
                        label: "",
                        model: "openai/gpt-test",
                        modelProvider: "openai",
                        sessionId: "sess1",
                        status: "running",
                        thinkingDefault: "low",
                        thinkingLevel: "medium",
                        thinkingLevels: [
                            { id: "low", label: "low" },
                            { id: "medium", label: "medium" },
                        ],
                        thinkingOptions: ["low", "medium"],
                        fastMode: "auto",
                        effectiveFastMode: true,
                        totalTokens: 42,
                        totalTokensFresh: false,
                        updatedAt: "2026-06-25T00:00:00.000Z",
                    },
                    {
                        key: "agent:researcher:subagent:abc",
                        label: "",
                        model: "anthropic/claude-test",
                        sessionId: "sess2",
                        updatedAt: 1_782_345_600_000,
                    },
                    {
                        key: "agent:other:subagent:same-model",
                        label: "",
                        model: "openai/gpt-test",
                        modelProvider: "openrouter",
                        sessionId: "sess-provider-mismatch",
                        updatedAt: 1_782_345_550_000,
                    },
                    {
                        key: "agent:legacy:subagent:options-only",
                        label: "",
                        model: "openai/gpt-test",
                        modelProvider: "openai",
                        sessionId: "sess-options-only",
                        thinkingOptions: ["off", "on"],
                        updatedAt: 1_782_345_525_000,
                    },
                    {
                        key: "agent:main:hook:deploy",
                        model: "",
                        modelProvider: "",
                        sessionId: "sess3",
                        thinkingLevels: [],
                        thinkingOptions: [],
                        updatedAt: 1_782_345_500_000,
                    },
                    { key: "", sessionId: "", updatedAt: "invalid" },
                ],
            };
        }
        if (method === "sessions.subscribe") {
            return { isOk: true };
        }
        if (method === "chat.send") {
            if (requestParameters.message === "fail chat") {
                throw new Error("chat send rejected");
            }
            return { runId: "acknowledged-run" };
        }
        if (method === "chat.history") {
            return {
                messages: [
                    {
                        content: [
                            { text: "see image", type: "text" },
                            { source: { omitted: true }, type: "image" },
                        ],
                        role: "assistant",
                        timestamp: 1_782_345_600_000,
                    },
                ],
                sessionId: "sess1",
                sessionKey: "agent:main:main",
            };
        }
        if (method === "demo.fail") {
            throw new Error("gateway rejected");
        }
        return { echoed: { method, parameters: requestParameters } };
    }
}

class FakeDashboardSocket implements DashboardSocket {
    private closeHandler: (() => void) | undefined;
    private errorHandler: ((error: unknown) => void) | undefined;
    private messageHandler: ((data: string | Buffer) => void) | undefined;
    readonly sent: string[] = [];
    isClosed = false;

    close(): void {
        this.isClosed = true;
        this.closeHandler?.();
    }

    isOpen(): boolean {
        return !this.isClosed;
    }

    onClose(handler: () => void): void {
        this.closeHandler = handler;
    }

    onError(handler: (error: unknown) => void): void {
        this.errorHandler = handler;
    }

    onMessage(handler: (data: string | Buffer) => void): void {
        this.messageHandler = handler;
    }

    send(data: string): void {
        this.sent.push(data);
    }

    emitMessage(payload: unknown): void {
        this.messageHandler?.(JSON.stringify(payload));
    }

    emitRawMessage(payload: string): void {
        this.messageHandler?.(payload);
    }

    emitError(error: unknown): void {
        this.errorHandler?.(error);
    }
}

function sessionActionRequest(action: string): Request & { params: { id: string } } {
    return Object.assign(
        new Request("https://test.local/api/sessions/agent:main:main/action", {
            body: JSON.stringify({ action }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        { params: { id: "agent:main:main" } }
    );
}

function sessionDeleteRequest(): Request & { params: { id: string } } {
    return Object.assign(new Request("https://test.local/api/sessions/agent:main:main"), {
        params: { id: "agent:main:main" },
    });
}

afterEach(() => {
    fakeClients.length = 0;
    const errors: unknown[] = [];
    while (cleanupCallbacks.length > 0) {
        try {
            cleanupCallbacks.pop()?.();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Gateway test cleanup failed");
    }
});

describe("gateway behavior", () => {
    it("waits through transient connect errors during bootstrap", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const root = createTemporaryRoot("mira-gateway-bootstrap-transient-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );

        const initPromise = gateway.initAndWait("valid-token");
        const client = fakeClients.at(-1);
        expect(client).toBeDefined();
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        client?.options.onConnectError?.(new Error("gateway websocket error"));
        client?.options.onHelloOk?.({ type: "hello-ok" });

        await expect(initPromise).resolves.toBeUndefined();
        expect(gateway.isConnected()).toBe(true);
    });

    it("rejects bootstrap immediately on Gateway auth failures", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const root = createTemporaryRoot("mira-gateway-bootstrap-auth-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );

        const initPromise = gateway.initAndWait("bad-token");
        const client = fakeClients.at(-1);
        expect(client).toBeDefined();
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        client?.options.onConnectError?.(
            new Error("unauthorized: gateway token mismatch")
        );

        await expect(initPromise).rejects.toThrow("gateway token mismatch");
        expect(gateway.isConnected()).toBe(false);
    });

    it("captures replay request boundaries only for chat sends", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const root = createTemporaryRoot("mira-gateway-request-boundary-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );
        const captureBoundary = jest
            .spyOn(OpenClawChatBridge.prototype, "captureRequestBoundary")
            .mockImplementation(() => {
                throw new Error("unexpected replay boundary capture");
            });
        const failBoundary = jest.spyOn(
            OpenClawChatBridge.prototype,
            "handleFailedRequest"
        );
        cleanupCallbacks.push(
            () => failBoundary.mockRestore(),
            () => captureBoundary.mockRestore()
        );

        gateway.init("request-boundary-token");
        const client = fakeClients.at(-1);
        client?.options.onHelloOk?.({ type: "hello-ok" });
        await waitFor(() => gateway.isConnected());

        await expect(
            gateway.request("models.list", { sessionKey: "agent:main:main" })
        ).resolves.toBeDefined();

        const socket = new FakeDashboardSocket();
        gateway.handleDashboardClient(socket);
        socket.emitMessage({
            id: "models-with-response",
            method: "models.list",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some(
                (raw) =>
                    raw.includes('"id":"models-with-response"') &&
                    raw.includes('"isOk":true')
            )
        );

        const requestCount = client?.requests.length ?? 0;
        socket.emitMessage({
            method: "models.list",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() => (client?.requests.length ?? 0) > requestCount);

        expect(captureBoundary).not.toHaveBeenCalled();
        captureBoundary.mockReturnValue(0);
        await expect(
            gateway.request("chat.send", {
                message: "hello",
                sessionKey: "agent:main:main",
            })
        ).resolves.toBeDefined();
        expect(captureBoundary).toHaveBeenCalledTimes(1);
        const failedParameters = {
            idempotencyKey: "dashboard-chat-failed-request",
            message: "fail chat",
            sessionKey: "agent:main:main",
        };
        await expect(gateway.request("chat.send", failedParameters)).rejects.toThrow(
            "chat send rejected"
        );
        expect(failBoundary).toHaveBeenCalledWith("chat.send", failedParameters, 0);
        expect(captureBoundary).toHaveBeenCalledTimes(2);
        socket.close();
    });

    it("rehydrates run associations before reconnect events resume", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        const root = createTemporaryRoot("mira-gateway-reconnect-replay-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;
        process.env.OPENCLAW_GATEWAY_URL = "ws://gateway-reconnect.test";

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );
        const socket = new FakeDashboardSocket();
        gateway.handleDashboardClient(socket);

        gateway.init("reconnect-replay-token");
        const firstClient = fakeClients.at(-1);
        firstClient?.options.onHelloOk?.({ type: "hello-ok" });
        firstClient?.options.onEvent?.({
            event: "session.tool",
            payload: {
                name: "before-reconnect",
                runId: "reconnect-run",
                sessionKey: "agent:main:main",
            },
        });
        gateway.shutdown();

        socket.sent.length = 0;
        gateway.init("reconnect-replay-token");
        const reconnectedClient = fakeClients.at(-1);
        expect(reconnectedClient).not.toBe(firstClient);
        reconnectedClient?.options.onHelloOk?.({ type: "hello-ok" });
        reconnectedClient?.options.onEvent?.({
            event: "session.tool",
            payload: { name: "after-reconnect", runId: "reconnect-run" },
        });

        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"name":"after-reconnect"'))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            event?: string;
                            payload?: { name?: string; sessionKey?: string };
                        }
                )
                .find((message) => message.payload?.name === "after-reconnect")
        ).toMatchObject({
            event: "session.tool",
            payload: {
                name: "after-reconnect",
                sessionKey: "agent:main:main",
            },
        });
    });

    it("keeps a continued response ordered across a live Gateway reconnect", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        const root = createTemporaryRoot("mira-gateway-live-reconnect-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;
        process.env.OPENCLAW_GATEWAY_URL = "ws://gateway-live-reconnect.test";

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );
        const socket = new FakeDashboardSocket();
        gateway.handleDashboardClient(socket);

        gateway.init("live-reconnect-token");
        const client = fakeClients.at(-1);
        client?.options.onHelloOk?.({ type: "hello-ok" });
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "thinking before restart" },
                runId: "dashboard-chat-before-restart",
                sessionKey: "agent:main:main",
                stream: "thinking",
            },
        });

        client?.options.onClose?.(1006, "Gateway restarted");
        client?.options.onHelloOk?.({ type: "hello-ok" });
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { phase: "start" },
                runId: "provider-after-restart",
                sessionKey: "agent:main:main",
                stream: "lifecycle",
            },
        });
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "thinking after restart" },
                runId: "provider-after-restart",
                sessionKey: "agent:main:main",
                stream: "thinking",
            },
        });
        client?.options.onEvent?.({
            event: "session.message",
            payload: {
                message: { content: "steer after restart", role: "user" },
                sessionKey: "agent:main:main",
            },
        });
        client?.options.onEvent?.({
            event: "session.tool",
            payload: {
                name: "after-steer",
                runId: "provider-after-restart",
                sessionKey: "agent:main:main",
            },
        });

        socket.emitMessage({
            id: "runtime-snapshot-live-reconnect",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-live-reconnect"')
            )
        );
        const events = socket.sent
            .map(
                (raw) =>
                    JSON.parse(raw) as {
                        id?: string;
                        payload?: {
                            events?: Array<{
                                event?: string;
                                payload?: { runId?: string };
                            }>;
                        };
                    }
            )
            .find((message) => message.id === "runtime-snapshot-live-reconnect")
            ?.payload?.events;

        expect(events?.map((event) => event.payload?.runId)).toEqual([
            "provider-after-restart",
            "provider-after-restart",
            "provider-after-restart",
            undefined,
            "provider-after-restart",
        ]);
        expect(events?.map((event) => event.event)).toEqual([
            "agent",
            "agent",
            "agent",
            "session.message",
            "session.tool",
        ]);
    });

    it("rotates the chat replay identity when Gateway credentials change", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        const root = createTemporaryRoot("mira-gateway-runtime-generation-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;
        process.env.OPENCLAW_GATEWAY_URL = "ws://gateway-generation.test";

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );
        const socket = new FakeDashboardSocket();
        gateway.handleDashboardClient(socket);
        const requestIdentity = async (
            id: string
        ): Promise<{ replayScope?: string; runtimeGeneration?: string } | undefined> => {
            socket.emitMessage({
                id,
                method: "chat.runtimeSnapshot",
                params: { sessionKey: "agent:main:main" },
                type: "request",
            });
            await waitFor(() => socket.sent.some((raw) => raw.includes(`"id":"${id}"`)));
            return socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: {
                                replayScope?: string;
                                runtimeGeneration?: string;
                            };
                        }
                )
                .find((message) => message.id === id)?.payload;
        };

        gateway.init("token-one");
        const firstIdentity = await requestIdentity("generation-one");
        gateway.init("token-two");
        const secondIdentity = await requestIdentity("generation-two");
        gateway.init("token-two");
        const unchangedIdentity = await requestIdentity("generation-unchanged");

        expect(firstIdentity).toMatchObject({
            replayScope: expect.any(String),
            runtimeGeneration: expect.any(String),
        });
        expect(secondIdentity).toMatchObject({
            replayScope: expect.any(String),
            runtimeGeneration: expect.any(String),
        });
        expect(secondIdentity?.runtimeGeneration).not.toBe(
            firstIdentity?.runtimeGeneration
        );
        expect(secondIdentity?.replayScope).not.toBe(firstIdentity?.replayScope);
        expect(unchangedIdentity).toMatchObject({
            replayScope: secondIdentity?.replayScope,
            runtimeGeneration: secondIdentity?.runtimeGeneration,
        });
        socket.close();
    });

    it("keeps synchronous close callbacks in the closing client's replay scope", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        const root = createTemporaryRoot("mira-gateway-replay-scope-close-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        mkdirSync(openclawHome, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;
        process.env.OPENCLAW_GATEWAY_URL = "ws://gateway-replay-scope-close.test";

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );

        const markGatewayDisconnected = jest.spyOn(
            OpenClawChatBridge.prototype,
            "markGatewayDisconnected"
        );
        cleanupCallbacks.push(() => markGatewayDisconnected.mockRestore());

        gateway.init("token-one");
        const firstClient = fakeClients.at(-1);
        expect(firstClient).toBeDefined();
        firstClient?.options.onClose?.(1006, "Gateway restarted");
        firstClient!.closeOnStop = true;

        gateway.init("token-two");

        expect(markGatewayDisconnected).toHaveBeenCalledTimes(3);
        expect(markGatewayDisconnected.mock.contexts[1]).toBe(
            markGatewayDisconnected.mock.contexts[0]
        );
        expect(markGatewayDisconnected.mock.contexts[2]).toBe(
            markGatewayDisconnected.mock.contexts[0]
        );
        expect(fakeClients.at(-1)).not.toBe(firstClient);

        firstClient?.options.onClose?.(1000, "Delayed close callback");
        expect(markGatewayDisconnected).toHaveBeenCalledTimes(3);
    });

    it("normalizes sessions, enriches events, and hydrates omitted chat images without a real gateway", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        const root = createTemporaryRoot("mira-gateway-behavior-");
        const openclawHome = path.join(root, "openclaw");
        const dashboardHome = path.join(root, "dashboard-openclaw");
        const transcriptDirectory = path.join(openclawHome, "agents", "main", "sessions");
        mkdirSync(transcriptDirectory, { recursive: true });
        mkdirSync(dashboardHome, { recursive: true });
        writeFileSync(
            path.join(transcriptDirectory, "sess1.jsonl"),
            `${JSON.stringify({
                message: {
                    content: [
                        { text: "see image", type: "text" },
                        {
                            source: {
                                data: "base64-image",
                                media_type: "image/png",
                            },
                            type: "image",
                        },
                    ],
                    role: "assistant",
                    timestamp: 1_782_345_600_000,
                },
            })}\n`
        );
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardHome;
        process.env.OPENCLAW_GATEWAY_URL = "ws://gateway.test";

        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        cleanupCallbacks.push(
            gatewayModule.setGatewayRootsForTests({
                dashboardOpenClawHome: dashboardHome,
                openClawHome: openclawHome,
            }),
            gatewayModule.setGatewayClientConstructorForTests(FakeOpenClawGatewayClient),
            () => gateway.shutdown()
        );
        const socket = new FakeDashboardSocket();
        gateway.handleDashboardClient(socket);
        gateway.init("token-one");
        const client = fakeClients.at(-1);
        expect(client).toBeDefined();
        expect(client?.isStarted).toBe(true);
        expect(client?.options.url).toBe("ws://gateway.test");

        gateway.init("token-one");
        expect(fakeClients.length).toBe(1);

        client?.options.onHelloOk?.({ type: "hello-ok" });
        await waitFor(() =>
            socket.sent.some((raw) => {
                const parsed = JSON.parse(raw) as { type?: string };
                return parsed.type === "sessions";
            })
        );

        const sessionsMessage = socket.sent
            .map((raw) => JSON.parse(raw) as { sessions?: unknown[]; type?: string })
            .find((message) => message.type === "sessions");
        expect(sessionsMessage?.sessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayLabel: "",
                    id: "sess1",
                    key: "agent:main:main",
                    model: "openai/gpt-test",
                    modelProvider: "openai",
                    thinkingDefault: "low",
                    thinkingLevel: "medium",
                    thinkingLevels: [
                        { id: "low", label: "low" },
                        { id: "medium", label: "medium" },
                    ],
                    thinkingOptions: ["low", "medium"],
                    fastMode: "auto",
                    effectiveFastMode: true,
                    hasActiveRun: true,
                    totalTokensFresh: false,
                    type: "MAIN",
                }),
                expect.objectContaining({
                    agentType: "researcher",
                    displayLabel: "Researcher",
                    maxTokens: 0,
                    model: "anthropic/claude-test",
                    type: "SUBAGENT",
                }),
                expect.objectContaining({
                    agentType: "legacy",
                    model: "openai/gpt-test",
                    thinkingOptions: ["off", "on"],
                    type: "SUBAGENT",
                }),
                expect.objectContaining({
                    displayLabel: "Deploy",
                    effectiveFastMode: true,
                    hookName: "deploy",
                    maxTokens: 32_000,
                    model: "openai/gpt-test",
                    modelProvider: "openai",
                    thinkingDefault: "minimal",
                    thinkingLevels: [
                        { id: "minimal", label: "minimal" },
                        { id: "high", label: "high" },
                    ],
                    type: "HOOK",
                }),
            ])
        );

        socket.emitMessage({
            id: "compact-session",
            method: "sessions.compact",
            params: { key: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            Boolean(client?.requests.some(({ method }) => method === "sessions.compact"))
        );
        expect(
            client?.requests.find(({ method }) => method === "sessions.compact")
        ).toMatchObject({
            options: { shouldWaitIndefinitely: true },
            parameters: { key: "agent:main:main" },
        });
        const researcherSession = sessionsMessage?.sessions?.find(
            (session) =>
                (session as { key?: string }).key === "agent:researcher:subagent:abc"
        ) as Record<string, unknown> | undefined;
        expect(researcherSession).not.toHaveProperty("thinkingDefault");
        expect(researcherSession).not.toHaveProperty("thinkingLevels");
        expect(researcherSession).not.toHaveProperty("thinkingOptions");
        const hookSession = sessionsMessage?.sessions?.find(
            (session) => (session as { key?: string }).key === "agent:main:hook:deploy"
        ) as Record<string, unknown> | undefined;
        expect(hookSession).not.toHaveProperty("fastMode");
        const legacyOptionsSession = sessionsMessage?.sessions?.find(
            (session) =>
                (session as { key?: string }).key === "agent:legacy:subagent:options-only"
        ) as Record<string, unknown> | undefined;
        expect(legacyOptionsSession).not.toHaveProperty("thinkingLevels");
        const providerMismatchSession = sessionsMessage?.sessions?.find(
            (session) =>
                (session as { key?: string }).key === "agent:other:subagent:same-model"
        ) as Record<string, unknown> | undefined;
        expect(providerMismatchSession).toMatchObject({
            maxTokens: 0,
            model: "openai/gpt-test",
            modelProvider: "openrouter",
        });
        expect(providerMismatchSession).not.toHaveProperty("thinkingDefault");
        expect(providerMismatchSession).not.toHaveProperty("thinkingLevels");
        expect(providerMismatchSession).not.toHaveProperty("thinkingOptions");

        client?.options.onEvent?.({
            event: "session.tool",
            payload: { name: "tool", runId: "run-1" },
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"event":"session.tool"'))
        );
        expect(
            socket.sent
                .map((raw) => JSON.parse(raw) as { event?: string; payload?: unknown })
                .find((message) => message.event === "session.tool")
        ).toMatchObject({
            payload: { name: "tool", runId: "run-1", sessionKey: "agent:main:main" },
        });

        socket.emitMessage({
            id: "runtime-snapshot-1",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-1"'))
        );
        const runtimeSnapshot = socket.sent
            .map(
                (raw) =>
                    JSON.parse(raw) as {
                        id?: string;
                        payload?: {
                            events?: Array<Record<string, unknown>>;
                            replayScope?: string;
                            runtimeGeneration?: string;
                            throughSequence?: number;
                        };
                    }
            )
            .find((message) => message.id === "runtime-snapshot-1");
        expect(runtimeSnapshot?.payload).toMatchObject({
            events: [
                {
                    event: "session.tool",
                    payload: {
                        name: "tool",
                        runId: "run-1",
                        sessionKey: "agent:main:main",
                    },
                    runtimeSequence: expect.any(Number),
                    type: "event",
                },
            ],
            replayScope: expect.any(String),
            runtimeGeneration: expect.any(String),
            throughSequence: expect.any(Number),
        });
        expect(
            client?.requests.some(({ method }) => method === "chat.runtimeSnapshot")
        ).toBe(false);

        client?.options.onEvent?.({
            event: "chat",
            payload: {
                message: { role: "assistant", text: "done" },
                runId: "run-1",
                sessionKey: "agent:main:main",
                state: "final",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-completed",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-completed"'))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: { completed?: boolean };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-completed")?.payload
                ?.completed
        ).toBe(true);
        client?.options.onEvent?.({
            event: "session.ended",
            payload: {
                sessionKey: "agent:main:main",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-after-runless-terminal",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-after-runless-terminal"')
            )
        );
        const eventsAfterRunlessTerminal = socket.sent
            .map(
                (raw) =>
                    JSON.parse(raw) as {
                        id?: string;
                        payload?: {
                            events?: Array<{ event?: string; payload?: unknown }>;
                        };
                    }
            )
            .find((message) => message.id === "runtime-snapshot-after-runless-terminal")
            ?.payload?.events;
        expect(
            eventsAfterRunlessTerminal?.some(
                (event) =>
                    event.event === "chat" &&
                    (event.payload as { state?: string } | undefined)?.state === "final"
            )
        ).toBe(true);
        expect(
            eventsAfterRunlessTerminal?.some((event) => event.event === "session.ended")
        ).toBe(false);
        client?.options.onEvent?.({
            event: "chat",
            payload: {
                runId: "aborted-after-final",
                sessionKey: "agent:main:main",
                state: "aborted",
            },
        });
        client?.options.onEvent?.({
            event: "session.ended",
            payload: {
                sessionKey: "agent:main:main",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-after-aborted-run",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-after-aborted-run"')
            )
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: {
                                events?: Array<{
                                    event?: string;
                                    payload?: { runId?: string; state?: string };
                                }>;
                            };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-after-aborted-run")
                ?.payload?.events
        ).toEqual([
            expect.objectContaining({
                event: "chat",
                payload: expect.objectContaining({
                    runId: "aborted-after-final",
                    state: "aborted",
                }),
            }),
        ]);
        client?.options.onEvent?.({
            event: "chat",
            payload: {
                deltaText: "next",
                runId: "run-2",
                sessionKey: "agent:main:main",
                state: "delta",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-2",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-2"'))
        );
        const nextRuntimeEvents = socket.sent
            .map(
                (raw) =>
                    JSON.parse(raw) as {
                        id?: string;
                        payload?: { events?: Array<{ payload?: { runId?: string } }> };
                    }
            )
            .find((message) => message.id === "runtime-snapshot-2")?.payload?.events;
        expect(nextRuntimeEvents).toHaveLength(1);
        expect(nextRuntimeEvents?.[0]?.payload?.runId).toBe("run-2");

        socket.emitMessage({
            id: "history-1",
            method: "chat.history",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() => socket.sent.some((raw) => raw.includes('"id":"history-1"')));
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: { messages?: Array<{ content?: unknown[] }> };
                        }
                )
                .find((message) => message.id === "history-1")
        ).toMatchObject({
            payload: {
                messages: [
                    {
                        content: [
                            { text: "see image", type: "text" },
                            {
                                data: "base64-image",
                                mimeType: "image/png",
                                type: "image",
                            },
                        ],
                    },
                ],
            },
        });

        const { sessionRoutes } = await import("../src/routes/sessionRoutes.ts");
        const filteredSessions = await sessionRoutes["/api/sessions/list"].GET(
            new Request("https://test.local/api/sessions/list?type=MAIN&model=gpt-test")
        );
        await expect(filteredSessions.json()).resolves.toEqual({
            sessions: [
                expect.objectContaining({
                    key: "agent:main:main",
                    model: "openai/gpt-test",
                    type: "MAIN",
                }),
            ],
        });

        const stats = await sessionRoutes["/api/sessions/stats"].GET();
        await expect(stats.json()).resolves.toMatchObject({
            byModel: {
                "anthropic/claude-test": 1,
                "openai/gpt-test": 4,
            },
            byType: {
                HOOK: 1,
                MAIN: 1,
                SUBAGENT: 3,
            },
            total: 5,
            totalTokens: 42,
        });

        const compact = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("compact")
        );
        await expect(compact.json()).resolves.toEqual({
            action: "compact",
            isSuccess: true,
        });

        const reset = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("reset")
        );
        expect(reset.status).toBe(200);
        socket.emitMessage({
            id: "runtime-snapshot-after-reset",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-after-reset"'))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: { completed?: boolean; events?: unknown[] };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-after-reset")?.payload
        ).toMatchObject({ completed: false, events: [] });

        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "partial before stop" },
                runId: "stopped-run",
                sessionKey: "agent:main:main",
                stream: "thinking",
            },
        });
        const stop = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("stop")
        );
        expect(stop.status).toBe(200);
        socket.emitMessage({
            id: "runtime-snapshot-after-stop",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-after-stop"'))
        );
        expect(
            socket.sent.find((raw) => raw.includes('"id":"runtime-snapshot-after-stop"'))
        ).toContain('"events":[]');

        const unsupported = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("archive")
        );
        expect(unsupported.status).toBe(400);

        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "partial before delete" },
                runId: "deleted-run",
                sessionKey: "agent:main:main",
                stream: "thinking",
            },
        });
        const deleted =
            await sessionRoutes["/api/sessions/:id"].DELETE(sessionDeleteRequest());
        await expect(deleted.json()).resolves.toMatchObject({
            isSuccess: true,
            result: { echoed: { method: "sessions.delete" } },
        });
        socket.emitMessage({
            id: "runtime-snapshot-after-delete",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:main:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-after-delete"')
            )
        );
        expect(
            socket.sent.find((raw) =>
                raw.includes('"id":"runtime-snapshot-after-delete"')
            )
        ).toContain('"events":[]');
        expect(client?.requests.map((request) => request.method)).toEqual(
            expect.arrayContaining(["chat.abort", "chat.send", "sessions.delete"])
        );
        socket.emitMessage({
            id: "ack-main-run",
            method: "chat.send",
            params: {
                message: "regular message",
                sessionKey: "agent:main:main",
            },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"ack-main-run"'))
        );
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "early reasoning" },
                runId: "acknowledged-run",
                stream: "thinking",
            },
        });
        await waitFor(() =>
            socket.sent.some(
                (raw) =>
                    raw.includes('"event":"agent"') &&
                    raw.includes('"runId":"acknowledged-run"')
            )
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            event?: string;
                            payload?: { runId?: string; sessionKey?: string };
                        }
                )
                .findLast(
                    (message) =>
                        message.event === "agent" &&
                        message.payload?.runId === "acknowledged-run"
                )?.payload?.sessionKey
        ).toBe("agent:main:main");

        socket.emitMessage({
            id: "ack-duplicate-run",
            method: "chat.send",
            params: {
                message: "parallel message",
                sessionKey: "agent:researcher:subagent:abc",
            },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"ack-duplicate-run"'))
        );
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "ambiguous reasoning" },
                runId: "acknowledged-run",
                stream: "thinking",
            },
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes("ambiguous reasoning"))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            event?: string;
                            payload?: {
                                data?: { delta?: string };
                                sessionKey?: string;
                            };
                        }
                )
                .findLast(
                    (message) =>
                        message.event === "agent" &&
                        message.payload?.data?.delta === "ambiguous reasoning"
                )?.payload
        ).not.toHaveProperty("sessionKey");

        socket.emitMessage({ channel: "logs", type: "subscribe" });
        socket.emitMessage({ channel: "logs", type: "unsubscribe" });
        socket.emitMessage({
            id: "logs-subscribe",
            method: "subscribe",
            params: { channel: "logs" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"logs-subscribe"'))
        );
        expect(
            socket.sent
                .map((raw) => JSON.parse(raw) as { id?: string; isOk?: boolean })
                .find((message) => message.id === "logs-subscribe")
        ).toMatchObject({ isOk: true });
        socket.emitMessage({
            id: "logs-unsubscribe",
            method: "unsubscribe",
            params: { channel: "logs" },
            type: "req",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"logs-unsubscribe"'))
        );
        expect(
            socket.sent
                .map((raw) => JSON.parse(raw) as { id?: string; isOk?: boolean })
                .find((message) => message.id === "logs-unsubscribe")
        ).toMatchObject({ isOk: true });

        socket.emitMessage({
            id: "fail-1",
            method: "demo.fail",
            params: {},
            type: "request",
        });
        await waitFor(() => socket.sent.some((raw) => raw.includes('"id":"fail-1"')));
        expect(
            socket.sent
                .map((raw) => JSON.parse(raw) as { error?: string; id?: string })
                .find((message) => message.id === "fail-1")
        ).toMatchObject({ error: "gateway rejected" });

        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "provisional reasoning" },
                sessionKey: "agent:provisional:main",
                stream: "thinking",
            },
        });
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: " acknowledged" },
                runId: "resolved-provisional-run",
                sessionKey: "agent:provisional:main",
                stream: "thinking",
            },
        });
        client?.options.onEvent?.({
            event: "model.completed",
            payload: {
                runId: "resolved-provisional-run",
                sessionKey: "agent:provisional:main",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-provisional",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:provisional:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-provisional"'))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: {
                                completed?: boolean;
                                events?: Array<{
                                    payload?: {
                                        data?: { delta?: string };
                                        runId?: string;
                                    };
                                }>;
                            };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-provisional")?.payload
        ).toMatchObject({
            completed: false,
            events: [
                {
                    payload: {
                        data: { delta: "provisional reasoning" },
                    },
                },
            ],
        });

        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: "fire and forget reasoning" },
                runId: "fire-and-forget-run",
                sessionKey: "agent:fire-and-forget:main",
                stream: "thinking",
            },
        });
        const requestCountBeforeNotification = client?.requests.length || 0;
        socket.emitMessage({
            method: "chat.send",
            params: {
                message: "/reset",
                sessionKey: "agent:fire-and-forget:main",
            },
            type: "request",
        });
        await waitFor(
            () => (client?.requests.length || 0) > requestCountBeforeNotification
        );
        socket.emitMessage({
            id: "runtime-snapshot-after-idless-reset",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:fire-and-forget:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-after-idless-reset"')
            )
        );
        expect(
            socket.sent.find((raw) =>
                raw.includes('"id":"runtime-snapshot-after-idless-reset"')
            )
        ).toContain('"events":[]');

        const multiByteDelta = "é".repeat(210_000);
        for (const marker of ["first", "second", "third"]) {
            client?.options.onEvent?.({
                event: "agent",
                payload: {
                    data: { delta: multiByteDelta, marker },
                    runId: "byte-limited-run",
                    sessionKey: "agent:bytes:main",
                    stream: "thinking",
                },
            });
        }
        socket.emitMessage({
            id: "runtime-snapshot-byte-limit",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:bytes:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) => raw.includes('"id":"runtime-snapshot-byte-limit"'))
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: {
                                events?: Array<{
                                    payload?: { data?: { marker?: string } };
                                }>;
                            };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-byte-limit")
                ?.payload?.events?.map((event) => event.payload?.data?.marker)
        ).toEqual(["first", "second", "third"]);

        const oversizedDelta = "é".repeat(510_000);
        client?.options.onEvent?.({
            event: "agent",
            payload: {
                data: { delta: oversizedDelta },
                runId: "oversized-run",
                sessionKey: "agent:oversized:main",
                stream: "thinking",
            },
        });
        client?.options.onEvent?.({
            event: "chat",
            payload: {
                message: { role: "assistant", text: oversizedDelta },
                runId: "oversized-run",
                sessionKey: "agent:oversized:main",
                state: "final",
            },
        });
        socket.emitMessage({
            id: "runtime-snapshot-oversized-terminal",
            method: "chat.runtimeSnapshot",
            params: { sessionKey: "agent:oversized:main" },
            type: "request",
        });
        await waitFor(() =>
            socket.sent.some((raw) =>
                raw.includes('"id":"runtime-snapshot-oversized-terminal"')
            )
        );
        expect(
            socket.sent
                .map(
                    (raw) =>
                        JSON.parse(raw) as {
                            id?: string;
                            payload?: {
                                completed?: boolean;
                                events?: Array<{ payload?: unknown }>;
                            };
                        }
                )
                .find((message) => message.id === "runtime-snapshot-oversized-terminal")
                ?.payload
        ).toMatchObject({
            completed: true,
            events: [
                {
                    payload: {
                        runId: "oversized-run",
                        sessionKey: "agent:oversized:main",
                        state: "final",
                    },
                },
            ],
        });

        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            client?.options.onConnectError?.(new Error("connect refused"));
            client?.options.onEvent?.({
                event: "sessions.updated",
                payload: { sessionKey: "agent:main:main" },
            });
            socket.emitRawMessage("{");
            socket.emitError(new Error("client socket exploded"));
            await waitFor(() =>
                errorSpy.mock.calls.some((call) =>
                    String(call[0]).includes("[Gateway] Client message error:")
                )
            );
            client?.options.onClose?.(1006, "lost");
            await waitFor(() =>
                socket.sent.some((raw) => raw.includes('"type":"disconnected"'))
            );
            socket.emitMessage({
                id: "runtime-snapshot-after-close",
                method: "chat.runtimeSnapshot",
                params: { sessionKey: "agent:oversized:main" },
                type: "request",
            });
            await waitFor(() =>
                socket.sent.some((raw) =>
                    raw.includes('"id":"runtime-snapshot-after-close"')
                )
            );
            expect(
                socket.sent
                    .map(
                        (raw) =>
                            JSON.parse(raw) as {
                                id?: string;
                                payload?: {
                                    completed?: boolean;
                                    events?: Array<{ payload?: unknown }>;
                                };
                            }
                    )
                    .find((message) => message.id === "runtime-snapshot-after-close")
                    ?.payload
            ).toMatchObject({
                completed: true,
                events: [
                    {
                        payload: {
                            runId: "oversized-run",
                            sessionKey: "agent:oversized:main",
                            state: "final",
                        },
                    },
                ],
            });
        } finally {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
        }

        socket.close();
        gateway.shutdown();
        expect(client?.isStopped).toBe(true);

        const disconnectedSocket = new FakeDashboardSocket();
        gateway.handleDashboardClient(disconnectedSocket);
        disconnectedSocket.emitMessage({
            id: "after-shutdown",
            method: "chat.send",
            params: { message: "hello" },
            type: "request",
        });
        await waitFor(() =>
            disconnectedSocket.sent.some((raw) => raw.includes('"id":"after-shutdown"'))
        );
        expect(
            disconnectedSocket.sent
                .map((raw) => JSON.parse(raw) as { error?: string; id?: string })
                .find((message) => message.id === "after-shutdown")
        ).toMatchObject({ error: "Gateway not connected" });
        disconnectedSocket.close();
    });
});
