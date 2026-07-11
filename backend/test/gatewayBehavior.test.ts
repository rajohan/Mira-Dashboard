import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import type { DashboardSocket } from "../src/dashboardSocket.ts";
import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
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
    readonly requests: Array<{ method: string; parameters: Record<string, unknown> }> =
        [];
    isStarted = false;
    isStopped = false;

    constructor(readonly options: OpenClawGatewayClientOptions) {
        fakeClients.push(this);
    }

    start(): void {
        this.isStarted = true;
    }

    stop(): void {
        this.isStopped = true;
    }

    async request(method: string, parameters?: unknown): Promise<unknown> {
        const requestParameters =
            parameters && typeof parameters === "object"
                ? (parameters as Record<string, unknown>)
                : {};
        this.requests.push({ method, parameters: requestParameters });
        if (method === "sessions.list") {
            return {
                sessions: [
                    {
                        activeRunId: "run-1",
                        channel: "main",
                        contextTokens: 20_000,
                        displayName: "Main",
                        key: "agent:main:main",
                        kind: "chat",
                        label: "",
                        model: "openai/gpt-test",
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
                        updatedAt: "2026-06-25T00:00:00.000Z",
                    },
                    {
                        key: "agent:researcher:subagent:abc",
                        label: "",
                        sessionId: "sess2",
                        updatedAt: 1_782_345_600_000,
                    },
                    {
                        key: "agent:main:hook:deploy",
                        sessionId: "sess3",
                        updatedAt: 1_782_345_500_000,
                    },
                    { key: "", sessionId: "", updatedAt: "invalid" },
                ],
            };
        }
        if (method === "sessions.subscribe") {
            return { isOk: true };
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
                    thinkingDefault: "low",
                    thinkingLevel: "medium",
                    thinkingLevels: [
                        { id: "low", label: "low" },
                        { id: "medium", label: "medium" },
                    ],
                    thinkingOptions: ["low", "medium"],
                    fastMode: "auto",
                    effectiveFastMode: true,
                    type: "MAIN",
                }),
                expect.objectContaining({
                    agentType: "researcher",
                    displayLabel: "Researcher",
                    type: "SUBAGENT",
                }),
                expect.objectContaining({
                    displayLabel: "Deploy",
                    hookName: "deploy",
                    type: "HOOK",
                }),
            ])
        );

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
                Unknown: 2,
                "openai/gpt-test": 1,
            },
            byType: {
                HOOK: 1,
                MAIN: 1,
                SUBAGENT: 1,
            },
            total: 3,
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

        const stop = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("stop")
        );
        expect(stop.status).toBe(200);

        const unsupported = await sessionRoutes["/api/sessions/:id/action"].POST(
            sessionActionRequest("archive")
        );
        expect(unsupported.status).toBe(400);

        const deleted =
            await sessionRoutes["/api/sessions/:id"].DELETE(sessionDeleteRequest());
        await expect(deleted.json()).resolves.toMatchObject({
            isSuccess: true,
            result: { echoed: { method: "sessions.delete" } },
        });
        expect(client?.requests.map((request) => request.method)).toEqual(
            expect.arrayContaining(["chat.abort", "chat.send", "sessions.delete"])
        );

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
