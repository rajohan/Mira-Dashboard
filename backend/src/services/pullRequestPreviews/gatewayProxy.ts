import { randomBytes } from "node:crypto";

import type { Server } from "bun";

import {
    isDevelopmentGatewayProxyEventAllowed,
    isDevelopmentGatewayProxyMethodAllowed,
} from "../../development/developmentGatewayPolicy.ts";
import {
    OpenClawGatewayClient,
    type OpenClawGatewayClientOptions,
} from "../../lib/openclawGatewayClient/client.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { redactConfigSecrets } from "../configRedaction.ts";
import {
    areGatewayTokensEqual,
    loadPrivatePreviewDeviceIdentity,
    normalizedGatewayToken,
    pullRequestPreviewGatewayProxyOptionsFromEnvironment,
} from "./gatewayProxyConfig.ts";
import type {
    PreviewGatewayRequest,
    PreviewGatewaySocket,
    PreviewGatewaySocketData,
    PullRequestPreviewGatewayProxy,
    PullRequestPreviewGatewayProxyOptions,
} from "./gatewayProxyTypes.ts";

const logger = createStructuredLogger("preview-gateway-proxy");

const AUTHENTICATION_TIMEOUT_MS = 10_000;
export const MAX_CLIENT_PENDING_REQUESTS = 128;
const MAX_GATEWAY_FRAME_BYTES = 1024 * 1024;
const PROXY_PATH = "/gateway";

function previewGatewayResponse(method: string, payload: unknown): unknown {
    return method === "config.get" ? redactConfigSecrets(payload) : payload;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
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

function sendFrame(socket: PreviewGatewaySocket, frame: unknown): void {
    try {
        socket.send(JSON.stringify(frame));
    } catch {
        // The peer has already disconnected.
    }
}

function sendError(socket: PreviewGatewaySocket, id: string, message: string): void {
    sendFrame(socket, {
        error: { code: "PREVIEW_GATEWAY_DENIED", message },
        id,
        isOk: false,
        type: "res",
    });
}

function terminateSocket(socket: PreviewGatewaySocket): void {
    if (socket.data.authenticationTimer) {
        clearTimeout(socket.data.authenticationTimer);
        socket.data.authenticationTimer = undefined;
    }
    socket.terminate();
}

function isClientAuthenticated(
    socket: PreviewGatewaySocket,
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
    if (!areGatewayTokensEqual(clientToken, suppliedToken)) {
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

/**
 * Starts the loopback-only capability proxy used by one managed PR dev slot.
 * @returns Start pull request preview gateway proxy result.
 */
export function startPullRequestPreviewGatewayProxy(
    options: PullRequestPreviewGatewayProxyOptions
): PullRequestPreviewGatewayProxy {
    const clientToken = normalizedGatewayToken(
        options.clientToken,
        "Preview client token"
    );
    const upstreamToken = normalizedGatewayToken(
        options.upstreamToken,
        "Preview upstream Gateway token"
    );
    if (areGatewayTokensEqual(clientToken, upstreamToken)) {
        throw new TypeError("Preview client and upstream Gateway tokens must differ");
    }

    const clients = new Set<PreviewGatewaySocket>();
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
        deviceIdentity: loadPrivatePreviewDeviceIdentity(options.deviceIdentityFile),
        mode: "backend",
        onClose() {
            isUpstreamConnected = false;
            if (!isStopping) closeClients("Upstream Gateway disconnected");
        },
        onConnectError(error) {
            if (!isStopping) {
                logger.error("preview_gateway.upstream_connection_failed", { error });
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
        void server.stop(true).catch((stopError) => {
            logger.error("preview_gateway.server_shutdown_failed", {
                error: stopError,
            });
        });
        throw error;
    }

    return {
        isUpstreamConnected: () => isUpstreamConnected,
        port: server.port ?? options.port,
        async stop() {
            isStopping = true;
            upstreamClient.stop();
            closeClients("Gateway proxy stopped");
            await server.stop(true);
        },
    };
}

export async function runPullRequestPreviewGatewayProxyEntrypoint(): Promise<void> {
    try {
        const proxy = startPullRequestPreviewGatewayProxy(
            pullRequestPreviewGatewayProxyOptionsFromEnvironment()
        );
        const shutdown = Promise.withResolvers<NodeJS.Signals>();
        const stop = (signal: NodeJS.Signals) => shutdown.resolve(signal);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await shutdown.promise;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await proxy.stop();
    } catch (error) {
        logger.error("preview_gateway.entrypoint_failed", { error });
        process.exitCode = 1;
    }
}
