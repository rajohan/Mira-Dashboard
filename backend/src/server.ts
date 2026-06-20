import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

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

export function resolveListenPort(value = process.env.PORT): number {
    const trimmed = value?.trim() ?? "";
    if (!/^\d+$/u.test(trimmed)) {
        return 3100;
    }
    const port = Number(trimmed);
    return port <= 65_535 ? port : 3100;
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
        port,
        routes,
        fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === "/ws") {
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
            error(ws: ServerWebSocket<DashboardSocketData>, error: unknown) {
                for (const handler of ws.data.errorHandlers) {
                    handler(error);
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
        } as unknown as WebSocketHandler<DashboardSocketData>,
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
    const directPath = path.resolve(
        root,
        decodeURIComponent(pathname.replace(/^\/+/u, ""))
    );
    if (directPath.startsWith(`${root}${path.sep}`)) {
        try {
            const stat = await fsp.stat(directPath);
            if (stat.isFile()) return fileResponse(directPath);
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
            const stat = await fsp.stat(assetPath);
            if (stat.isFile()) return fileResponse(assetPath);
        } catch {
            return new Response("Not found", { status: 404 });
        }
    }

    if (pathname.startsWith("/assets/") || path.extname(pathname)) {
        return new Response("Not found", { status: 404 });
    }
    return fileResponse(indexPath, "text/html");
}
