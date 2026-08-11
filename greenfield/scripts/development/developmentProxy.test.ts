import { describe, expect, jest, test } from "bun:test";

import type { Server, ServerWebSocket } from "bun";

import {
    terminalClientMessageMaximumBytes,
    terminalSocketBufferedMaximumBytes,
    terminalWebSocketProtocol,
} from "../../src/contracts/terminal.ts";
import {
    canonicalDevelopmentCookieHeader,
    type DevelopmentProxyConfiguration,
    type DevelopmentProxySocketData,
    developmentProxyCloseCode,
    developmentProxyQueuedMessageMaximum,
    developmentWebSocketHandler,
    isDevelopmentBackendPath,
    namespacedDevelopmentSetCookie,
    proxyDevelopmentHttp,
    proxyDevelopmentWebSocket,
} from "./developmentProxy.ts";

const namespace = "__Host-mira_dashboard_dev_3105";
const configuration: DevelopmentProxyConfiguration = Object.freeze({
    apiTarget: "http://127.0.0.1:3106",
    cookieNamespace: namespace,
    publicOrigin: "https://dashboard.example.ts.net:3445",
});

function socketData(): DevelopmentProxySocketData {
    return {
        backendPendingBytes: 0,
        backendPendingMessages: [],
        backendUrl:
            "ws://127.0.0.1:3106/api/terminal/sessions/00000000-0000-4000-8000-000000000000/socket",
        browserBackpressured: false,
        browserPendingBytes: 0,
        browserPendingMessages: [],
        protocols: [terminalWebSocketProtocol, `${"0".repeat(32)}.${"1".repeat(64)}`],
    };
}

function developmentWebSocketRequest(
    pathname: string,
    headers: Record<string, string>
): Request {
    return new Request(`https://dashboard.example.ts.net:3445${pathname}`, { headers });
}

