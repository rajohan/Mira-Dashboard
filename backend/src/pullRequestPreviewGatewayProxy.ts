import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
} from "node:fs";
import path from "node:path";

import type { Server, ServerWebSocket } from "bun";

import {
    isDevelopmentGatewayProxyEventAllowed,
    isDevelopmentGatewayProxyMethodAllowed,
} from "./development/developmentGatewayPolicy.ts";
import {
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
} from "./lib/openclawGatewayClient.ts";
import { redactConfigSecrets } from "./services/configRedaction.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
export const MAX_CLIENT_PENDING_REQUESTS = 128;
const MAX_GATEWAY_FRAME_BYTES = 1024 * 1024;
const MAX_GATEWAY_TOKEN_BYTES = 16 * 1024;
const PROXY_PATH = "/gateway";

interface PreviewGatewaySocketData {
    authenticated: boolean;
    authenticationTimer?: NodeJS.Timeout;
    challengeNonce: string;
    pendingRequests: number;
}

interface PreviewGatewayRequest {
    id: string;
    method: string;
    parameters: Record<string, unknown>;
}

export interface PullRequestPreviewGatewayProxyOptions {
    clientToken: string;
    deviceIdentityFile: string;
    port: number;
    serverFactory?: (
        options: Bun.Serve.Options<PreviewGatewaySocketData>
    ) => Server<PreviewGatewaySocketData>;
    upstreamClientFactory?: (
        options: OpenClawGatewayClientOptions
    ) => OpenClawGatewayClientInstance;
    upstreamToken: string;
    upstreamUrl: string;
}

export interface PullRequestPreviewGatewayProxy {
    isUpstreamConnected: () => boolean;
    port: number;
    stop: () => Promise<void>;
}

function previewGatewayResponse(method: string, payload: unknown): unknown {
    return method === "config.get" ? redactConfigSecrets(payload) : payload;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function normalizedToken(value: string, label: string): string {
    const token = value.trim();
    if (
        !token ||
        Buffer.byteLength(token) > MAX_GATEWAY_TOKEN_BYTES ||
        /[\r\n\0]/u.test(token)
    ) {
        throw new TypeError(`${label} must be a valid single-line token`);
    }
    return token;
}

function areTokensEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
        leftBuffer.length === rightBuffer.length &&
        timingSafeEqual(leftBuffer, rightBuffer)
    );
}

function configuredPort(value: string | undefined): number {
    if (!value || !/^\d+$/u.test(value)) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT must be an integer"
        );
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT must be between 1 and 65535"
        );
    }
    return port;
}

function configuredUpstreamUrl(value: string | undefined): string {
    if (!value?.trim()) {
        throw new TypeError("MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL is required");
    }
    const url = new URL(value);
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL must be ws:// or wss:// without credentials or a fragment"
        );
    }
    return url.href;
}

