import type { Server, ServerWebSocket } from "bun";

import {
    terminalClientMessageMaximumBytes,
    terminalServerMessageMaximumBytes,
    terminalSocketBufferedMaximumBytes,
    terminalWebSocketProtocol,
} from "../../src/contracts/terminal.ts";

const canonicalSessionCookie = "__Host-mira_dashboard_session";
const canonicalPendingLoginCookie = "__Host-mira_dashboard_pending_login";
const terminalSocketPath =
    /^\/api\/terminal\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/socket$/u;
const terminalConnectionToken = /^[0-9a-f]{32}\.[0-9a-f]{64}$/u;
export const developmentProxyQueuedMessageMaximum = 1024;
const hopByHopHeaders = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;

export interface DevelopmentProxyConfiguration {
    readonly apiTarget: string;
    readonly cookieNamespace: string;
    readonly publicOrigin: string;
}

export interface DevelopmentProxySocketData {
    backend?: WebSocket;
    backendPendingBytes: number;
    backendPendingMessages: Array<string | Uint8Array>;
    readonly backendUrl: string;
    browserBackpressured: boolean;
    browserPendingBytes: number;
    browserPendingMessages: Array<string | Uint8Array>;
    readonly clientAddress?: string;
    readonly cookie?: string;
    readonly protocols: readonly [string, string];
}

function namespacedCookieNames(namespace: string): Readonly<{
    pendingLogin: string;
    session: string;
}> {
    if (!/^__Host-[A-Za-z0-9_]{1,96}$/u.test(namespace)) {
        throw new TypeError("Development cookie namespace is invalid");
    }
    return Object.freeze({
        pendingLogin: `${namespace}_pending_login`,
        session: `${namespace}_session`,
    });
}

/**
 * Filters all host cookies and maps only namespaced dev credentials for the backend.
 * @param cookieHeader Browser Cookie header.
 * @param namespace Validated development credential namespace.
 * @returns Canonical backend credentials, or undefined when none are present.
 */
export function canonicalDevelopmentCookieHeader(
    cookieHeader: string | null,
    namespace: string
): string | undefined {
    if (cookieHeader === null || cookieHeader.length > 16 * 1024) return;
    const names = namespacedCookieNames(namespace);
    const mapped: string[] = [];
    for (const part of cookieHeader.split(";")) {
        const cookie = part.trim();
        const separator = cookie.indexOf("=");
        if (separator < 1) continue;
        const name = cookie.slice(0, separator).trim();
        const value = cookie.slice(separator + 1);
        if (name === names.session) {
            mapped.push(`${canonicalSessionCookie}=${value}`);
        } else if (name === names.pendingLogin) {
            mapped.push(`${canonicalPendingLoginCookie}=${value}`);
        }
    }
    return mapped.length === 0 ? undefined : mapped.join("; ");
}

/**
 * Maps canonical backend credential cookies back to the isolated frontend namespace.
 * @param setCookie One backend Set-Cookie header.
 * @param namespace Validated development credential namespace.
 * @returns The cookie header mapped into the isolated development namespace.
 */
export function namespacedDevelopmentSetCookie(
    setCookie: string,
    namespace: string
): string {
    const names = namespacedCookieNames(namespace);
    if (setCookie.startsWith(`${canonicalSessionCookie}=`)) {
        return `${names.session}${setCookie.slice(canonicalSessionCookie.length)}`;
    }
    if (setCookie.startsWith(`${canonicalPendingLoginCookie}=`)) {
        return `${names.pendingLogin}${setCookie.slice(canonicalPendingLoginCookie.length)}`;
    }
    return setCookie;
}

/**
 * Checks whether the fixed backend owns a request path in development.
 * @param pathname URL pathname to classify.
 * @returns Whether the request belongs to the API or tRPC backend.
 */
export function isDevelopmentBackendPath(pathname: string): boolean {
    return (
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/trpc" ||
        pathname.startsWith("/trpc/")
    );
}

function forwardedHeaders(
    request: Request,
    clientAddress: string | undefined,
    configuration: DevelopmentProxyConfiguration,
    target: URL
): Headers {
    const headers = new Headers(request.headers);
    for (const name of hopByHopHeaders) headers.delete(name);
    headers.delete("forwarded");
    headers.delete("x-forwarded-for");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
    headers.delete("x-real-ip");
    headers.set("host", target.host);
    const cookie = canonicalDevelopmentCookieHeader(
        request.headers.get("cookie"),
        configuration.cookieNamespace
    );
    if (cookie === undefined) headers.delete("cookie");
    else headers.set("cookie", cookie);
    if (clientAddress !== undefined) {
        headers.set("x-forwarded-for", clientAddress);
        headers.set("x-real-ip", clientAddress);
    }
    const publicOrigin = new URL(configuration.publicOrigin);
    headers.set("x-forwarded-host", publicOrigin.host);
    headers.set("x-forwarded-proto", publicOrigin.protocol.slice(0, -1));
    return headers;
}

