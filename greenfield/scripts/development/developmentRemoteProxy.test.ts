import { describe, expect, jest, test } from "bun:test";

import type { ServerWebSocket } from "bun";

import {
    developmentRemoteProxyBufferedMaximumBytes,
    developmentRemoteProxyCloseCode,
    developmentRemoteProxyMessageMaximumBytes,
    developmentRemoteProxyQueuedMessageMaximum,
    type DevelopmentRemoteProxySocketData,
    developmentRemoteWebSocketHandler,
    startDevelopmentRemoteProxy,
} from "./developmentRemoteProxy.ts";

const publicOrigin = "https://dashboard.magicdns.test:3445";
const publicHost = new URL(publicOrigin).host;

interface ObservedWebSocketUpgrade {
    readonly host: string | null;
    readonly offeredProtocols: string | null;
    readonly origin: string | null;
    readonly pathname: string;
    readonly search: string;
}

function socketData(): DevelopmentRemoteProxySocketData {
    return {
        downstreamBackpressured: false,
        downstreamPendingBytes: 0,
        downstreamPendingMessages: [],
        isClosing: false,
        protocols: [],
        upstreamHeaders: {},
        upstreamPendingBytes: 0,
        upstreamPendingMessages: [],
        upstreamUrl: "ws://127.0.0.1:65534/socket",
    };
}

function websocketUrl(origin: string, path: string): string {
    const url = new URL(path, origin);
    url.protocol = "ws:";
    return url.href;
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
    return new Promise((resolve) => {
        socket.addEventListener("message", resolve, { once: true });
    });
}

function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
            "error",
            () => reject(new Error("WebSocket connection failed")),
            { once: true }
        );
    });
}

async function expectOpenRejection(socket: WebSocket): Promise<void> {
    let openError: unknown;
    try {
        await opened(socket);
    } catch (error) {
        openError = error;
    }
    expect(openError).toEqual(new Error("WebSocket connection failed"));
}

async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close(1000, "Test complete");
    await Promise.race([closed, Bun.sleep(1000)]);
}

function startObservedWebSocketServer(): Bun.Server<ObservedWebSocketUpgrade> {
    return Bun.serve<ObservedWebSocketUpgrade>({
        fetch(request, server) {
            const url = new URL(request.url);
            const offeredProtocols = request.headers.get("sec-websocket-protocol");
            const selectedProtocol = offeredProtocols?.split(",")[0]?.trim();
            const headers = new Headers();
            if (selectedProtocol !== undefined) {
                headers.set("sec-websocket-protocol", selectedProtocol);
            }
            if (
                server.upgrade(request, {
                    data: {
                        host: request.headers.get("host"),
                        offeredProtocols,
                        origin: request.headers.get("origin"),
                        pathname: url.pathname,
                        search: url.search,
                    },
                    headers,
                })
            ) {
                return;
            }
            return new Response("Upgrade failed", { status: 400 });
        },
        hostname: "127.0.0.1",
        port: 0,
        websocket: {
            message(socket, message) {
                socket.send(message);
            },
            open(socket) {
                socket.send(JSON.stringify(socket.data));
            },
            perMessageDeflate: false,
        },
    });
}

