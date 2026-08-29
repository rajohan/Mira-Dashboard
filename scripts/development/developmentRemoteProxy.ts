import path from "node:path";

import type { ServerWebSocket } from "bun";

const loopbackListenerHost = "127.0.0.1";
const webSocketProtocolToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const hopByHopHeaders = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;
const webSocketHandshakeHeaders = [
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
] as const;
const standardProxyCloseCodes = new Set([
    1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
]);

export const developmentRemoteProxyMessageMaximumBytes = 16 * 1024 * 1024;
export const developmentRemoteProxyBufferedMaximumBytes = 16 * 1024 * 1024;
export const developmentRemoteProxyQueuedMessageMaximum = 1024;

type DevelopmentRemoteProxyMessage = string | Uint8Array;

export interface DevelopmentRemoteProxyConfiguration {
    readonly frontendTarget: string;
    readonly port: number;
    readonly publicOrigin: string;
}

export interface DevelopmentUnixProxyConfiguration {
    readonly frontendTarget: string;
    readonly publicOrigin: string;
    readonly unix: string;
}

export interface DevelopmentRemoteProxySocketData {
    downstreamBackpressured: boolean;
    downstreamPendingBytes: number;
    downstreamPendingMessages: DevelopmentRemoteProxyMessage[];
    isClosing: boolean;
    readonly protocols: readonly string[];
    upstream?: WebSocket;
    readonly upstreamHeaders: Readonly<Record<string, string>>;
    upstreamPendingBytes: number;
    upstreamPendingMessages: DevelopmentRemoteProxyMessage[];
    readonly upstreamUrl: string;
}

interface ResolvedDevelopmentRemoteProxyConfiguration {
    readonly frontendTarget: URL;
    readonly port: number;
    readonly publicOrigin: URL;
}

function resolvedConfiguration(
    configuration: DevelopmentRemoteProxyConfiguration
): ResolvedDevelopmentRemoteProxyConfiguration {
    let frontendTarget: URL;
    let publicOrigin: URL;
    try {
        frontendTarget = new URL(configuration.frontendTarget);
    } catch {
        throw new TypeError("Development remote proxy target must be a loopback origin");
    }
    try {
        publicOrigin = new URL(configuration.publicOrigin);
    } catch {
        throw new TypeError("Development remote proxy public origin must be HTTPS");
    }
    if (
        publicOrigin.protocol !== "https:" ||
        publicOrigin.hostname === "" ||
        publicOrigin.username !== "" ||
        publicOrigin.password !== "" ||
        publicOrigin.pathname !== "/" ||
        publicOrigin.search !== "" ||
        publicOrigin.hash !== ""
    ) {
        throw new TypeError("Development remote proxy public origin must be HTTPS");
    }
    if (
        frontendTarget.protocol !== "http:" ||
        (frontendTarget.hostname !== "127.0.0.1" &&
            frontendTarget.hostname !== "localhost" &&
            frontendTarget.hostname !== "[::1]") ||
        frontendTarget.port === "" ||
        frontendTarget.username !== "" ||
        frontendTarget.password !== "" ||
        (frontendTarget.pathname !== "" && frontendTarget.pathname !== "/") ||
        frontendTarget.search !== "" ||
        frontendTarget.hash !== ""
    ) {
        throw new TypeError("Development remote proxy target must be a loopback origin");
    }
    if (
        !Number.isSafeInteger(configuration.port) ||
        configuration.port < 0 ||
        configuration.port > 65_535
    ) {
        throw new TypeError(
            "Development remote proxy port must be an integer between 0 and 65535"
        );
    }
    if (configuration.port !== 0 && configuration.port === Number(frontendTarget.port)) {
        throw new TypeError("Development remote proxy and frontend ports must differ");
    }
    return Object.freeze({
        frontendTarget: new URL(frontendTarget.origin),
        port: configuration.port,
        publicOrigin: new URL(publicOrigin.origin),
    });
}

