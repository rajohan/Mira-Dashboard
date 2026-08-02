import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Server, ServerWebSocket } from "bun";

import {
    type DashboardSocketRequest,
    readDashboardSocketRequest,
} from "../../../contracts/socket.ts";
import {
    hasRecentMfaVerification,
    validateAuthenticationConfig,
} from "../auth/sessionPolicy.ts";
import { getAuthSessionFromSessionId } from "../auth/sessionRepository.ts";
import { validateStoredSecretConfig } from "../auth/userRepository.ts";
import { validateAutomationCredentials } from "../http/automationAuth.ts";
import { isAllowedDashboardOrigin, sessionIdFromCookie } from "../http/core.ts";
import { withRequestSecurity } from "../http/requestSecurity.ts";
import { routeFailureResponse } from "../http/routeSupport.ts";
import { staticFileResponse } from "../http/staticFileResponse.ts";
import { resolveDashboardHost, resolveDashboardPort } from "../lib/values.ts";
import {
    isDevelopmentGatewayMethodBlocked,
    requiresRecentMfaForGatewayMethod,
} from "../requestPolicy/evaluator.ts";
import { routes } from "../routes/registry.ts";
import { isProductionDeploymentCutoverActive } from "../services/deploymentCutoverState.ts";
import { type DashboardSocket } from "../services/gateway/dashboardSocket.ts";
import gateway from "../services/gateway/runtime.ts";
import { validateTotpStorageConfig } from "../services/multiFactorAuth/totpFactorService.ts";
import { validateWebAuthnConfig } from "../services/webAuthn/service.ts";
import { resolveFrontendPath } from "./frontendAssets.ts";

interface DashboardSocketData {
    closeHandlers: Array<() => void>;
    errorHandlers: Array<(error: unknown) => void>;
    messageHandlers: Array<(data: string | Buffer) => void>;
    sessionToken: string;
    socket?: DashboardSocket;
    userId: number;
}

const SERVER_IDLE_TIMEOUT_SECONDS = 240;
const DEPLOYMENT_CUTOVER_SOCKET_CLOSE_CODE = 1012;
const DEPLOYMENT_CUTOVER_SOCKET_CLOSE_REASON = "Dashboard release cutover in progress";
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_ASSET_CACHE_CONTROL = "no-cache";
const HASHED_ASSET_NAME = /-[\da-z]{8}\.[\da-z]+$/iu;

function dashboardSocketRequest(
    data: string | Buffer
): DashboardSocketRequest | undefined {
    try {
        return readDashboardSocketRequest(JSON.parse(data.toString()));
    } catch {
        return undefined;
    }
}

function didCloseSocketForDeploymentCutover(
    ws: ServerWebSocket<DashboardSocketData>
): boolean {
    if (!isProductionDeploymentCutoverActive()) return false;
    ws.close(
        DEPLOYMENT_CUTOVER_SOCKET_CLOSE_CODE,
        DEPLOYMENT_CUTOVER_SOCKET_CLOSE_REASON
    );
    return true;
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

function sendSocketDevelopmentError(
    ws: ServerWebSocket<DashboardSocketData>,
    request: DashboardSocketRequest
): void {
    ws.send(
        JSON.stringify({
            code: "development_method_blocked",
            error: "This Gateway action is disabled in Dashboard dev",
            id: request.id,
            isOk: false,
            type: "response",
        })
    );
}

function hasHiddenStaticSegment(relativePath: string): boolean {
    return relativePath.split(path.sep).some((segment) => segment.startsWith("."));
}

export {
    resolveDashboardHost as resolveListenHost,
    resolveDashboardPort as resolveListenPort,
} from "../lib/values.ts";

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

export function createServer(
    port = resolveDashboardPort(),
    hostname = resolveDashboardHost()
): Server<DashboardSocketData> {
    validateAuthenticationConfig();
    validateStoredSecretConfig();
    validateAutomationCredentials();
    validateTotpStorageConfig();
    validateWebAuthnConfig();
    resolveFrontendPath();
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
            if (didCloseSocketForDeploymentCutover(ws)) return;
            if (
                typeof ws.data.sessionToken !== "string" ||
                !Number.isSafeInteger(ws.data.userId)
            ) {
                ws.close(4401, "Dashboard session is no longer valid");
                return;
            }
            const data = typeof message === "string" ? message : Buffer.from(message);
            const socketRequest = dashboardSocketRequest(data);
            if (!socketRequest) {
                ws.close(1008, "Invalid Dashboard request");
                return;
            }
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
                isDevelopmentGatewayMethodBlocked(socketRequest.method)
            ) {
                sendSocketDevelopmentError(ws, socketRequest);
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
            if (didCloseSocketForDeploymentCutover(ws)) return;
            const socket = dashboardSocketFromBun(ws);
            ws.data.socket = socket;
            gateway.handleDashboardClient(socket);
        },
    };

    return Bun.serve<DashboardSocketData>({
        hostname,
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
                if (isProductionDeploymentCutoverActive()) {
                    return withRequestSecurity(
                        request,
                        new Response(
                            "Dashboard writes are paused while the release is verified",
                            {
                                headers: { "Retry-After": "5" },
                                status: 503,
                            }
                        ),
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
                await staticResponse(request, url.pathname),
                server
            );
        },
        websocket,
    });
}

function cacheControlForStaticFile(frontendRoot: string, filePath: string): string {
    const relativePath = path.relative(frontendRoot, filePath);
    const isHashedAsset =
        relativePath.startsWith(`assets${path.sep}`) &&
        HASHED_ASSET_NAME.test(path.basename(relativePath));
    return isHashedAsset
        ? IMMUTABLE_ASSET_CACHE_CONTROL
        : REVALIDATED_ASSET_CACHE_CONTROL;
}

async function fileResponse(
    request: Request,
    frontendRoot: string,
    filePath: string,
    contentType?: string
): Promise<Response> {
    return staticFileResponse(request, filePath, {
        cacheControl: cacheControlForStaticFile(frontendRoot, filePath),
        contentType,
    });
}

async function staticResponse(request: Request, pathname: string): Promise<Response> {
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
        return routeFailureResponse(
            { context: "static-routing", message: "Not found", status: 404 },
            request
        );
    }
    if (decodedPathname === "/health") {
        return new Response("Not found", { status: 404 });
    }
    if (/\.(?:br|gz)$/iu.test(decodedPathname)) {
        return new Response("Not found", { status: 404 });
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
                if (stat.isFile()) {
                    return fileResponse(request, realRoot, realDirectPath);
                }
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
            if (stat.isFile()) {
                return fileResponse(request, realRoot, realAssetPath);
            }
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
        if (stat.isFile()) {
            return fileResponse(request, realRoot, realIndexPath, "text/html");
        }
    } catch {
        // Fall through to a generic not-found response.
    }
    return new Response("Not found", { status: 404 });
}
