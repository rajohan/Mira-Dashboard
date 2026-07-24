import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Server, ServerWebSocket } from "bun";

import {
    getAuthSessionFromSessionId,
    hasRecentMfaVerification,
    validateAuthenticationConfig,
    validateStoredSecretConfig,
} from "./auth.ts";
import { validateAutomationCredentials } from "./automationAuth.ts";
import type { DashboardSocket } from "./dashboardSocket.ts";
import gateway from "./gateway.ts";
import { isAllowedDashboardOrigin, sessionIdFromCookie } from "./http.ts";
import { requiresRecentMfaForGatewayMethod } from "./requestPolicy.ts";
import { withRequestSecurity } from "./requestSecurity.ts";
import { routes } from "./routes.ts";
import { validateTotpStorageConfig } from "./services/multiFactorAuth.ts";
import { validateWebAuthnConfig } from "./services/webAuthn.ts";

interface DashboardSocketData {
    closeHandlers: Array<() => void>;
    errorHandlers: Array<(error: unknown) => void>;
    messageHandlers: Array<(data: string | Buffer) => void>;
    sessionToken: string;
    socket?: DashboardSocket;
    userId: number;
}

interface DashboardSocketRequest {
    id?: string;
    method?: string;
    type?: string;
    userActivity?: boolean;
}

const SERVER_IDLE_TIMEOUT_SECONDS = 240;

function dashboardSocketRequest(data: string | Buffer): DashboardSocketRequest {
    try {
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        return {
            ...(typeof value.id === "string" && { id: value.id }),
            ...(typeof value.method === "string" && { method: value.method }),
            ...(typeof value.type === "string" && { type: value.type }),
            ...(value.userActivity === true && { userActivity: true }),
        };
    } catch {
        return {};
    }
}

function sendSocketAuthenticationError(
    ws: ServerWebSocket<DashboardSocketData>,
    request: DashboardSocketRequest,
    code: "mfa_enrollment_required" | "step_up_required"
): void {
    ws.send(
        JSON.stringify({
            code,
            error:
                code === "step_up_required"
                    ? "Recent MFA verification is required"
                    : "Multi-factor authentication must be enabled",
            id: request.id,
            isOk: false,
            type: "response",
        })
    );
}

function hasHiddenStaticSegment(relativePath: string): boolean {
    return relativePath.split(path.sep).some((segment) => segment.startsWith("."));
}

function resolveFrontendPath(): string {
    return (
        process.env.MIRA_DASHBOARD_FRONTEND_PATH ||
        path.join(import.meta.dirname, "..", "..", "dist")
    );
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
    validateAuthenticationConfig();
    validateStoredSecretConfig();
    validateAutomationCredentials();
    validateTotpStorageConfig();
    validateWebAuthnConfig();
    const websocket = {
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
            if (
                typeof ws.data.sessionToken !== "string" ||
                !Number.isSafeInteger(ws.data.userId)
            ) {
                ws.close(4401, "Dashboard session is no longer valid");
                return;
            }
            const data = typeof message === "string" ? message : Buffer.from(message);
            const socketRequest = dashboardSocketRequest(data);
            const session = getAuthSessionFromSessionId(ws.data.sessionToken, {
                touchActivity: socketRequest.userActivity === true,
            });
            if (!session || session.id !== ws.data.userId) {
                ws.close(4401, "Dashboard session is no longer valid");
                return;
            }
            if (
                (socketRequest.type === "request" || socketRequest.type === "req") &&
                socketRequest.method &&
                requiresRecentMfaForGatewayMethod(socketRequest.method) &&
                (!session.mfaEnabled || !hasRecentMfaVerification(session))
            ) {
                sendSocketAuthenticationError(
                    ws,
                    socketRequest,
                    session.mfaEnabled ? "step_up_required" : "mfa_enrollment_required"
                );
                return;
            }
            for (const handler of ws.data.messageHandlers) {
                handler(data);
            }
        },
        open(ws: ServerWebSocket<DashboardSocketData>) {
            const socket = dashboardSocketFromBun(ws);
            ws.data.socket = socket;
            gateway.handleDashboardClient(socket);
        },
    };

    return Bun.serve<DashboardSocketData>({
        idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
        port,
        routes,
        async fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === "/ws") {
                if (!isAllowedDashboardOrigin(request)) {
                    return withRequestSecurity(
                        request,
                        new Response("Forbidden", { status: 403 }),
                        server
                    );
                }
                const sessionToken = sessionIdFromCookie(request);
                const session = sessionToken
                    ? getAuthSessionFromSessionId(sessionToken)
                    : undefined;
                if (!sessionToken || !session) {
                    return withRequestSecurity(
                        request,
                        new Response("Unauthorized", { status: 401 }),
                        server
                    );
                }
                const isUpgraded = server.upgrade(request, {
                    data: {
                        closeHandlers: [],
                        errorHandlers: [],
                        messageHandlers: [],
                        sessionToken,
                        userId: session.id,
                    },
                });
                return isUpgraded
                    ? undefined
                    : withRequestSecurity(
                          request,
                          new Response("WebSocket upgrade failed", { status: 400 }),
                          server
                      );
            }
            return withRequestSecurity(
                request,
                await staticResponse(url.pathname),
                server
            );
        },
        websocket,
    });
}

async function fileResponse(filePath: string, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (contentType) headers["Content-Type"] = contentType;
    return new Response(Bun.file(filePath), { headers });
}

async function staticResponse(pathname: string): Promise<Response> {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(pathname.replace(/^\/+/u, "")).replace(
            /^\/+/u,
            ""
        );
    } catch {
        return new Response("Bad Request", { status: 400 });
    }
    const decodedPathname = `/${decodedPath}`;
    if (decodedPathname === "/api" || decodedPathname.startsWith("/api/")) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }

    const frontendPath = resolveFrontendPath();
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
    const directPath = path.resolve(root, decodedPath);
    if (directPath.startsWith(`${root}${path.sep}`)) {
        try {
            const realDirectPath = await fsp.realpath(directPath);
            const relativeRealPath = path.relative(realRoot, realDirectPath);
            if (
                !relativeRealPath.startsWith("..") &&
                !path.isAbsolute(relativeRealPath) &&
                !hasHiddenStaticSegment(relativeRealPath)
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
            if (hasHiddenStaticSegment(relativeRealPath)) {
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
        if (
            relativeRealPath.startsWith("..") ||
            path.isAbsolute(relativeRealPath) ||
            hasHiddenStaticSegment(relativeRealPath)
        ) {
            return new Response("Not found", { status: 404 });
        }
        const stat = await fsp.stat(realIndexPath);
        if (stat.isFile()) return fileResponse(realIndexPath, "text/html");
    } catch {
        // Fall through to a generic not-found response.
    }
    return new Response("Not found", { status: 404 });
}
