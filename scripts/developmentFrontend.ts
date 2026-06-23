import dashboard from "../index.html";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "5173");
const apiTarget = process.env.DASHBOARD_API_TARGET || "http://localhost:3100";
const backendWebSocketTarget = apiTarget.replace(/^http/u, "ws");

interface WebSocketProxyData {
    backend?: WebSocket;
    cookie?: string;
    pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
}

async function proxyApi(request: Request): Promise<Response> {
    const sourceUrl = new URL(request.url);
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, apiTarget);
    const headers = new Headers(request.headers);
    headers.set("host", targetUrl.host);

    return fetch(targetUrl, {
        body: request.body,
        duplex: "half",
        headers,
        method: request.method,
        redirect: "manual",
    });
}

function upgradeWebSocket(request: Request): Response {
    if (
        server.upgrade(request, {
            data: {
                cookie: request.headers.get("cookie") || undefined,
                pendingMessages: [],
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
    fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/ws") {
            return upgradeWebSocket(request);
        }

        if (url.pathname.startsWith("/api")) {
            return proxyApi(request);
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
            const headers: Record<string, string> = {};
            if (socket.data.cookie) {
                headers.cookie = socket.data.cookie;
            }
            const backend = new WebSocket(`${backendWebSocketTarget}/ws`, {
                headers,
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
