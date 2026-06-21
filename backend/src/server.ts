import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Server, ServerWebSocket } from "bun";

import type { DashboardSocket } from "./dashboardSocket.ts";
import gateway from "./gateway.ts";
import { authUser } from "./http.ts";
import { routes } from "./routes.ts";

interface DashboardSocketData {
    closeHandlers: Array<() => void>;
    errorHandlers: Array<(error: unknown) => void>;
    messageHandlers: Array<(data: string | Buffer) => void>;
    socket?: DashboardSocket;
    userId: number;
}

const frontendPath =
    process.env.MIRA_DASHBOARD_FRONTEND_PATH ||
    path.join(import.meta.dirname, "..", "..", "dist");
const configuredDashboardOrigins = new Set(
    (process.env.MIRA_DASHBOARD_ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
);
const allowedLoopbackHostnames = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
]);
const SERVER_IDLE_TIMEOUT_SECONDS = 240;

function isAllowedWebSocketOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    try {
        const parsedOrigin = new URL(origin);
        const requestUrl = new URL(request.url);
        return (
            configuredDashboardOrigins.has(parsedOrigin.origin) ||
            (allowedLoopbackHostnames.has(parsedOrigin.hostname) &&
                allowedLoopbackHostnames.has(requestUrl.hostname))
        );
    } catch {
        return false;
    }
}

export function resolveListenPort(value = process.env.PORT): number {
    const trimmed = value?.trim() ?? "";
    if (!/^\d+$/u.test(trimmed)) {
        return 3100;
    }
    const port = Number(trimmed);
    return port > 0 && port <= 65_535 ? port : 3100;
}

function dashboardSocketFromBun(
    ws: ServerWebSocket<DashboardSocketData>
): DashboardSocket {
    return {
        close: (code?: number, reason?: string) => ws.close(code, reason),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        onClose: (handler) => {
            ws.data.closeHandlers.push(handler);
        },
        onError: (handler) => {
            ws.data.errorHandlers.push(handler);
        },
        onMessage: (handler) => {
            ws.data.messageHandlers.push(handler);
        },
        send: (data) => {
            ws.send(data);
        },
    };
}

export function createServer(port = resolveListenPort()): Server<DashboardSocketData> {
    return Bun.serve<DashboardSocketData>({
        idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
        port,
        routes,
        fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === "/ws") {
                if (!isAllowedWebSocketOrigin(request)) {
                    return new Response("Forbidden", { status: 403 });
                }
                const user = authUser(request, server);
                if (!user) {
                    return new Response("Unauthorized", { status: 401 });
                }
                const isUpgraded = server.upgrade(request, {
                    data: {
                        closeHandlers: [],
                        errorHandlers: [],
                        messageHandlers: [],
                        userId: user.id,
                    },
                });
                return isUpgraded
                    ? undefined
                    : new Response("WebSocket upgrade failed", { status: 400 });
            }
            return staticResponse(url.pathname);
        },
        websocket: {
            close(ws: ServerWebSocket<DashboardSocketData>) {
                for (const handler of ws.data.closeHandlers) {
                    handler();
                }
            },
            message(ws: ServerWebSocket<DashboardSocketData>, message: string | Buffer) {
                const data = typeof message === "string" ? message : Buffer.from(message);
                for (const handler of ws.data.messageHandlers) {
                    handler(data);
                }
            },
            open(ws: ServerWebSocket<DashboardSocketData>) {
                const socket = dashboardSocketFromBun(ws);
                ws.data.socket = socket;
                gateway.handleDashboardClient(socket);
            },
        },
    });
}

async function fileResponse(filePath: string, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (contentType) headers["Content-Type"] = contentType;
    return new Response(Bun.file(filePath), { headers });
}

async function staticResponse(pathname: string): Promise<Response> {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    const indexPath = path.join(frontendPath, "index.html");
    if (!fs.existsSync(indexPath)) {
        return new Response(
            `
                <html>
                <head><title>Mira Dashboard - Not Built</title></head>
                <body style="font-family: system-ui; padding: 2rem; background: #1a1a2e; color: #eee;">
                    <h1>Frontend Not Built</h1>
                    <p>Run <code style="background: #333; padding: 2px 6px; border-radius: 4px;">bun run build</code> in the frontend directory.</p>
                    <p style="color: #888; margin-top: 2rem;">
                        Backend API is available at <code style="background: #333; padding: 2px 6px;">/api/*</code>
                    </p>
                </body>
                </html>
            `,
            { headers: { "Content-Type": "text/html" }, status: 503 }
        );
    }

    const root = path.resolve(frontendPath);
    let realRoot: string;
    try {
        realRoot = await fsp.realpath(root);
    } catch {
        return new Response("Not found", { status: 404 });
    }
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(pathname.replace(/^\/+/u, ""));
    } catch {
        return new Response("Bad Request", { status: 400 });
    }
    const directPath = path.resolve(root, decodedPath);
    if (directPath.startsWith(`${root}${path.sep}`)) {
        try {
            const realDirectPath = await fsp.realpath(directPath);
            const relativeRealPath = path.relative(realRoot, realDirectPath);
            if (
                !relativeRealPath.startsWith("..") &&
                !path.isAbsolute(relativeRealPath)
            ) {
                const stat = await fsp.stat(realDirectPath);
                if (stat.isFile()) return fileResponse(realDirectPath);
            }
        } catch {
            // Continue with hashed asset lookup or SPA routing below.
        }
    }

    if (/\.[\da-z]+$/iu.test(pathname)) {
        if (pathname.includes("/") && pathname !== `/${path.basename(pathname)}`) {
            return new Response("Not found", { status: 404 });
        }
        const assetPath = path.join(root, "assets", path.basename(pathname));
        try {
            const realAssetPath = await fsp.realpath(assetPath);
            const relativeRealPath = path.relative(realRoot, realAssetPath);
            if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
                return new Response("Not found", { status: 404 });
            }
            const stat = await fsp.stat(realAssetPath);
            if (stat.isFile()) return fileResponse(realAssetPath);
        } catch {
            return new Response("Not found", { status: 404 });
        }
    }

    if (pathname.startsWith("/assets/") || path.extname(pathname)) {
        return new Response("Not found", { status: 404 });
    }
    try {
        const realIndexPath = await fsp.realpath(indexPath);
        const relativeRealPath = path.relative(realRoot, realIndexPath);
        if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
            return new Response("Not found", { status: 404 });
        }
        const stat = await fsp.stat(realIndexPath);
        if (stat.isFile()) return fileResponse(realIndexPath, "text/html");
    } catch {
        // Fall through to a generic not-found response.
    }
    return new Response("Not found", { status: 404 });
}
