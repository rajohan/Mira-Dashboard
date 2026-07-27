import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
} from "../src/lib/openclawGatewayClient.ts";
import {
    type PullRequestPreviewGatewayProxy,
    startPullRequestPreviewGatewayProxy,
} from "../src/pullRequestPreviewGatewayProxy.ts";
import { CONFIG_REDACTION_SENTINEL } from "../src/services/configRedaction.ts";

const INTEGRATION_CHILD_ENV =
    "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_TEST_INTEGRATION_CHILD";

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
