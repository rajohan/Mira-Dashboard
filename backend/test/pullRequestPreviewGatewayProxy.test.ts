import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
} from "../src/lib/openclawGatewayClient.ts";
import {
    MAX_CLIENT_PENDING_REQUESTS,
    type PullRequestPreviewGatewayProxy,
    type PullRequestPreviewGatewayProxyOptions,
    startPullRequestPreviewGatewayProxy,
} from "../src/pullRequestPreviewGatewayProxy.ts";
import { CONFIG_REDACTION_SENTINEL } from "../src/services/configRedaction.ts";

const INTEGRATION_CHILD_ENV =
    "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_TEST_INTEGRATION_CHILD";

type ProxyServerFactory = NonNullable<
    PullRequestPreviewGatewayProxyOptions["serverFactory"]
>;
type ProxyServeOptions = Parameters<ProxyServerFactory>[0];
type ProxyFetchHandler = NonNullable<ProxyServeOptions["fetch"]>;
type ProxyWebSocketHandler = NonNullable<ProxyServeOptions["websocket"]>;
type ProxySocket = Parameters<NonNullable<ProxyWebSocketHandler["open"]>>[0];

interface SocketHarness {
    close: () => void;
    closed: Promise<void>;
    next: () => Promise<Record<string, unknown>>;
    open: Promise<void>;
    send: (value: unknown) => void;
}

function websocketHarness(url: string): SocketHarness {
    const socket = new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<(value: Record<string, unknown>) => void> = [];
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
    });
    const open = new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
            "error",
            () => reject(new Error("Preview Gateway proxy socket failed to open")),
            { once: true }
        );
    });
    socket.addEventListener("message", (event) => {
        void (async () => {
            const text =
                typeof event.data === "string"
                    ? event.data
                    : event.data instanceof Blob
                      ? await event.data.text()
                      : Buffer.from(event.data as ArrayBuffer).toString("utf8");
            const value = JSON.parse(text) as Record<string, unknown>;
            const waiter = waiters.shift();
            if (waiter) {
                waiter(value);
            } else {
                messages.push(value);
            }
        })();
    });
    return {
        close: () => socket.close(),
        closed,
        next: () =>
            messages.length > 0
                ? Promise.resolve(messages.shift()!)
                : new Promise((resolve) => {
                      waiters.push(resolve);
                  }),
        open,
        send: (value) => socket.send(JSON.stringify(value)),
    };
}