function hasExpectedPublicHost(request: Request, publicOrigin: URL): boolean {
    return request.headers.get("host")?.toLowerCase() === publicOrigin.host.toLowerCase();
}

function targetUrl(source: URL, frontendTarget: URL, webSocket: boolean): URL {
    const target = new URL(frontendTarget.href);
    target.pathname = source.pathname;
    target.search = source.search;
    if (webSocket) target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    return target;
}

function headersWithoutHopByHop(source: Headers): Headers {
    const headers = new Headers(source);
    for (const value of source.get("connection")?.split(",") ?? []) {
        const name = value.trim();
        if (webSocketProtocolToken.test(name)) headers.delete(name);
    }
    for (const name of hopByHopHeaders) headers.delete(name);
    return headers;
}

function forwardedHttpHeaders(request: Request, target: URL): Headers {
    const headers = headersWithoutHopByHop(request.headers);
    headers.set("host", target.host);
    return headers;
}

function forwardedResponseHeaders(response: Response): Headers {
    return headersWithoutHopByHop(response.headers);
}

async function proxyHttp(request: Request, frontendTarget: URL): Promise<Response> {
    if (request.headers.has("upgrade")) {
        return new Response("Invalid upgrade", { status: 400 });
    }
    const target = targetUrl(new URL(request.url), frontendTarget, false);
    try {
        const upstream = await fetch(target, {
            body: request.body,
            decompress: false,
            duplex: "half",
            headers: forwardedHttpHeaders(request, target),
            method: request.method,
            redirect: "manual",
            signal: request.signal,
        });
        return new Response(upstream.body, {
            headers: forwardedResponseHeaders(upstream),
            status: upstream.status,
            statusText: upstream.statusText,
        });
    } catch {
        return new Response("Development frontend unavailable", { status: 502 });
    }
}

function requestedProtocols(request: Request): readonly string[] | undefined {
    const header = request.headers.get("sec-websocket-protocol");
    if (header === null) return [];
    if (Buffer.byteLength(header) > 4096) return;
    const protocols = header.split(",").map((protocol) => protocol.trim());
    if (
        protocols.length === 0 ||
        protocols.length > 32 ||
        protocols.some((protocol) => !webSocketProtocolToken.test(protocol)) ||
        new Set(protocols).size !== protocols.length
    ) {
        return;
    }
    return protocols;
}

function forwardedWebSocketHeaders(
    request: Request,
    target: URL,
    rewriteOrigin: boolean
): Readonly<Record<string, string>> {
    const headers = headersWithoutHopByHop(request.headers);
    for (const name of webSocketHandshakeHeaders) headers.delete(name);
    // Bun derives the single upstream Host from the fixed WebSocket URL.
    headers.delete("host");
    if (rewriteOrigin) {
        const httpOrigin = new URL(target.href);
        httpOrigin.protocol = "http:";
        headers.set("origin", httpOrigin.origin);
    }
    return Object.freeze(Object.fromEntries(headers));
}

function upgradeWebSocket(
    request: Request,
    server: Bun.Server<DevelopmentRemoteProxySocketData>,
    frontendTarget: URL,
    publicOrigin: URL
): Response | undefined {
    const source = new URL(request.url);
    const protocols = requestedProtocols(request);
    if (
        request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        protocols === undefined
    ) {
        return new Response("Invalid WebSocket upgrade", { status: 400 });
    }
    const rewriteOrigin = source.pathname === "/_bun/hmr";
    if (rewriteOrigin && request.headers.get("origin") !== publicOrigin.origin) {
        return new Response("Invalid HMR origin", { status: 403 });
    }
    const target = targetUrl(source, frontendTarget, true);
    const selectedProtocol = protocols[0];
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    if (selectedProtocol !== undefined) {
        responseHeaders.set("sec-websocket-protocol", selectedProtocol);
    }
    const upgraded = server.upgrade(request, {
        data: {
            downstreamBackpressured: false,
            downstreamPendingBytes: 0,
            downstreamPendingMessages: [],
            isClosing: false,
            protocols,
            upstreamHeaders: forwardedWebSocketHeaders(request, target, rewriteOrigin),
            upstreamPendingBytes: 0,
            upstreamPendingMessages: [],
            upstreamUrl: target.href,
        },
        headers: responseHeaders,
    });
    if (upgraded) return;
    return new Response("WebSocket upgrade failed", { status: 400 });
}