function responseHeaders(
    upstream: Response,
    configuration: DevelopmentProxyConfiguration
): Headers {
    const headers = new Headers(upstream.headers);
    for (const name of hopByHopHeaders) headers.delete(name);
    const setCookies = upstream.headers.getSetCookie();
    headers.delete("set-cookie");
    for (const setCookie of setCookies) {
        headers.append(
            "set-cookie",
            namespacedDevelopmentSetCookie(setCookie, configuration.cookieNamespace)
        );
    }
    return headers;
}

/**
 * Streams one fixed-path HTTP request to the loopback development web process.
 * @param request Incoming frontend request.
 * @param server Bun server used to derive the direct client address.
 * @param configuration Validated proxy configuration.
 * @returns The streamed upstream response or a fixed rejection response.
 */
export async function proxyDevelopmentHttp(
    request: Request,
    server: Pick<Server<DevelopmentProxySocketData>, "requestIP">,
    configuration: DevelopmentProxyConfiguration
): Promise<Response> {
    const source = new URL(request.url);
    if (!isDevelopmentBackendPath(source.pathname)) {
        return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("upgrade") !== null) {
        return new Response("Invalid upgrade", { status: 400 });
    }
    const target = new URL(`${source.pathname}${source.search}`, configuration.apiTarget);
    const headers = forwardedHeaders(
        request,
        server.requestIP(request)?.address,
        configuration,
        target
    );
    let upstream: Response;
    try {
        upstream = await fetch(target, {
            body: request.body,
            decompress: false,
            duplex: "half",
            headers,
            method: request.method,
            redirect: "manual",
            signal: request.signal,
        });
    } catch {
        return new Response("Development backend unavailable", { status: 502 });
    }
    return new Response(upstream.body, {
        headers: responseHeaders(upstream, configuration),
        status: upstream.status,
        statusText: upstream.statusText,
    });
}

function terminalProtocols(request: Request): readonly [string, string] | undefined {
    const value = request.headers.get("sec-websocket-protocol");
    if (value === null || value.length > 256) return;
    const protocols = value.split(",").map((protocol) => protocol.trim());
    if (
        protocols.length !== 2 ||
        protocols[0] !== terminalWebSocketProtocol ||
        !terminalConnectionToken.test(protocols[1] ?? "")
    ) {
        return;
    }
    return [protocols[0], protocols[1]!] as const;
}

/**
 * Upgrades only the exact terminal path and preserves both offered subprotocol values.
 * @param request Incoming WebSocket upgrade request.
 * @param server Bun server that owns the frontend socket.
 * @param configuration Validated proxy configuration.
 * @returns A deterministic upgrade acknowledgement or rejection response.
 */
export function proxyDevelopmentWebSocket(
    request: Request,
    server: Server<DevelopmentProxySocketData>,
    configuration: DevelopmentProxyConfiguration
): Response | undefined {
    const url = new URL(request.url);
    const protocols = terminalProtocols(request);
    if (
        request.method !== "GET" ||
        !terminalSocketPath.test(url.pathname) ||
        url.search !== "" ||
        request.headers.get("origin") !== configuration.publicOrigin ||
        protocols === undefined
    ) {
        return new Response("Invalid WebSocket upgrade", { status: 400 });
    }
    const cookie = canonicalDevelopmentCookieHeader(
        request.headers.get("cookie"),
        configuration.cookieNamespace
    );
    const upgraded = server.upgrade(request, {
        data: {
            backendPendingBytes: 0,
            backendPendingMessages: [],
            backendUrl: new URL(
                `${url.pathname}${url.search}`,
                configuration.apiTarget
            ).href.replace(/^http/u, "ws"),
            browserBackpressured: false,
            browserPendingBytes: 0,
            browserPendingMessages: [],
            clientAddress: server.requestIP(request)?.address,
            ...(cookie === undefined ? {} : { cookie }),
            protocols,
        },
        headers: {
            "cache-control": "no-store",
            "sec-websocket-protocol": terminalWebSocketProtocol,
        },
    });
    if (upgraded) return;
    return new Response("WebSocket upgrade failed", { status: 400 });
}