describe("development proxy", () => {
    test("proxies only exact raw and tRPC mounts", () => {
        expect(isDevelopmentBackendPath("/api/health/live")).toBeTrue();
        expect(isDevelopmentBackendPath("/trpc/events.stream")).toBeTrue();
        expect(isDevelopmentBackendPath("/apiary")).toBeFalse();
        expect(isDevelopmentBackendPath("/trpc-other")).toBeFalse();
    });

    test("filters host cookies and maps only isolated credentials", () => {
        expect(
            canonicalDevelopmentCookieHeader(
                `production=value; ${namespace}_session=session-value; unrelated=x; ${namespace}_pending_login=pending-value`,
                namespace
            )
        ).toBe(
            "__Host-mira_dashboard_session=session-value; __Host-mira_dashboard_pending_login=pending-value"
        );
        expect(
            canonicalDevelopmentCookieHeader("production=value", namespace)
        ).toBeUndefined();
    });

    test("rewrites both backend credential cookies without changing attributes", () => {
        expect(
            namespacedDevelopmentSetCookie(
                "__Host-mira_dashboard_session=value; Path=/; Secure; HttpOnly; SameSite=Strict",
                namespace
            )
        ).toBe(`${namespace}_session=value; Path=/; Secure; HttpOnly; SameSite=Strict`);
        expect(
            namespacedDevelopmentSetCookie(
                "__Host-mira_dashboard_pending_login=; Max-Age=0; Path=/; Secure",
                namespace
            )
        ).toBe(`${namespace}_pending_login=; Max-Age=0; Path=/; Secure`);
    });

    test("preserves compressed upstream bytes and representation headers", async () => {
        const compressed = Bun.gzipSync(Buffer.from("compressed-response\n"));
        const upstream = Bun.serve({
            fetch() {
                return new Response(compressed, {
                    headers: {
                        "content-encoding": "gzip",
                        "content-length": String(compressed.byteLength),
                        "content-type": "text/plain",
                    },
                });
            },
            hostname: "127.0.0.1",
            port: 0,
        });

        try {
            const response = await proxyDevelopmentHttp(
                new Request("https://dashboard.example.ts.net:3445/api/compressed"),
                {
                    requestIP: () => null,
                },
                {
                    ...configuration,
                    apiTarget: upstream.url.origin,
                }
            );

            expect(response.headers.get("content-encoding")).toBe("gzip");
            expect(response.headers.get("content-length")).toBe(
                String(compressed.byteLength)
            );
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(compressed);
        } finally {
            await upstream.stop(true);
        }
    });

    test("returns a sanitized response when the HTTP backend is unavailable", async () => {
        const fetchSpy = jest
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("private upstream failure"));
        try {
            const response = await proxyDevelopmentHttp(
                new Request("https://dashboard.example.ts.net:3445/api/unavailable"),
                { requestIP: () => null },
                configuration
            );

            expect(response.status).toBe(502);
            expect(await response.text()).toBe("Development backend unavailable");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    test("upgrades exact UUIDv7 terminal paths and rejects obsolete UUIDv4 paths", () => {
        const token = `${"0".repeat(32)}.${"1".repeat(64)}`;
        const upgrade = jest.fn(() => true);
        const server = {
            requestIP: () => null,
            upgrade,
        } as unknown as Server<DevelopmentProxySocketData>;
        const request = (sessionId: string) =>
            new Request(
                `https://dashboard.example.ts.net:3445/api/terminal/sessions/${sessionId}/socket`,
                {
                    headers: {
                        origin: configuration.publicOrigin,
                        "sec-websocket-protocol": `${terminalWebSocketProtocol}, ${token}`,
                    },
                }
            );

        expect(
            proxyDevelopmentWebSocket(
                request("019fef32-73a5-7b32-a5d6-7ebf92eb45fd"),
                server,
                configuration
            )
        ).toBeUndefined();
        expect(upgrade).toHaveBeenCalledTimes(1);
        expect(
            proxyDevelopmentWebSocket(
                request("019fef32-73a5-4b32-a5d6-7ebf92eb45fd"),
                server,
                configuration
            )?.status
        ).toBe(400);
        expect(upgrade).toHaveBeenCalledTimes(1);
    });

    test("rejects invalid terminal upgrade origins, paths, and protocols", () => {
        const validPath =
            "/api/terminal/sessions/019fef32-73a5-7b32-a5d6-7ebf92eb45fd/socket";
        const validProtocol = `${terminalWebSocketProtocol}, ${"0".repeat(32)}.${"1".repeat(64)}`;
        const upgrade = jest.fn(() => true);
        const server = {
            requestIP: () => null,
            upgrade,
        } as unknown as Server<DevelopmentProxySocketData>;
        const invalidRequests = [
            developmentWebSocketRequest(validPath, {
                origin: "https://unexpected.example.ts.net",
                "sec-websocket-protocol": validProtocol,
            }),
            developmentWebSocketRequest("/api/not-terminal", {
                origin: configuration.publicOrigin,
                "sec-websocket-protocol": validProtocol,
            }),
            developmentWebSocketRequest(validPath, {
                origin: configuration.publicOrigin,
            }),
            developmentWebSocketRequest(validPath, {
                origin: configuration.publicOrigin,
                "sec-websocket-protocol": `${terminalWebSocketProtocol}, malformed-token`,
            }),
        ];

        for (const invalidRequest of invalidRequests) {
            expect(
                proxyDevelopmentWebSocket(invalidRequest, server, configuration)?.status
            ).toBe(400);
        }
        expect(upgrade).not.toHaveBeenCalled();
    });

    test("uses terminal contract limits and drains bounded browser output", () => {
        const handler = developmentWebSocketHandler(configuration);
        expect(handler.maxPayloadLength).toBe(terminalClientMessageMaximumBytes);
        expect(handler.backpressureLimit).toBe(terminalSocketBufferedMaximumBytes);
        expect(handler.closeOnBackpressureLimit).toBeTrue();
        expect(handler.perMessageDeflate).toBeFalse();

        const data = socketData();
        data.browserBackpressured = true;
        data.browserPendingBytes = 6;
        data.browserPendingMessages = ["queued"];
        const send = jest.fn(() => 6);
        const socket = {
            close: jest.fn(),
            data,
            readyState: WebSocket.OPEN,
            send,
        } as unknown as ServerWebSocket<DevelopmentProxySocketData>;

        void handler.drain?.(socket);

        expect(send).toHaveBeenCalledWith("queued");
        expect(data.browserBackpressured).toBeFalse();
        expect(data.browserPendingBytes).toBe(0);
        expect(data.browserPendingMessages).toEqual([]);
    });

    test("closes instead of dropping a browser frame or over-buffering upstream input", () => {
        const handler = developmentWebSocketHandler(configuration);
        const droppedData = socketData();
        droppedData.browserBackpressured = true;
        droppedData.browserPendingBytes = 6;
        droppedData.browserPendingMessages = ["queued"];
        const droppedClose = jest.fn();
        const droppedSocket = {
            close: droppedClose,
            data: droppedData,
            readyState: WebSocket.OPEN,
            send: () => 0,
        } as unknown as ServerWebSocket<DevelopmentProxySocketData>;

        void handler.drain?.(droppedSocket);
        expect(droppedClose).toHaveBeenCalledWith(1011, "Proxy delivery failed");

        const bufferedData = socketData();
        const backendSend = jest.fn();
        const backendClose = jest.fn();
        bufferedData.backend = {
            bufferedAmount: terminalSocketBufferedMaximumBytes,
            close: backendClose,
            readyState: WebSocket.OPEN,
            send: backendSend,
        } as unknown as WebSocket;
        const browserClose = jest.fn();
        const bufferedSocket = {
            close: browserClose,
            data: bufferedData,
            readyState: WebSocket.OPEN,
        } as unknown as ServerWebSocket<DevelopmentProxySocketData>;

        void handler.message(bufferedSocket, "input");

        expect(backendSend).not.toHaveBeenCalled();
        expect(backendClose).toHaveBeenCalledWith(1011, "Upstream backpressure exceeded");
        expect(browserClose).toHaveBeenCalledWith(1011, "Upstream backpressure exceeded");
    });

    test("bounds pre-open input queues even when messages contain no bytes", () => {
        const handler = developmentWebSocketHandler(configuration);
        const data = socketData();
        const backendClose = jest.fn();
        data.backend = {
            close: backendClose,
            readyState: WebSocket.CONNECTING,
        } as unknown as WebSocket;
        const browserClose = jest.fn();
        const socket = {
            close: browserClose,
            data,
            readyState: WebSocket.OPEN,
        } as unknown as ServerWebSocket<DevelopmentProxySocketData>;

        for (let index = 0; index <= developmentProxyQueuedMessageMaximum; index += 1) {
            void handler.message(socket, "");
        }

        expect(backendClose).toHaveBeenCalledWith(1009, "Proxy input buffer exceeded");
        expect(browserClose).toHaveBeenCalledWith(1009, "Proxy input buffer exceeded");
        expect(data.backendPendingMessages).toEqual([]);
    });

    test("closes the browser socket when the backend socket cannot be constructed", () => {
        const handler = developmentWebSocketHandler(configuration);
        const data = { ...socketData(), backendUrl: "not-a-websocket-url" };
        const close = jest.fn();
        const socket = {
            close,
            data,
            readyState: WebSocket.OPEN,
        } as unknown as ServerWebSocket<DevelopmentProxySocketData>;

        expect(() => handler.open?.(socket)).not.toThrow();
        expect(close).toHaveBeenCalledWith(1011, "Proxy unavailable");
        expect(data.backend).toBeUndefined();
    });

    test("maps reserved and abnormal upstream close codes to a valid server error", () => {
        expect(developmentProxyCloseCode(1000)).toBe(1000);
        expect(developmentProxyCloseCode(1009)).toBe(1009);
        expect(developmentProxyCloseCode(4001)).toBe(4001);
        expect(developmentProxyCloseCode(0)).toBe(1011);
        expect(developmentProxyCloseCode(1005)).toBe(1011);
        expect(developmentProxyCloseCode(1006)).toBe(1011);
        expect(developmentProxyCloseCode(1015)).toBe(1011);
    });
});