function messageBytes(message: DevelopmentRemoteProxyMessage): number {
    return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

function copiedBinaryMessage(message: Uint8Array): Uint8Array {
    return new Uint8Array(message);
}

function upstreamMessage(data: unknown): DevelopmentRemoteProxyMessage | undefined {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return copiedBinaryMessage(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
        return copiedBinaryMessage(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        );
    }
    return;
}

/**
 * Maps reserved or transport-only WebSocket close codes to a transmissible code.
 * @param code Close code received from either side of the relay.
 * @returns A legal close code for the opposite peer.
 */
export function developmentRemoteProxyCloseCode(code: number): number {
    return standardProxyCloseCodes.has(code) || (code >= 3000 && code <= 4999)
        ? code
        : 1011;
}

function closeReason(reason: string, fallback: string): string {
    return Buffer.byteLength(reason) <= 123 ? reason : fallback;
}

function clearQueues(data: DevelopmentRemoteProxySocketData): void {
    data.downstreamBackpressured = false;
    data.downstreamPendingBytes = 0;
    data.downstreamPendingMessages = [];
    data.upstreamPendingBytes = 0;
    data.upstreamPendingMessages = [];
}

function closeUpstream(upstream: WebSocket, code: number, reason: string): void {
    if (
        upstream.readyState !== WebSocket.CONNECTING &&
        upstream.readyState !== WebSocket.OPEN
    ) {
        return;
    }
    try {
        upstream.close(code, reason);
    } catch {
        try {
            upstream.close();
        } catch {
            // The upstream socket may settle at the same time as the relay.
        }
    }
}

function closeRelay(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>,
    code = 1011,
    reason = "Proxy unavailable"
): void {
    if (socket.data.isClosing) return;
    socket.data.isClosing = true;
    clearQueues(socket.data);
    const validCode = developmentRemoteProxyCloseCode(code);
    const validReason = closeReason(reason, "Proxy closed");
    const upstream = socket.data.upstream;
    if (upstream !== undefined) closeUpstream(upstream, validCode, validReason);
    if (socket.readyState === WebSocket.OPEN) socket.close(validCode, validReason);
}

function enqueueDownstreamMessage(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>,
    message: DevelopmentRemoteProxyMessage
): void {
    const bytes = messageBytes(message);
    if (
        socket.data.downstreamPendingMessages.length >=
            developmentRemoteProxyQueuedMessageMaximum ||
        socket.data.downstreamPendingBytes + bytes >
            developmentRemoteProxyBufferedMaximumBytes
    ) {
        closeRelay(socket, 1011, "Proxy backpressure exceeded");
        return;
    }
    socket.data.downstreamPendingBytes += bytes;
    socket.data.downstreamPendingMessages.push(message);
}

function sendDownstreamMessage(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>,
    message: DevelopmentRemoteProxyMessage
): void {
    if (messageBytes(message) > developmentRemoteProxyMessageMaximumBytes) {
        closeRelay(socket, 1009, "Upstream message exceeded limit");
        return;
    }
    if (
        socket.data.downstreamBackpressured ||
        socket.data.downstreamPendingMessages.length > 0
    ) {
        enqueueDownstreamMessage(socket, message);
        return;
    }
    const sent = socket.send(message);
    if (sent === 0) {
        closeRelay(socket, 1011, "Proxy delivery failed");
    } else if (sent < 0) {
        socket.data.downstreamBackpressured = true;
    }
}

function drainDownstreamMessages(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>
): void {
    socket.data.downstreamBackpressured = false;
    while (
        !socket.data.isClosing &&
        socket.readyState === WebSocket.OPEN &&
        socket.data.downstreamPendingMessages.length > 0
    ) {
        const message = socket.data.downstreamPendingMessages.shift();
        if (message === undefined) return;
        socket.data.downstreamPendingBytes -= messageBytes(message);
        const sent = socket.send(message);
        if (sent === 0) {
            closeRelay(socket, 1011, "Proxy delivery failed");
            return;
        }
        if (sent < 0) {
            socket.data.downstreamBackpressured = true;
            return;
        }
    }
}

function sendUpstreamMessage(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>,
    message: DevelopmentRemoteProxyMessage
): void {
    const bytes = messageBytes(message);
    if (bytes > developmentRemoteProxyMessageMaximumBytes) {
        closeRelay(socket, 1009, "Client message exceeded limit");
        return;
    }
    const upstream = socket.data.upstream;
    if (upstream?.readyState !== WebSocket.OPEN) {
        closeRelay(socket);
        return;
    }
    if (upstream.bufferedAmount + bytes > developmentRemoteProxyBufferedMaximumBytes) {
        closeRelay(socket, 1011, "Upstream backpressure exceeded");
        return;
    }
    try {
        upstream.send(message);
    } catch {
        closeRelay(socket);
        return;
    }
    if (upstream.bufferedAmount > developmentRemoteProxyBufferedMaximumBytes) {
        closeRelay(socket, 1011, "Upstream backpressure exceeded");
    }
}

function enqueueUpstreamMessage(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>,
    message: DevelopmentRemoteProxyMessage
): void {
    const bytes = messageBytes(message);
    if (
        bytes > developmentRemoteProxyMessageMaximumBytes ||
        socket.data.upstreamPendingMessages.length >=
            developmentRemoteProxyQueuedMessageMaximum ||
        socket.data.upstreamPendingBytes + bytes >
            developmentRemoteProxyBufferedMaximumBytes
    ) {
        closeRelay(socket, 1009, "Proxy input buffer exceeded");
        return;
    }
    socket.data.upstreamPendingBytes += bytes;
    socket.data.upstreamPendingMessages.push(message);
}

function flushUpstreamMessages(
    socket: ServerWebSocket<DevelopmentRemoteProxySocketData>
): void {
    const pending = socket.data.upstreamPendingMessages;
    socket.data.upstreamPendingMessages = [];
    socket.data.upstreamPendingBytes = 0;
    for (const message of pending) {
        if (socket.data.isClosing || socket.readyState !== WebSocket.OPEN) return;
        sendUpstreamMessage(socket, message);
    }
}

/**
 * Creates the bounded, protocol-transparent WebSocket relay used by the proxy.
 * @returns A Bun WebSocket handler for HMR and application sockets.
 */
export function developmentRemoteWebSocketHandler(): Bun.WebSocketHandler<DevelopmentRemoteProxySocketData> {
    return {
        backpressureLimit: developmentRemoteProxyBufferedMaximumBytes,
        closeOnBackpressureLimit: true,
        close(socket, code, reason) {
            if (socket.data.isClosing) return;
            socket.data.isClosing = true;
            clearQueues(socket.data);
            const upstream = socket.data.upstream;
            if (upstream !== undefined) {
                closeUpstream(
                    upstream,
                    developmentRemoteProxyCloseCode(code),
                    closeReason(reason, "Client closed")
                );
            }
        },
        drain(socket) {
            drainDownstreamMessages(socket);
        },
        maxPayloadLength: developmentRemoteProxyMessageMaximumBytes,
        message(socket, message) {
            const forwarded =
                typeof message === "string" ? message : copiedBinaryMessage(message);
            const upstream = socket.data.upstream;
            if (upstream?.readyState === WebSocket.OPEN) {
                sendUpstreamMessage(socket, forwarded);
                return;
            }
            if (upstream?.readyState === WebSocket.CONNECTING) {
                enqueueUpstreamMessage(socket, forwarded);
                return;
            }
            closeRelay(socket);
        },
        open(socket) {
            let upstream: WebSocket;
            try {
                upstream = new WebSocket(socket.data.upstreamUrl, {
                    headers: socket.data.upstreamHeaders,
                    perMessageDeflate: false,
                    protocols: [...socket.data.protocols],
                });
            } catch {
                closeRelay(socket);
                return;
            }
            socket.data.upstream = upstream;
            upstream.binaryType = "arraybuffer";
            upstream.addEventListener("open", () => {
                if (socket.data.isClosing) {
                    closeUpstream(upstream, 1001, "Client closed");
                    return;
                }
                // Bun does not reliably expose the selected value when multiple
                // protocols were offered. A successful fixed-target handshake is
                // the upstream readiness signal; the downstream selection is fixed
                // during its validated upgrade.
                flushUpstreamMessages(socket);
            });
            upstream.addEventListener("message", (event) => {
                if (socket.data.isClosing || socket.readyState !== WebSocket.OPEN) return;
                const message = upstreamMessage(event.data);
                if (message === undefined) {
                    closeRelay(socket, 1003, "Unsupported upstream message");
                    return;
                }
                sendDownstreamMessage(socket, message);
            });
            upstream.addEventListener("close", (event) => {
                if (socket.data.isClosing) return;
                socket.data.isClosing = true;
                clearQueues(socket.data);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.close(
                        developmentRemoteProxyCloseCode(event.code),
                        closeReason(event.reason, "Upstream closed")
                    );
                }
            });
            upstream.addEventListener("error", () => closeRelay(socket));
        },
        perMessageDeflate: false,
    };
}