function copiedBinaryMessage(message: Uint8Array): Uint8Array {
    return new Uint8Array(message);
}

function messageBytes(message: string | Uint8Array): number {
    return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

const standardProxyCloseCodes = new Set([
    1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
]);

/**
 * Maps upstream transport-only and reserved close codes to one valid server error.
 * @param code Upstream WebSocket close code.
 * @returns A WebSocket code legal to transmit to the browser.
 */
export function developmentProxyCloseCode(code: number): number {
    return standardProxyCloseCodes.has(code) || (code >= 3000 && code <= 4999)
        ? code
        : 1011;
}

function developmentProxyCloseReason(reason: string): string {
    return Buffer.byteLength(reason) <= 123 ? reason : "Upstream closed";
}

function clearProxyQueues(data: DevelopmentProxySocketData): void {
    data.backendPendingBytes = 0;
    data.backendPendingMessages = [];
    data.browserBackpressured = false;
    data.browserPendingBytes = 0;
    data.browserPendingMessages = [];
}

function closeProxySocket(
    socket: ServerWebSocket<DevelopmentProxySocketData>,
    code = 1011,
    reason = "Proxy unavailable"
): void {
    clearProxyQueues(socket.data);
    const validCode = developmentProxyCloseCode(code);
    const validReason = developmentProxyCloseReason(reason);
    const backend = socket.data.backend;
    if (
        backend !== undefined &&
        (backend.readyState === WebSocket.CONNECTING ||
            backend.readyState === WebSocket.OPEN)
    ) {
        try {
            backend.close(validCode, validReason);
        } catch {
            backend.close();
        }
    }
    if (socket.readyState === WebSocket.OPEN) {
        socket.close(validCode, validReason);
    }
}

function enqueueBrowserMessage(
    socket: ServerWebSocket<DevelopmentProxySocketData>,
    message: string | Uint8Array
): void {
    const bytes = messageBytes(message);
    if (
        socket.data.browserPendingMessages.length >=
            developmentProxyQueuedMessageMaximum ||
        socket.data.browserPendingBytes + bytes > terminalSocketBufferedMaximumBytes
    ) {
        closeProxySocket(socket, 1011, "Proxy backpressure exceeded");
        return;
    }
    socket.data.browserPendingBytes += bytes;
    socket.data.browserPendingMessages.push(message);
}

function sendBrowserMessage(
    socket: ServerWebSocket<DevelopmentProxySocketData>,
    message: string | Uint8Array
): void {
    if (messageBytes(message) > terminalServerMessageMaximumBytes) {
        closeProxySocket(socket, 1009, "Upstream message exceeded limit");
        return;
    }
    if (
        socket.data.browserBackpressured ||
        socket.data.browserPendingMessages.length > 0
    ) {
        enqueueBrowserMessage(socket, message);
        return;
    }
    const sent = socket.send(message);
    if (sent === 0) {
        closeProxySocket(socket, 1011, "Proxy delivery failed");
    } else if (sent < 0) {
        socket.data.browserBackpressured = true;
    }
}

function drainBrowserMessages(socket: ServerWebSocket<DevelopmentProxySocketData>): void {
    socket.data.browserBackpressured = false;
    while (
        socket.readyState === WebSocket.OPEN &&
        socket.data.browserPendingMessages.length > 0
    ) {
        const message = socket.data.browserPendingMessages.shift();
        if (message === undefined) return;
        socket.data.browserPendingBytes -= messageBytes(message);
        const sent = socket.send(message);
        if (sent === 0) {
            closeProxySocket(socket, 1011, "Proxy delivery failed");
            return;
        }
        if (sent < 0) {
            socket.data.browserBackpressured = true;
            return;
        }
    }
}

function sendBackendMessage(
    socket: ServerWebSocket<DevelopmentProxySocketData>,
    message: string | Uint8Array
): void {
    const backend = socket.data.backend;
    if (backend?.readyState !== WebSocket.OPEN) {
        closeProxySocket(socket);
        return;
    }
    const bytes = messageBytes(message);
    if (bytes > terminalClientMessageMaximumBytes) {
        closeProxySocket(socket, 1009, "Client message exceeded limit");
        return;
    }
    if (backend.bufferedAmount + bytes > terminalSocketBufferedMaximumBytes) {
        closeProxySocket(socket, 1011, "Upstream backpressure exceeded");
        return;
    }
    try {
        backend.send(message);
    } catch {
        closeProxySocket(socket);
        return;
    }
    if (backend.bufferedAmount > terminalSocketBufferedMaximumBytes) {
        closeProxySocket(socket, 1011, "Upstream backpressure exceeded");
    }
}

function enqueueBackendMessage(
    socket: ServerWebSocket<DevelopmentProxySocketData>,
    message: string | Uint8Array
): void {
    const bytes = messageBytes(message);
    if (
        bytes > terminalClientMessageMaximumBytes ||
        socket.data.backendPendingMessages.length >=
            developmentProxyQueuedMessageMaximum ||
        socket.data.backendPendingBytes + bytes > terminalSocketBufferedMaximumBytes
    ) {
        closeProxySocket(socket, 1009, "Proxy input buffer exceeded");
        return;
    }
    socket.data.backendPendingBytes += bytes;
    socket.data.backendPendingMessages.push(message);
}

function flushBackendMessages(socket: ServerWebSocket<DevelopmentProxySocketData>): void {
    const pending = socket.data.backendPendingMessages;
    socket.data.backendPendingMessages = [];
    socket.data.backendPendingBytes = 0;
    for (const message of pending) {
        if (socket.readyState !== WebSocket.OPEN) return;
        sendBackendMessage(socket, message);
    }
}

/**
 * Creates the Bun WebSocket handler for the bounded terminal relay.
 * @param configuration Validated proxy configuration.
 * @returns A size- and backpressure-bounded WebSocket handler.
 */
export function developmentWebSocketHandler(
    configuration: DevelopmentProxyConfiguration
): Bun.WebSocketHandler<DevelopmentProxySocketData> {
    return {
        backpressureLimit: terminalSocketBufferedMaximumBytes,
        closeOnBackpressureLimit: true,
        close(socket, code) {
            clearProxyQueues(socket.data);
            const backend = socket.data.backend;
            if (
                backend !== undefined &&
                (backend.readyState === WebSocket.CONNECTING ||
                    backend.readyState === WebSocket.OPEN)
            ) {
                backend.close(developmentProxyCloseCode(code), "Client closed");
            }
        },
        drain(socket) {
            drainBrowserMessages(socket);
        },
        maxPayloadLength: terminalClientMessageMaximumBytes,
        message(socket, message) {
            const forwarded =
                typeof message === "string" ? message : copiedBinaryMessage(message);
            const backend = socket.data.backend;
            if (backend?.readyState === WebSocket.OPEN) {
                sendBackendMessage(socket, forwarded);
                return;
            }
            if (backend !== undefined && backend.readyState !== WebSocket.CONNECTING) {
                closeProxySocket(socket);
                return;
            }
            enqueueBackendMessage(socket, forwarded);
        },
        open(socket) {
            const headers = new Headers({ origin: configuration.publicOrigin });
            if (socket.data.cookie !== undefined) {
                headers.set("cookie", socket.data.cookie);
            }
            if (socket.data.clientAddress !== undefined) {
                headers.set("x-forwarded-for", socket.data.clientAddress);
                headers.set("x-real-ip", socket.data.clientAddress);
            }
            const publicOrigin = new URL(configuration.publicOrigin);
            headers.set("x-forwarded-host", publicOrigin.host);
            headers.set("x-forwarded-proto", publicOrigin.protocol.slice(0, -1));
            let backend: WebSocket;
            try {
                backend = new WebSocket(socket.data.backendUrl, {
                    headers: Object.fromEntries(headers),
                    perMessageDeflate: false,
                    protocols: [...socket.data.protocols],
                });
            } catch {
                closeProxySocket(socket);
                return;
            }
            socket.data.backend = backend;
            backend.binaryType = "arraybuffer";
            backend.addEventListener("open", () => {
                // Bun may leave `protocol` empty for a valid multi-protocol handshake;
                // the fixed backend has already validated the exact offered tuple.
                flushBackendMessages(socket);
            });
            backend.addEventListener("message", (event) => {
                if (socket.readyState !== WebSocket.OPEN) return;
                if (typeof event.data === "string") {
                    sendBrowserMessage(socket, event.data);
                } else if (event.data instanceof ArrayBuffer) {
                    sendBrowserMessage(socket, new Uint8Array(event.data));
                } else if (ArrayBuffer.isView(event.data)) {
                    sendBrowserMessage(
                        socket,
                        new Uint8Array(
                            event.data.buffer,
                            event.data.byteOffset,
                            event.data.byteLength
                        )
                    );
                }
            });
            backend.addEventListener("close", (event) => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.close(
                        developmentProxyCloseCode(event.code),
                        developmentProxyCloseReason(event.reason)
                    );
                }
            });
            backend.addEventListener("error", () => closeProxySocket(socket));
        },
        perMessageDeflate: false,
    };
}
