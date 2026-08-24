import {
    gatewayCredentialChallengeMaximumBytes,
    gatewayCredentialMessageMaximumBytes,
} from "../../platform/gateway/gatewayCredentialProtocol.ts";

export type GatewayCredentialFixtureBehavior =
    | "auth-none"
    | "binary-response"
    | "close-before-challenge"
    | "duplicate-challenge"
    | "malformed-response"
    | "normal"
    | "oversized-challenge"
    | "oversized-response"
    | "read-only-scope"
    | "response-before-challenge"
    | "silent"
    | "startup-sidecars"
    | "unknown-event"
    | "wrong-response-id";

export interface GatewayCredentialVerifierFixtureOptions {
    readonly behavior?: GatewayCredentialFixtureBehavior;
    readonly validCredential: string;
}

interface GatewayFixtureSocketData {
    readonly fixture: true;
}

interface ObservedGatewayUpgradeRequest {
    readonly authorization: string | null;
    readonly forwarded: string | null;
    readonly origin: string | null;
    readonly secWebSocketProtocol: string | null;
    readonly url: string;
    readonly xForwardedFor: string | null;
}

function messageText(message: string | Buffer): string {
    return typeof message === "string" ? message : message.toString("utf8");
}

function requestIdentifier(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const id = (value as { readonly id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
}

function requestCredential(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const params = (value as { readonly params?: unknown }).params;
    if (typeof params !== "object" || params === null) return undefined;
    const auth = (params as { readonly auth?: unknown }).auth;
    if (typeof auth !== "object" || auth === null) return undefined;
    const token = (auth as { readonly token?: unknown }).token;
    return typeof token === "string" ? token : undefined;
}

/**
 * Starts a current-v4, loopback-only Gateway handshake fixture.
 * @param options Accepted credential and optional adversarial response behavior.
 * @returns Fixture URL, observations, and bounded shutdown operation.
 */
export function startGatewayCredentialVerifierFixture(
    options: GatewayCredentialVerifierFixtureOptions
) {
    const behavior = options.behavior ?? "normal";
    const observedCredentials: string[] = [];
    const observedUpgradeRequests: ObservedGatewayUpgradeRequest[] = [];
    let acceptedConnections = 0;
    let openConnections = 0;
    const server = Bun.serve<GatewayFixtureSocketData>({
        fetch(request, bunServer) {
            observedUpgradeRequests.push({
                authorization: request.headers.get("authorization"),
                forwarded: request.headers.get("forwarded"),
                origin: request.headers.get("origin"),
                secWebSocketProtocol: request.headers.get("sec-websocket-protocol"),
                url: request.url,
                xForwardedFor: request.headers.get("x-forwarded-for"),
            });
            return bunServer.upgrade(request, { data: { fixture: true } })
                ? undefined
                : new Response("WebSocket upgrade required", { status: 426 });
        },
        hostname: "127.0.0.1",
        port: 0,
        websocket: {
            close() {
                openConnections -= 1;
            },
            message(socket, message) {
                let value: unknown;
                try {
                    value = JSON.parse(messageText(message));
                } catch {
                    socket.close(1008, "invalid fixture request");
                    return;
                }
                const id = requestIdentifier(value);
                const credential = requestCredential(value);
                if (id === undefined || credential === undefined) {
                    socket.close(1008, "invalid fixture request");
                    return;
                }
                observedCredentials.push(credential);

                if (behavior === "malformed-response") {
                    socket.send("{");
                    return;
                }
                if (behavior === "oversized-response") {
                    socket.send("x".repeat(gatewayCredentialMessageMaximumBytes + 1));
                    return;
                }
                if (behavior === "startup-sidecars") {
                    socket.send(
                        JSON.stringify({
                            error: {
                                code: "UNAVAILABLE",
                                details: { reason: "startup-sidecars" },
                                message: "gateway starting; retry shortly",
                                retryable: true,
                                retryAfterMs: 500,
                            },
                            id,
                            ok: false,
                            type: "res",
                        })
                    );
                    queueMicrotask(() => socket.close(1013, "gateway starting"));
                    return;
                }
                if (behavior === "close-before-challenge") return;

                const response =
                    credential === options.validCredential
                        ? {
                              id: behavior === "wrong-response-id" ? "wrong-id" : id,
                              ok: true,
                              payload: {
                                  auth: {
                                      role: "operator",
                                      scopes:
                                          behavior === "read-only-scope"
                                              ? ["operator.read"]
                                              : ["operator.admin"],
                                  },
                                  protocol: 4,
                                  server: { connId: "fixture", version: "fixture" },
                                  snapshot: {
                                      authMode:
                                          behavior === "auth-none" ? "none" : "token",
                                  },
                                  type: "hello-ok",
                              },
                              type: "res",
                          }
                        : {
                              error: {
                                  code: "INVALID_REQUEST",
                                  details: { code: "AUTH_TOKEN_MISMATCH" },
                                  message: "unauthorized",
                              },
                              id,
                              ok: false,
                              type: "res",
                          };
                const encoded = JSON.stringify(response);
                socket.send(
                    behavior === "binary-response" ? Buffer.from(encoded) : encoded
                );
            },
            open(socket) {
                acceptedConnections += 1;
                openConnections += 1;
                if (behavior === "silent") return;
                if (behavior === "oversized-challenge") {
                    socket.send("x".repeat(gatewayCredentialChallengeMaximumBytes + 1));
                    return;
                }
                if (behavior === "unknown-event") {
                    socket.send(
                        JSON.stringify({
                            event: "tick",
                            payload: { ts: 1_785_974_400_000 },
                            type: "event",
                        })
                    );
                    return;
                }
                if (behavior === "response-before-challenge") {
                    socket.send(
                        JSON.stringify({
                            error: {
                                code: "INVALID_REQUEST",
                                details: { code: "AUTH_TOKEN_MISMATCH" },
                                message: "unauthorized",
                            },
                            id: "gateway-credential-verification",
                            ok: false,
                            type: "res",
                        })
                    );
                    return;
                }
                if (behavior === "close-before-challenge") {
                    socket.close(1011, "fixture unavailable");
                    return;
                }
                const challenge = JSON.stringify({
                    event: "connect.challenge",
                    payload: { nonce: "fixture-nonce", ts: 1_785_974_400_000 },
                    type: "event",
                });
                socket.send(challenge);
                if (behavior === "duplicate-challenge") socket.send(challenge);
            },
        },
    });
    const url = new URL(server.url);
    const httpUrl = url.origin;
    url.protocol = "ws:";

    return Object.freeze({
        get acceptedConnections(): number {
            return acceptedConnections;
        },
        get openConnections(): number {
            return openConnections;
        },
        observedCredentials,
        observedUpgradeRequests,
        httpUrl,
        async stop(): Promise<void> {
            await server.stop(true);
        },
        url: url.href,
    });
}