/**
 * Starts a development-only loopback proxy in front of Bun's full-stack server.
 * @param configuration Fixed loopback frontend target and local listener port.
 * @returns The active Bun proxy server. Call `stop()` during stack shutdown.
 */
export function startDevelopmentRemoteProxy(
    configuration: DevelopmentRemoteProxyConfiguration
): Bun.Server<DevelopmentRemoteProxySocketData> {
    const resolved = resolvedConfiguration(configuration);
    return Bun.serve<DevelopmentRemoteProxySocketData>({
        fetch(request, server) {
            server.timeout(request, 0);
            if (!hasExpectedPublicHost(request, resolved.publicOrigin)) {
                return new Response("Invalid development host", { status: 421 });
            }
            if (request.headers.has("upgrade")) {
                return upgradeWebSocket(
                    request,
                    server,
                    resolved.frontendTarget,
                    resolved.publicOrigin
                );
            }
            return proxyHttp(request, resolved.frontendTarget);
        },
        hostname: loopbackListenerHost,
        port: resolved.port,
        websocket: developmentRemoteWebSocketHandler(),
    });
}

/**
 * Starts the same transparent frontend proxy on one private Unix socket.
 * @param configuration Fixed frontend target, public origin, and absolute socket.
 * @returns The active Bun proxy server. Call `stop()` during stack shutdown.
 */
export function startDevelopmentUnixProxy(
    configuration: DevelopmentUnixProxyConfiguration
): Bun.Server<DevelopmentRemoteProxySocketData> {
    if (
        !path.isAbsolute(configuration.unix) ||
        path.normalize(configuration.unix) !== configuration.unix ||
        configuration.unix.includes("\0")
    ) {
        throw new TypeError("Development Unix proxy socket must be absolute");
    }
    const resolved = resolvedConfiguration({
        frontendTarget: configuration.frontendTarget,
        port: 0,
        publicOrigin: configuration.publicOrigin,
    });
    return Bun.serve<DevelopmentRemoteProxySocketData>({
        fetch(request, server) {
            server.timeout(request, 0);
            if (!hasExpectedPublicHost(request, resolved.publicOrigin)) {
                return new Response("Invalid development host", { status: 421 });
            }
            if (request.headers.has("upgrade")) {
                return upgradeWebSocket(
                    request,
                    server,
                    resolved.frontendTarget,
                    resolved.publicOrigin
                );
            }
            return proxyHttp(request, resolved.frontendTarget);
        },
        unix: configuration.unix,
        websocket: developmentRemoteWebSocketHandler(),
    });
}