function absoluteFilePath(name: string, value: string | undefined): string {
    if (!value?.trim() || !path.isAbsolute(value)) {
        throw new TypeError(`${name} must be an absolute path`);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must not be the filesystem root`);
    }
    return resolved;
}

function readSecretFile(filePath: string, label: string): string {
    const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(descriptor);
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > MAX_GATEWAY_TOKEN_BYTES ||
            (stat.mode & 0o077) !== 0
        ) {
            throw new Error(`${label} must be a private single-link regular file`);
        }
        return normalizedToken(readFileSync(descriptor, "utf8"), label);
    } finally {
        closeSync(descriptor);
    }
}

function loadPrivateDeviceIdentity(filePath: string) {
    const directory = path.dirname(filePath);
    const directoryStat = lstatSync(directory);
    if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (directoryStat.mode & 0o077) !== 0
    ) {
        throw new Error(
            "Preview Gateway proxy identity directory must be a private real directory"
        );
    }
    if (existsSync(filePath)) {
        const fileStat = lstatSync(filePath);
        if (
            !fileStat.isFile() ||
            fileStat.isSymbolicLink() ||
            fileStat.nlink !== 1 ||
            (fileStat.mode & 0o077) !== 0
        ) {
            throw new Error(
                "Preview Gateway proxy identity must be a private single-link regular file"
            );
        }
    }
    const identity = loadOrCreateDeviceIdentity(filePath);
    const createdStat = lstatSync(filePath);
    if (
        !createdStat.isFile() ||
        createdStat.isSymbolicLink() ||
        createdStat.nlink !== 1 ||
        (createdStat.mode & 0o077) !== 0
    ) {
        throw new Error(
            "Preview Gateway proxy identity must be a private single-link regular file"
        );
    }
    return identity;
}

function requestFromFrame(value: unknown): PreviewGatewayRequest | undefined {
    const frame = asRecord(value);
    if (
        !frame ||
        (frame.type !== "req" && frame.type !== "request") ||
        typeof frame.id !== "string" ||
        !frame.id ||
        typeof frame.method !== "string" ||
        !frame.method
    ) {
        return undefined;
    }
    return {
        id: frame.id,
        method: frame.method,
        parameters: asRecord(frame.params) || {},
    };
}

function websocketMessageText(message: string | Buffer): string {
    return typeof message === "string" ? message : message.toString("utf8");
}

function sendFrame(
    socket: ServerWebSocket<PreviewGatewaySocketData>,
    frame: unknown
): void {
    try {
        socket.send(JSON.stringify(frame));
    } catch {
        // The peer has already disconnected.
    }
}

function sendError(
    socket: ServerWebSocket<PreviewGatewaySocketData>,
    id: string,
    message: string
): void {
    sendFrame(socket, {
        error: { code: "PREVIEW_GATEWAY_DENIED", message },
        id,
        isOk: false,
        type: "res",
    });
}

function terminateSocket(socket: ServerWebSocket<PreviewGatewaySocketData>): void {
    if (socket.data.authenticationTimer) {
        clearTimeout(socket.data.authenticationTimer);
        socket.data.authenticationTimer = undefined;
    }
    socket.terminate();
}

function isClientAuthenticated(
    socket: ServerWebSocket<PreviewGatewaySocketData>,
    request: PreviewGatewayRequest,
    clientToken: string,
    isUpstreamConnected: boolean
): boolean {
    if (request.method !== "connect") {
        sendError(socket, request.id, "Gateway proxy authentication is required");
        return false;
    }
    const auth = asRecord(request.parameters.auth);
    const suppliedToken = typeof auth?.token === "string" ? auth.token : "";
    if (!areTokensEqual(clientToken, suppliedToken)) {
        sendError(socket, request.id, "Gateway proxy authentication failed");
        return false;
    }
    if (!isUpstreamConnected) {
        sendError(socket, request.id, "Production Gateway is unavailable");
        return false;
    }
    socket.data.authenticated = true;
    if (socket.data.authenticationTimer) {
        clearTimeout(socket.data.authenticationTimer);
        socket.data.authenticationTimer = undefined;
    }
    sendFrame(socket, {
        id: request.id,
        isOk: true,
        payload: {
            policy: { tickIntervalMs: 30_000 },
            protocol: 3,
            type: "hello-ok",
        },
        type: "res",
    });
    return true;
}

/** Starts the loopback-only capability proxy used by one managed PR dev slot. */
export function startPullRequestPreviewGatewayProxy(
    options: PullRequestPreviewGatewayProxyOptions
): PullRequestPreviewGatewayProxy {
    const clientToken = normalizedToken(options.clientToken, "Preview client token");
    const upstreamToken = normalizedToken(
        options.upstreamToken,
        "Preview upstream Gateway token"
    );
    if (areTokensEqual(clientToken, upstreamToken)) {
        throw new TypeError("Preview client and upstream Gateway tokens must differ");
    }

    const clients = new Set<ServerWebSocket<PreviewGatewaySocketData>>();
    let isStopping = false;
    let isUpstreamConnected = false;

    const closeClients = (reason: string): void => {
        for (const client of clients) {
            try {
                client.send(
                    JSON.stringify({
                        error: reason,
                        gatewayConnected: false,
                        type: "disconnected",
                    })
                );
                terminateSocket(client);
            } catch {
                // The peer has already disconnected.
            }
        }
        clients.clear();
    };

    const broadcastGatewayEvent = (event: unknown): void => {
        const eventName = asRecord(event)?.event;
        if (
            typeof eventName !== "string" ||
            !isDevelopmentGatewayProxyEventAllowed(eventName)
        ) {
            return;
        }
        for (const client of clients) {
            sendFrame(client, event);
        }
    };

    const upstreamClientFactory =
        options.upstreamClientFactory ||
        ((clientOptions: OpenClawGatewayClientOptions) =>
            new OpenClawGatewayClient(clientOptions));
    const upstreamClient = upstreamClientFactory({
        caps: ["tool-events"],
        clientDisplayName: "Mira Dashboard PR Dev Gateway Proxy",
        clientName: "gateway-client",
        deviceFamily: "server",
        deviceIdentity: loadPrivateDeviceIdentity(options.deviceIdentityFile),
        mode: "backend",
        onClose() {
            isUpstreamConnected = false;
            if (!isStopping) closeClients("Upstream Gateway disconnected");
        },
        onConnectError(error) {
            if (!isStopping) {
                console.error(
                    `[PreviewGatewayProxy] Upstream connection failed: ${error.message}`
                );
            }
        },
        onEvent: broadcastGatewayEvent,
        onHelloOk() {
            isUpstreamConnected = true;
        },
        platform: "linux",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        token: upstreamToken,
        url: options.upstreamUrl,
    });

    const serverOptions = {
        fetch(request, bunServer) {
            const url = new URL(request.url);
            if (request.method === "GET" && url.pathname === "/health") {
                return Response.json(
                    { upstreamConnected: isUpstreamConnected },
                    { status: isUpstreamConnected ? 200 : 503 }
                );
            }
            if (url.pathname !== PROXY_PATH) {
                return new Response("Not found", { status: 404 });
            }
            const upgraded = bunServer.upgrade(request, {
                data: {
                    authenticated: false,
                    challengeNonce: randomBytes(24).toString("base64url"),
                    pendingRequests: 0,
                },
            });
            return upgraded
                ? undefined
                : new Response("WebSocket upgrade required", { status: 426 });
        },
        hostname: "127.0.0.1",
        port: options.port,
        websocket: {
            close(socket) {
                if (socket.data.authenticationTimer) {
                    clearTimeout(socket.data.authenticationTimer);
                }
                clients.delete(socket);
            },
            maxPayloadLength: MAX_GATEWAY_FRAME_BYTES,
            async message(socket, message) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(websocketMessageText(message));
                } catch {
                    terminateSocket(socket);
                    return;
                }
                const request = requestFromFrame(parsed);
                if (!request) {
                    terminateSocket(socket);
                    return;
                }
                if (!socket.data.authenticated) {
                    if (
                        !isClientAuthenticated(
                            socket,
                            request,
                            clientToken,
                            isUpstreamConnected
                        )
                    ) {
                        terminateSocket(socket);
                        return;
                    }
                    clients.add(socket);
                    return;
                }
                if (!isDevelopmentGatewayProxyMethodAllowed(request.method)) {
                    sendError(
                        socket,
                        request.id,
                        "Gateway method is unavailable in PR dev"
                    );
                    return;
                }
                if (socket.data.pendingRequests >= MAX_CLIENT_PENDING_REQUESTS) {
                    sendError(socket, request.id, "Too many pending Gateway requests");
                    return;
                }
                socket.data.pendingRequests += 1;
                try {
                    if (!isUpstreamConnected) {
                        throw new Error("Production Gateway is unavailable");
                    }
                    const payload = await upstreamClient.request(
                        request.method,
                        request.parameters
                    );
                    sendFrame(socket, {
                        id: request.id,
                        isOk: true,
                        payload: previewGatewayResponse(request.method, payload),
                        type: "res",
                    });
                } catch (error) {
                    sendError(
                        socket,
                        request.id,
                        error instanceof Error ? error.message : "Gateway request failed"
                    );
                } finally {
                    socket.data.pendingRequests -= 1;
                }
            },
            open(socket) {
                socket.data.authenticationTimer = setTimeout(() => {
                    terminateSocket(socket);
                }, AUTHENTICATION_TIMEOUT_MS);
                sendFrame(socket, {
                    event: "connect.challenge",
                    payload: { nonce: socket.data.challengeNonce },
                    type: "event",
                });
            },
        },
    } satisfies Bun.Serve.Options<PreviewGatewaySocketData>;
    const server: Server<PreviewGatewaySocketData> = options.serverFactory
        ? options.serverFactory(serverOptions)
        : Bun.serve(serverOptions);

    try {
        upstreamClient.start();
    } catch (error) {
        upstreamClient.stop();
        void server.stop(true);
        throw error;
    }

    return {
        isUpstreamConnected: () => isUpstreamConnected,
        port: server.port ?? options.port,
        stop() {
            isStopping = true;
            upstreamClient.stop();
            closeClients("Gateway proxy stopped");
            const stopping = server.stop(true);
            // Bun 1.3.14 on arm64 can leave this promise pending after a
            // WebSocket has closed. The unit owns the process lifetime, so
            // unref the stopped server instead of blocking signal shutdown.
            server.unref();
            void stopping.catch((error) => {
                console.error(
                    `[PreviewGatewayProxy] Server shutdown failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            });
            return Promise.resolve();
        },
    };
}