describe("PR dev Gateway capability proxy", () => {
    it("enforces protocol policy through an injected server", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-gateway-policy-"));
        let clientOptions: OpenClawGatewayClientOptions | undefined;
        let serveOptions: ProxyServeOptions | undefined;
        let shouldRejectRequest = false;
        const request = jest.fn(
            async (method: string, parameters?: unknown): Promise<unknown> => {
                if (shouldRejectRequest) throw new Error("upstream request failed");
                return method === "config.get"
                    ? {
                          parsed: {
                              gateway: { token: "production-gateway-token" },
                          },
                      }
                    : { method, parameters };
            }
        );
        const upstreamStop = jest.fn();
        const upstreamClientFactory = (
            options: OpenClawGatewayClientOptions
        ): OpenClawGatewayClientInstance => {
            clientOptions = options;
            return {
                request,
                start: () =>
                    options.onHelloOk?.({
                        policy: { tickIntervalMs: 30_000 },
                        protocol: 4,
                        type: "hello-ok",
                    }),
                stop: upstreamStop,
            };
        };
        const serverStop = jest.fn(async () => {});
        const serverUnref = jest.fn();
        const fakeServer = {
            port: 19_001,
            stop: serverStop,
            unref: serverUnref,
        } as unknown as ReturnType<ProxyServerFactory>;
        const serverFactory: ProxyServerFactory = (options) => {
            serveOptions = options;
            return fakeServer;
        };
        let proxy: PullRequestPreviewGatewayProxy | undefined;

        try {
            proxy = startPullRequestPreviewGatewayProxy({
                clientToken: "disposable-preview-token",
                deviceIdentityFile: path.join(root, "device.json"),
                port: 19_000,
                serverFactory,
                upstreamClientFactory,
                upstreamToken: "production-gateway-token",
                upstreamUrl: "ws://127.0.0.1:18789",
            });
            expect(proxy.port).toBe(19_001);
            expect(proxy.isUpstreamConnected()).toBe(true);

            const options = serveOptions;
            const fetchHandler = options?.fetch as ProxyFetchHandler | undefined;
            const websocket = options?.websocket;
            if (!fetchHandler || !websocket) {
                throw new Error("Proxy server handlers were not captured");
            }
            const openSocket = websocket.open;
            const handleMessage = websocket.message;
            const closeSocket = websocket.close;
            if (!openSocket || !handleMessage || !closeSocket) {
                throw new Error("Proxy WebSocket handlers are incomplete");
            }

            let shouldUpgrade = false;
            let upgradedData: ProxySocket["data"] | undefined;
            const upgrade = jest.fn(
                (_request: Request, upgradeOptions: { data: ProxySocket["data"] }) => {
                    upgradedData = upgradeOptions.data;
                    return shouldUpgrade;
                }
            );
            const fetchServer = {
                upgrade,
            } as unknown as Parameters<ProxyFetchHandler>[1];
            const callFetch = (request: Request) =>
                fetchHandler.call(fetchServer, request, fetchServer);

            const health = await callFetch(new Request("http://127.0.0.1:19000/health"));
            expect(health).toMatchObject({ status: 200 });
            await expect((health as Response).json()).resolves.toEqual({
                upstreamConnected: true,
            });
            const notFound = await callFetch(
                new Request("http://127.0.0.1:19000/unavailable")
            );
            expect(notFound).toMatchObject({ status: 404 });
            const notUpgraded = await callFetch(
                new Request("http://127.0.0.1:19000/gateway")
            );
            expect(notUpgraded).toMatchObject({ status: 426 });

            shouldUpgrade = true;
            const upgraded = await callFetch(
                new Request("http://127.0.0.1:19000/gateway")
            );
            expect(upgraded).toBeUndefined();
            if (!upgradedData) throw new Error("Proxy upgrade data was not captured");

            const sentFrames: Array<Record<string, unknown>> = [];
            const makeSocket = (data: ProxySocket["data"]): ProxySocket =>
                ({
                    data,
                    send: (frame: string | Buffer) => {
                        sentFrames.push(
                            JSON.parse(
                                typeof frame === "string" ? frame : frame.toString("utf8")
                            ) as Record<string, unknown>
                        );
                        return 1;
                    },
                    terminate: jest.fn(),
                }) as unknown as ProxySocket;
            const socket = makeSocket(upgradedData);
            openSocket(socket);
            expect(sentFrames.at(-1)).toMatchObject({
                event: "connect.challenge",
                type: "event",
            });
            await handleMessage(
                socket,
                JSON.stringify({
                    id: "connect-1",
                    method: "connect",
                    params: { auth: { token: "disposable-preview-token" } },
                    type: "req",
                })
            );
            expect(sentFrames.at(-1)).toMatchObject({
                id: "connect-1",
                isOk: true,
                payload: { type: "hello-ok" },
            });

            await handleMessage(
                socket,
                Buffer.from(
                    JSON.stringify({
                        id: "config-1",
                        method: "config.get",
                        params: {},
                        type: "req",
                    })
                )
            );
            expect(sentFrames.at(-1)).toMatchObject({
                id: "config-1",
                isOk: true,
                payload: {
                    parsed: {
                        gateway: { token: CONFIG_REDACTION_SENTINEL },
                    },
                },
            });

            await handleMessage(
                socket,
                JSON.stringify({
                    id: "blocked-1",
                    method: "config.patch",
                    params: {},
                    type: "req",
                })
            );
            expect(sentFrames.at(-1)).toMatchObject({
                error: { code: "PREVIEW_GATEWAY_DENIED" },
                id: "blocked-1",
                isOk: false,
            });

            socket.data.pendingRequests = MAX_CLIENT_PENDING_REQUESTS;
            await handleMessage(
                socket,
                JSON.stringify({
                    id: "bounded-1",
                    method: "chat.history",
                    params: {},
                    type: "req",
                })
            );
            expect(sentFrames.at(-1)).toMatchObject({
                error: { message: "Too many pending Gateway requests" },
                id: "bounded-1",
            });
            socket.data.pendingRequests = 0;

            shouldRejectRequest = true;
            await handleMessage(
                socket,
                JSON.stringify({
                    id: "failed-1",
                    method: "chat.history",
                    params: {},
                    type: "req",
                })
            );
            expect(sentFrames.at(-1)).toMatchObject({
                error: { message: "upstream request failed" },
                id: "failed-1",
            });
            shouldRejectRequest = false;

            const sentBeforeEvents = sentFrames.length;
            clientOptions?.onEvent?.({
                event: "plugin.approval.requested",
                payload: { ignored: true },
                type: "event",
            });
            clientOptions?.onEvent?.({
                event: "tick",
                payload: { at: 1 },
                type: "event",
            });
            expect(sentFrames).toHaveLength(sentBeforeEvents + 1);
            expect(sentFrames.at(-1)).toMatchObject({ event: "tick" });

            const invalidSocket = makeSocket({
                authenticated: false,
                challengeNonce: "invalid-frame",
                pendingRequests: 0,
            });
            await handleMessage(invalidSocket, "{");
            expect(invalidSocket.terminate).toHaveBeenCalledTimes(1);

            const unauthenticatedSocket = makeSocket({
                authenticated: false,
                challengeNonce: "unauthenticated",
                pendingRequests: 0,
            });
            await handleMessage(
                unauthenticatedSocket,
                JSON.stringify({
                    id: "unauthenticated-1",
                    method: "chat.history",
                    params: {},
                    type: "req",
                })
            );
            expect(unauthenticatedSocket.terminate).toHaveBeenCalledTimes(1);
            expect(sentFrames.at(-1)).toMatchObject({
                error: { message: "Gateway proxy authentication is required" },
            });

            clientOptions?.onClose?.(1006, "upstream closed");
            expect(proxy.isUpstreamConnected()).toBe(false);
            expect(socket.terminate).toHaveBeenCalledTimes(1);
            const offlineHealth = await callFetch(
                new Request("http://127.0.0.1:19000/health")
            );
            expect(offlineHealth).toMatchObject({ status: 503 });

            closeSocket(socket, 1000, "test complete");
        } finally {
            await proxy?.stop();
            expect(serverStop).toHaveBeenCalledWith(true);
            expect(serverUnref).toHaveBeenCalledTimes(proxy ? 1 : 0);
            expect(upstreamStop).toHaveBeenCalledTimes(proxy ? 1 : 0);
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("authenticates with a disposable token and forwards only allowed methods", async () => {
        if (process.env[INTEGRATION_CHILD_ENV] !== "1") {
            // Bun 1.3.14 on arm64 can panic under coverage after an in-process
            // WebSocket has closed. Keep the real transport integration while
            // isolating that runtime cleanup from the coverage process.
            const result = Bun.spawnSync({
                cmd: [
                    process.execPath,
                    "test",
                    path.join(
                        import.meta.dirname,
                        "pullRequestPreviewGatewayProxy.test.ts"
                    ),
                ],
                cwd: path.resolve(import.meta.dirname, ".."),
                env: {
                    [INTEGRATION_CHILD_ENV]: "1",
                    NO_COLOR: "1",
                    PATH: process.env.PATH || "/usr/bin:/bin",
                },
                stderr: "pipe",
                stdin: "ignore",
                stdout: "pipe",
            });
            if (result.exitCode !== 0) {
                const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
                throw new Error(
                    `Proxy integration child failed:\n${output.slice(-8000)}`
                );
            }
            return;
        }

        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-gateway-proxy-"));
        let clientOptions: OpenClawGatewayClientOptions | undefined;
        const request = jest.fn(
            async (method: string, parameters?: unknown): Promise<unknown> =>
                method === "config.get"
                    ? {
                          hash: "config-hash",
                          parsed: {
                              gateway: { token: "production-gateway-token" },
                              tools: { profile: "full" },
                          },
                      }
                    : {
                          method,
                          parameters,
                      }
        );
        const stop = jest.fn();
        const upstreamClientFactory = (
            options: OpenClawGatewayClientOptions
        ): OpenClawGatewayClientInstance => {
            clientOptions = options;
            return {
                request,
                start: () =>
                    options.onHelloOk?.({
                        policy: { tickIntervalMs: 30_000 },
                        protocol: 4,
                        type: "hello-ok",
                    }),
                stop,
            };
        };
        let proxy: PullRequestPreviewGatewayProxy | undefined;
        let socket: SocketHarness | undefined;
        let rejectedSocket: SocketHarness | undefined;
        let disconnectedSocket: SocketHarness | undefined;

        try {
            proxy = startPullRequestPreviewGatewayProxy({
                clientToken: "disposable-preview-token",
                deviceIdentityFile: path.join(root, "device.json"),
                port: 0,
                upstreamClientFactory,
                upstreamToken: "production-gateway-token",
                upstreamUrl: "ws://127.0.0.1:18789",
            });
            expect(clientOptions).toMatchObject({
                clientName: "gateway-client",
                scopes: ["operator.read", "operator.write"],
                token: "production-gateway-token",
                url: "ws://127.0.0.1:18789",
            });
            expect(clientOptions?.scopes).not.toContain("operator.admin");
            await expect(
                fetch(`http://127.0.0.1:${proxy.port}/health`)
            ).resolves.toMatchObject({ status: 200 });

            socket = websocketHarness(`ws://127.0.0.1:${proxy.port}/gateway`);
            await socket.open;
            await expect(socket.next()).resolves.toMatchObject({
                event: "connect.challenge",
                type: "event",
            });
            socket.send({
                id: "connect-1",
                method: "connect",
                params: { auth: { token: "disposable-preview-token" } },
                type: "req",
            });
            await expect(socket.next()).resolves.toMatchObject({
                id: "connect-1",
                isOk: true,
                payload: { type: "hello-ok" },
            });

            socket.send({
                id: "allowed-1",
                method: "chat.history",
                params: { sessionKey: "agent:main:main" },
                type: "req",
            });
            await expect(socket.next()).resolves.toMatchObject({
                id: "allowed-1",
                isOk: true,
                payload: {
                    method: "chat.history",
                    parameters: { sessionKey: "agent:main:main" },
                },
            });

            socket.send({
                id: "allowed-cron-list",
                method: "cron.list",
                params: {},
                type: "req",
            });
            await expect(socket.next()).resolves.toMatchObject({
                id: "allowed-cron-list",
                isOk: true,
                payload: {
                    method: "cron.list",
                    parameters: {},
                },
            });

            socket.send({
                id: "allowed-config-get",
                method: "config.get",
                params: {},
                type: "req",
            });
            await expect(socket.next()).resolves.toMatchObject({
                id: "allowed-config-get",
                isOk: true,
                payload: {
                    hash: "config-hash",
                    parsed: {
                        gateway: { token: CONFIG_REDACTION_SENTINEL },
                        tools: { profile: "full" },
                    },
                },
            });

            socket.send({
                id: "blocked-1",
                method: "config.patch",
                params: { raw: "unsafe" },
                type: "req",
            });
            await expect(socket.next()).resolves.toMatchObject({
                error: { code: "PREVIEW_GATEWAY_DENIED" },
                id: "blocked-1",
                isOk: false,
            });
            expect(request).toHaveBeenCalledTimes(3);

            clientOptions?.onEvent?.({
                event: "tick",
                payload: { at: 1 },
                type: "event",
            });
            await expect(socket.next()).resolves.toEqual({
                event: "tick",
                payload: { at: 1 },
                type: "event",
            });

            rejectedSocket = websocketHarness(`ws://127.0.0.1:${proxy.port}/gateway`);
            await rejectedSocket.open;
            await rejectedSocket.next();
            rejectedSocket.send({
                id: "connect-bad",
                method: "connect",
                params: { auth: { token: "production-gateway-token" } },
                type: "req",
            });
            await rejectedSocket.closed;
            expect(request).toHaveBeenCalledTimes(3);

            clientOptions?.onClose?.(1006, "upstream unavailable");
            await expect(
                fetch(`http://127.0.0.1:${proxy.port}/health`)
            ).resolves.toMatchObject({ status: 503 });
            disconnectedSocket = websocketHarness(`ws://127.0.0.1:${proxy.port}/gateway`);
            await disconnectedSocket.open;
            await disconnectedSocket.next();
            disconnectedSocket.send({
                id: "connect-offline",
                method: "connect",
                params: { auth: { token: "disposable-preview-token" } },
                type: "req",
            });
            await disconnectedSocket.closed;
            expect(request).toHaveBeenCalledTimes(3);
        } finally {
            await proxy?.stop();
            disconnectedSocket?.close();
            rejectedSocket?.close();
            socket?.close();
            expect(stop).toHaveBeenCalledTimes(proxy ? 1 : 0);
            rmSync(root, { force: true, recursive: true });
        }
    });
});
