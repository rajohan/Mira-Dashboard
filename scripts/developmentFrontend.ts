import dashboard from "../index.html";
import type { Server } from "bun";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "5173");
const apiTarget = process.env.DASHBOARD_API_TARGET || "http://localhost:3100";
const backendWebSocketTarget = apiTarget.replace(/^http/u, "ws");

interface WebSocketProxyData {
    backend?: WebSocket;
    clientAddress?: string;
    cookie?: string;
    origin?: string;
    pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
    protocol: string;
}

function forwardedBrowserOrigin(request: Request, targetOrigin: string): string | undefined {
    const sourceUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    return origin === sourceUrl.origin ? targetOrigin : origin || undefined;
}

function addForwardedClientHeaders(
    headers: Headers,
    clientAddress: string | undefined,
    protocol: string
): void {
    if (clientAddress) {
        headers.set("x-forwarded-for", clientAddress);
        headers.set("x-real-ip", clientAddress);
    }
    headers.set("x-forwarded-proto", protocol);
}

async function proxyApi(
    request: Request,
    server: Server<WebSocketProxyData>
): Promise<Response> {
    const sourceUrl = new URL(request.url);
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, apiTarget);
    const headers = new Headers(request.headers);
    headers.set("host", targetUrl.host);
    const clientAddress = server.requestIP(request)?.address;
    addForwardedClientHeaders(
        headers,
        clientAddress,
        sourceUrl.protocol.slice(0, -1)
    );
    const forwardedOrigin = forwardedBrowserOrigin(request, targetUrl.origin);
    if (forwardedOrigin) {
        headers.set("origin", forwardedOrigin);
    }

    return fetch(targetUrl, {
        body: request.body,
        duplex: "half",
        headers,
        method: request.method,
        redirect: "manual",
    });
}

function upgradeWebSocket(
    request: Request,
    server: Server<WebSocketProxyData>
): Response {
    const sourceUrl = new URL(request.url);
    if (
        server.upgrade(request, {
            data: {
                clientAddress: server.requestIP(request)?.address,
                cookie: request.headers.get("cookie") || undefined,
                origin: forwardedBrowserOrigin(request, new URL(apiTarget).origin),
                pendingMessages: [],
                protocol: sourceUrl.protocol.slice(0, -1),
            },
        })
    ) {
        return new Response(undefined, { status: 204 });
    }

    return new Response("WebSocket upgrade failed", { status: 400 });
}

const server = Bun.serve<WebSocketProxyData>({
    development: {
        console: true,
        hmr: true,
    },
    fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/ws") {
            return upgradeWebSocket(request, server);
        }

        if (url.pathname.startsWith("/api")) {
            return proxyApi(request, server);
        }

        return new Response("Not found", { status: 404 });
    },
    hostname: host,
    port,
    routes: {
        "/api/*": proxyApi,
        "/ws": upgradeWebSocket,
        "/*": dashboard,
    },
    websocket: {
        close(socket) {
            socket.data.backend?.close();
        },
        message(socket, message) {
            const backend = socket.data.backend;
            if (backend?.readyState === WebSocket.OPEN) {
                backend.send(message);
                return;
            }
            socket.data.pendingMessages.push(message);
        },
        open(socket) {
            const headers = new Headers();
            if (socket.data.cookie) {
                headers.set("cookie", socket.data.cookie);
            }
            if (socket.data.origin) {
                headers.set("origin", socket.data.origin);
            }
            addForwardedClientHeaders(
                headers,
                socket.data.clientAddress,
                socket.data.protocol
            );
            const backend = new WebSocket(`${backendWebSocketTarget}/ws`, {
                headers: Object.fromEntries(headers),
            });
            socket.data.backend = backend;

            backend.addEventListener("open", () => {
                for (const message of socket.data.pendingMessages) {
                    backend.send(message);
                }
                socket.data.pendingMessages = [];
            });
            backend.addEventListener("message", (event) => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(event.data);
                }
            });
            backend.addEventListener("close", () => {
                socket.close();
            });
            backend.addEventListener("error", () => {
                socket.close();
            });
        },
    },
});

console.log(`Bun dev server listening on ${server.url}`);