function optionsFromEnvironment(
    environment: Record<string, string | undefined> = process.env
): PullRequestPreviewGatewayProxyOptions {
    const clientTokenFile = absoluteFilePath(
        "MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE",
        environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE
    );
    const upstreamTokenFile = absoluteFilePath(
        "MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE",
        environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE
    );
    return {
        clientToken: readSecretFile(clientTokenFile, "Preview client token file"),
        deviceIdentityFile: absoluteFilePath(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE",
            environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE
        ),
        port: configuredPort(environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT),
        upstreamToken: readSecretFile(
            upstreamTokenFile,
            "Preview upstream Gateway token file"
        ),
        upstreamUrl: configuredUpstreamUrl(
            environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL
        ),
    };
}

if (import.meta.main) {
    try {
        const proxy = startPullRequestPreviewGatewayProxy(optionsFromEnvironment());
        const shutdown = Promise.withResolvers<NodeJS.Signals>();
        const stop = (signal: NodeJS.Signals) => shutdown.resolve(signal);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await shutdown.promise;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await proxy.stop();
    } catch (error) {
        console.error(
            `[PreviewGatewayProxy] Failed: ${
                error instanceof Error ? error.message : "Unknown error"
            }`
        );
        process.exitCode = 1;
    }
}