describe("development remote proxy", () => {
    test("binds only to loopback and validates the fixed frontend target", async () => {
        expect(() =>
            startDevelopmentRemoteProxy({
                frontendTarget: "https://dashboard.example.com:3205",
                port: 0,
                publicOrigin,
            })
        ).toThrow("target must be a loopback origin");
        expect(() =>
            startDevelopmentRemoteProxy({
                frontendTarget: "http://127.0.0.1:3205/nested",
                port: 0,
                publicOrigin,
            })
        ).toThrow("target must be a loopback origin");
        expect(() =>
            startDevelopmentRemoteProxy({
                frontendTarget: "http://127.0.0.1:3205",
                port: 3205,
                publicOrigin,
            })
        ).toThrow("proxy and frontend ports must differ");
        expect(() =>
            startDevelopmentRemoteProxy({
                frontendTarget: "http://127.0.0.1:3205",
                port: 0,
                publicOrigin: "http://dashboard.magicdns.test:3445",
            })
        ).toThrow("public origin must be HTTPS");

        const proxy = startDevelopmentRemoteProxy({
            frontendTarget: "http://127.0.0.1:65534",
            port: 0,
            publicOrigin,
        });
        try {
            expect(proxy.hostname).toBe("127.0.0.1");
            expect(proxy.port).toBeGreaterThan(0);
        } finally {
            await proxy.stop(true);
        }
    });

    test("streams HTTP to the fixed target and preserves compressed bytes", async () => {
        const compressed = Bun.gzipSync(Buffer.from("compressed remote response\n"));
        let observed:
            | Readonly<{
                  body: string;
                  host: string | null;
                  origin: string | null;
                  pathname: string;
                  search: string;
              }>
            | undefined;
        const upstream = Bun.serve({
            async fetch(request) {
                const url = new URL(request.url);
                observed = Object.freeze({
                    body: await request.text(),
                    host: request.headers.get("host"),
                    origin: request.headers.get("origin"),
                    pathname: url.pathname,
                    search: url.search,
                });
                return new Response(compressed, {
                    headers: {
                        "content-encoding": "gzip",
                        "content-length": String(compressed.byteLength),
                        "content-type": "application/octet-stream",
                    },
                    status: 206,
                });
            },
            hostname: "127.0.0.1",
            port: 0,
        });
        const proxy = startDevelopmentRemoteProxy({
            frontendTarget: upstream.url.origin,
            port: 0,
            publicOrigin,
        });

        try {
            const response = await fetch(
                `${proxy.url.origin}//outside.example/assets?revision=2`,
                {
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue("streamed-");
                            controller.enqueue("request");
                            controller.close();
                        },
                    }),
                    decompress: false,
                    duplex: "half",
                    headers: {
                        host: "dashboard.magicdns.test:3445",
                        origin: "https://dashboard.magicdns.test:3445",
                    },
                    method: "POST",
                }
            );

            expect(response.status).toBe(206);
            expect(response.headers.get("content-encoding")).toBe("gzip");
            expect(response.headers.get("content-length")).toBe(
                String(compressed.byteLength)
            );
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(compressed);
            expect(observed).toEqual({
                body: "streamed-request",
                host: upstream.url.host,
                origin: "https://dashboard.magicdns.test:3445",
                pathname: "/outside.example/assets",
                search: "?revision=2",
            });
        } finally {
            await proxy.stop(true);
            await upstream.stop(true);
        }
    });

    test("bridges HMR and application WebSockets with path-specific Origin handling", async () => {
        const upstream = startObservedWebSocketServer();
        const proxy = startDevelopmentRemoteProxy({
            frontendTarget: upstream.url.origin,
            port: 0,
            publicOrigin,
        });
        const hmr = new WebSocket(websocketUrl(proxy.url.origin, "/_bun/hmr?key=1"), {
            headers: { host: publicHost, origin: publicOrigin },
            perMessageDeflate: false,
        });
        hmr.binaryType = "arraybuffer";
        const hmrObserved = nextMessage(hmr);

        try {
            await opened(hmr);
            const hmrObservedMessage = await hmrObserved;
            expect(JSON.parse(String(hmrObservedMessage.data))).toEqual({
                host: upstream.url.host,
                offeredProtocols: null,
                origin: upstream.url.origin,
                pathname: "/_bun/hmr",
                search: "?key=1",
            });
            const hmrEcho = nextMessage(hmr);
            hmr.send("hmr-update");
            const hmrEchoMessage = await hmrEcho;
            expect(hmrEchoMessage.data).toBe("hmr-update");

            const token = `${"0".repeat(32)}.${"1".repeat(64)}`;
            const application = new WebSocket(
                websocketUrl(proxy.url.origin, "/api/terminal/session/socket"),
                {
                    headers: { host: publicHost, origin: publicOrigin },
                    perMessageDeflate: false,
                    protocols: ["mira-terminal-v1", token],
                }
            );
            application.binaryType = "arraybuffer";
            const applicationObserved = nextMessage(application);
            try {
                await opened(application);
                expect(application.protocol).toBe("mira-terminal-v1");
                const applicationObservedMessage = await applicationObserved;
                expect(JSON.parse(String(applicationObservedMessage.data))).toEqual({
                    host: upstream.url.host,
                    offeredProtocols: `mira-terminal-v1, ${token}`,
                    origin: publicOrigin,
                    pathname: "/api/terminal/session/socket",
                    search: "",
                });
                const binaryEcho = nextMessage(application);
                application.send(Uint8Array.of(1, 3, 5, 7));
                const binaryEchoMessage = await binaryEcho;
                expect(new Uint8Array(binaryEchoMessage.data as ArrayBuffer)).toEqual(
                    Uint8Array.of(1, 3, 5, 7)
                );
            } finally {
                await closeSocket(application);
            }
        } finally {
            await closeSocket(hmr);
            await proxy.stop(true);
            await upstream.stop(true);
        }
    }, 10_000);

    test("rejects requests outside the configured public Host and HMR Origin", async () => {
        const upstream = startObservedWebSocketServer();
        const proxy = startDevelopmentRemoteProxy({
            frontendTarget: upstream.url.origin,
            port: 0,
            publicOrigin,
        });

        try {
            const invalidHostResponse = await fetch(proxy.url, {
                headers: { host: "hostile.magicdns.test:3445" },
            });
            expect(invalidHostResponse.status).toBe(421);

            for (const headers of [
                { host: "hostile.magicdns.test:3445", origin: publicOrigin },
                { host: publicHost, origin: "https://hostile.magicdns.test:3445" },
                { host: publicHost },
            ]) {
                const socket = new WebSocket(
                    websocketUrl(proxy.url.origin, "/_bun/hmr"),
                    { headers, perMessageDeflate: false }
                );
                await expectOpenRejection(socket);
                await closeSocket(socket);
            }
        } finally {
            await proxy.stop(true);
            await upstream.stop(true);
        }
    });

    test("uses bounded payload, queue, and upstream backpressure limits", () => {
        const handler = developmentRemoteWebSocketHandler();
        expect(handler.maxPayloadLength).toBe(developmentRemoteProxyMessageMaximumBytes);
        expect(handler.backpressureLimit).toBe(
            developmentRemoteProxyBufferedMaximumBytes
        );
        expect(handler.closeOnBackpressureLimit).toBeTrue();
        expect(handler.perMessageDeflate).toBeFalse();

        const data = socketData();
        const upstreamClose = jest.fn();
        const upstreamSend = jest.fn();
        data.upstream = {
            bufferedAmount: developmentRemoteProxyBufferedMaximumBytes,
            close: upstreamClose,
            readyState: WebSocket.OPEN,
            send: upstreamSend,
        } as unknown as WebSocket;
        const downstreamClose = jest.fn();
        const socket = {
            close: downstreamClose,
            data,
            readyState: WebSocket.OPEN,
        } as unknown as ServerWebSocket<DevelopmentRemoteProxySocketData>;

        void handler.message(socket, "input");

        expect(upstreamSend).not.toHaveBeenCalled();
        expect(upstreamClose).toHaveBeenCalledWith(
            1011,
            "Upstream backpressure exceeded"
        );
        expect(downstreamClose).toHaveBeenCalledWith(
            1011,
            "Upstream backpressure exceeded"
        );
    });

    test("drains queued downstream messages without dropping them", () => {
        const handler = developmentRemoteWebSocketHandler();
        const data = socketData();
        data.downstreamBackpressured = true;
        data.downstreamPendingBytes = 11;
        data.downstreamPendingMessages = ["first", "second"];
        const send = jest
            .fn(() => -1)
            .mockReturnValueOnce(-1)
            .mockReturnValueOnce(6);
        const socket = {
            close: jest.fn(),
            data,
            readyState: WebSocket.OPEN,
            send,
        } as unknown as ServerWebSocket<DevelopmentRemoteProxySocketData>;

        void handler.drain?.(socket);

        expect(send).toHaveBeenNthCalledWith(1, "first");
        expect(data.downstreamBackpressured).toBeTrue();
        expect(data.downstreamPendingBytes).toBe(6);
        expect(data.downstreamPendingMessages).toEqual(["second"]);

        void handler.drain?.(socket);

        expect(send).toHaveBeenNthCalledWith(2, "second");
        expect(data.downstreamBackpressured).toBeFalse();
        expect(data.downstreamPendingBytes).toBe(0);
        expect(data.downstreamPendingMessages).toEqual([]);
    });

    test("bounds pre-open queues even when messages contain no bytes", () => {
        const handler = developmentRemoteWebSocketHandler();
        const data = socketData();
        const upstreamClose = jest.fn();
        data.upstream = {
            close: upstreamClose,
            readyState: WebSocket.CONNECTING,
        } as unknown as WebSocket;
        const downstreamClose = jest.fn();
        const socket = {
            close: downstreamClose,
            data,
            readyState: WebSocket.OPEN,
        } as unknown as ServerWebSocket<DevelopmentRemoteProxySocketData>;

        for (
            let index = 0;
            index <= developmentRemoteProxyQueuedMessageMaximum;
            index++
        ) {
            void handler.message(socket, "");
        }

        expect(upstreamClose).toHaveBeenCalledWith(1009, "Proxy input buffer exceeded");
        expect(downstreamClose).toHaveBeenCalledWith(1009, "Proxy input buffer exceeded");
        expect(data.upstreamPendingMessages).toEqual([]);
    });

    test("maps reserved and abnormal WebSocket close codes", () => {
        expect(developmentRemoteProxyCloseCode(1000)).toBe(1000);
        expect(developmentRemoteProxyCloseCode(1009)).toBe(1009);
        expect(developmentRemoteProxyCloseCode(4001)).toBe(4001);
        expect(developmentRemoteProxyCloseCode(0)).toBe(1011);
        expect(developmentRemoteProxyCloseCode(1005)).toBe(1011);
        expect(developmentRemoteProxyCloseCode(1006)).toBe(1011);
        expect(developmentRemoteProxyCloseCode(1015)).toBe(1011);
    });
});
