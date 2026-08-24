import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpBatchLink, httpLink } from "@trpc/client";
import superjson from "superjson";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import {
    authenticationRequestBodyMaximumBytes,
    createServer,
    type ApplicationServer,
    trpcMaximumBatchSize,
    trpcRequestBodyMaximumBytes,
} from "../../../app/server.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { generateOpaqueToken } from "../../shared/opaqueToken.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { openFreshMigratedDatabase } from "../support/freshDatabase.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAuthenticationResolution,
    createTestSessionAuthentication,
    testSecurityUserId,
    testSessionSelector,
} from "../support/requestContext.ts";

const servers: ApplicationServer[] = [];
const session = Object.freeze({
    authenticatedAtMs: 1_800_000_000_000,
    authMethod: "password" as const,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_802_592_000_000,
    id: testSessionSelector,
    isCurrent: true,
    lastSeenAtMs: 1_800_000_000_000,
});
const user = Object.freeze({ id: testSecurityUserId, username: "operator" });

async function rawHttpRequest(port: number, request: string): Promise<string> {
    const outcome = Promise.withResolvers<string>();
    let response = "";
    const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
            close() {
                outcome.resolve(response);
            },
            data(_socket, chunk) {
                response += chunk.toString();
            },
            error(_socket, error) {
                outcome.reject(error);
            },
            open(openedSocket) {
                openedSocket.write(request);
            },
            timeout(timedOutSocket) {
                timedOutSocket.end();
                outcome.reject(new Error("Raw authentication HTTP request timed out"));
            },
        },
    });
    socket.timeout(5000);
    try {
        return await outcome.promise;
    } finally {
        socket.end();
    }
}

afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
});

describe("authentication HTTP transport", () => {
    test("delivers a one-time token only through Fetch-adapter response headers", async () => {
        const generated = generateOpaqueToken("session");
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () =>
                    Promise.resolve({
                        session,
                        status: "created",
                        token: generated.token,
                        user,
                    }),
            }),
            authenticateRequest: () => ({ authentication: { kind: "anonymous" } }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const response = await fetch(new URL("/trpc/auth.login", server.url), {
            body: JSON.stringify({
                json: { password: "correct-horse-battery", username: "operator" },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        const responseText = await response.text();

        expect(response.status).toBe(200);
        expect(responseText).toContain('"username":"operator"');
        expect(responseText).not.toContain(generated.token);
        expect(response.headers.get("set-cookie")).toContain(
            `__Host-mira_dashboard_session=${generated.token}`
        );
        expect(response.headers.get("cache-control")).toContain("no-store");
    });

    test("allowlists batched auth reads and rejects every other auth batch", async () => {
        let authenticationCalls = 0;
        let loginCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () => {
                    loginCalls += 1;
                    return Promise.resolve({ status: "bootstrap-required" });
                },
                status: () => ({
                    authenticated: false,
                    isBootstrapRequired: true,
                }),
            }),
            authenticateRequest: () => {
                authenticationCalls += 1;
                return { authentication: { kind: "anonymous" } };
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const client = createTRPCClient<AppRouter>({
            links: [
                httpBatchLink({
                    transformer: superjson,
                    url: new URL("/trpc", server.url),
                }),
            ],
        });

        expect(await client.auth.status.query()).toEqual({
            authenticated: false,
            isBootstrapRequired: true,
        });
        const allowedReads = await fetch(
            new URL("/trpc/auth.status,auth.sessions?batch=1", server.url)
        );
        expect(allowedReads.status).toBe(207);
        const allowedReadsBody = await allowedReads.text();
        expect(allowedReadsBody).toContain('"isBootstrapRequired":true');
        expect(allowedReadsBody).toContain('"UNAUTHORIZED"');
        const authenticationCallsBeforeOversizedBatch = authenticationCalls;
        const oversizedBatch = await fetch(
            new URL(
                `/trpc/${Array.from(
                    { length: trpcMaximumBatchSize + 1 },
                    () => "auth.status"
                ).join(",")}?batch=1`,
                server.url
            )
        );
        expect(oversizedBatch.status).toBe(400);
        expect(oversizedBatch.headers.get("cache-control")).toContain("no-store");
        expect(authenticationCalls).toBe(authenticationCallsBeforeOversizedBatch);
        const authenticationCallsBeforeRejections = authenticationCalls;
        for (const path of [
            "/trpc/auth.login?batch=1",
            "/trpc/auth%2Elogin?batch=1",
            "/trpc/auth.status%2Cauth.login?batch=1",
            "/trpc/auth.status,auth.login/?batch=1",
            "/trpc/auth.login%?batch=1",
            "/trpc/auth.future?batch=1",
            "/trpc/auth.statusExtra?batch=1",
        ]) {
            const response = await fetch(new URL(path, server.url), {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
            });

            expect(response.status).toBe(400);
            expect(await response.text()).toBe(
                "Authentication procedure is not batchable"
            );
            expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(authenticationCalls).toBe(authenticationCallsBeforeRejections);
        expect(loginCalls).toBe(0);
    });

    test("rejects cross-site bootstrap before reaching the lifecycle service", async () => {
        let bootstrapCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                bootstrap: () => {
                    bootstrapCalls += 1;
                    return Promise.resolve({ status: "invalid-gateway" });
                },
            }),
            authenticateRequest: () => ({ authentication: { kind: "anonymous" } }),
            browserOrigin: "https://dashboard.example",
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const response = await fetch(new URL("/trpc/auth.bootstrap", server.url), {
            body: "{}",
            headers: {
                "content-type": "application/json",
                origin: "https://attacker.example",
                "sec-fetch-site": "cross-site",
            },
            method: "POST",
        });

        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(bootstrapCalls).toBe(0);
    });

    test("bounds every tRPC body before authentication or parsing", async () => {
        let authenticationCalls = 0;
        let loginCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () => {
                    loginCalls += 1;
                    return Promise.resolve({ status: "bootstrap-required" });
                },
            }),
            authenticateRequest: () => {
                authenticationCalls += 1;
                return { authentication: { kind: "anonymous" } };
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const declared = await fetch(new URL("/trpc/auth.login", server.url), {
            body: "x".repeat(authenticationRequestBodyMaximumBytes + 1),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new Uint8Array(authenticationRequestBodyMaximumBytes + 1)
                );
                controller.close();
            },
        });
        const streamed = await fetch(new URL("/trpc/auth.login", server.url), {
            body: stream,
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        const nonAuthDeclared = await fetch(new URL("/trpc/nope", server.url), {
            body: "x".repeat(trpcRequestBodyMaximumBytes + 1),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        const unknownStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(trpcRequestBodyMaximumBytes + 1));
                controller.close();
            },
        });
        const nonAuthStreamed = await fetch(new URL("/trpc/nope", server.url), {
            body: unknownStream,
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        for (const response of [declared, streamed]) {
            expect(response.status).toBe(413);
            expect(response.headers.get("cache-control")).toBe("no-store");
        }
        for (const response of [nonAuthDeclared, nonAuthStreamed]) {
            expect(response.status).toBe(413);
        }
        expect(authenticationCalls).toBe(0);
        expect(loginCalls).toBe(0);
    });

    test("rejects tRPC HEAD and raw GET bodies before context creation", async () => {
        let authenticationCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService(),
            authenticateRequest: () => {
                authenticationCalls += 1;
                return { authentication: { kind: "anonymous" } };
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const response = await rawHttpRequest(
            server.port,
            [
                "GET /trpc/auth.status HTTP/1.1",
                `Host: 127.0.0.1:${server.port}`,
                "Content-Length: 2",
                "Content-Type: application/json",
                "Connection: close",
                "",
                "{}",
            ].join("\r\n")
        );
        const headResponse = await fetch(new URL("/trpc/auth.status", server.url), {
            method: "HEAD",
        });

        expect(response).toContain("HTTP/1.1 400 Bad Request");
        expect(response.toLowerCase()).toContain("cache-control: no-store");
        expect(headResponse.status).toBe(405);
        expect(headResponse.headers.get("allow")).toBe("GET, POST");
        expect(headResponse.headers.get("cache-control")).toBe("no-store");
        expect(await headResponse.text()).toBe("");
        expect(authenticationCalls).toBe(0);
    });

    test("rejects ambiguous credentials before authentication or logout", async () => {
        let authenticationCalls = 0;
        let logoutCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                logout: () => {
                    logoutCalls += 1;
                    return true;
                },
            }),
            authenticateRequest: () => {
                authenticationCalls += 1;
                return { authentication: { kind: "anonymous" } };
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const response = await fetch(new URL("/trpc/auth.logout", server.url), {
            body: JSON.stringify({ json: {} }),
            headers: {
                authorization: `Bearer ${"a".repeat(32)}.${"b".repeat(64)}`,
                "content-type": "application/json",
                cookie: "__Host-mira_dashboard_session=malformed",
            },
            method: "POST",
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Ambiguous authentication credentials");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(authenticationCalls).toBe(0);
        expect(logoutCalls).toBe(0);
    });

    test("delivers Retry-After and cookie clearing through real Fetch responses", async () => {
        const rateLimitedServer = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () =>
                    Promise.resolve({ retryAfterSeconds: 23, status: "rate-limited" }),
            }),
            authenticateRequest: () => ({ authentication: { kind: "anonymous" } }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(rateLimitedServer);
        const rateLimited = await fetch(
            new URL("/trpc/auth.login", rateLimitedServer.url),
            {
                body: JSON.stringify({
                    json: {
                        password: "correct-horse-battery",
                        username: "operator",
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );

        expect(rateLimited.status).toBe(429);
        expect(rateLimited.headers.get("retry-after")).toBe("23");
        expect(rateLimited.headers.get("cache-control")).toContain("no-store");

        const sessionChangedServer = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                changePassword: () => Promise.resolve({ status: "session-changed" }),
            }),
            authenticateRequest: () =>
                createTestAuthenticationResolution(
                    createTestSessionAuthentication(["reports:read"])
                ),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(sessionChangedServer);
        const sessionChanged = await fetch(
            new URL("/trpc/auth.changePassword", sessionChangedServer.url),
            {
                body: JSON.stringify({
                    json: {
                        currentPassword: "correct-horse-battery",
                        newPassword: "another-correct-horse",
                    },
                }),
                headers: {
                    "content-type": "application/json",
                    cookie: `__Host-mira_dashboard_session=${generateOpaqueToken("session").token}`,
                },
                method: "POST",
            }
        );

        expect(sessionChanged.status).toBe(401);
        expect(sessionChanged.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(sessionChanged.headers.get("cache-control")).toContain("no-store");
    });

    test("composes Gateway verification, SQLite, cookie issuance, and request authentication", async () => {
        const database = await openFreshMigratedDatabase();
        let observedGatewayCredential: string | undefined;
        const server = await createDashboardServer({
            applicationRuntime: createTestApplicationRuntime(),
            browserOrigin: "https://dashboard.example",
            database: database.orm,
            port: 0,
            readiness: createReadinessController(),
            verifyGatewayCredential: (credential) => {
                observedGatewayCredential = credential;
                return Promise.resolve(true);
            },
        });
        servers.push(server);

        try {
            const bootstrapResponse = await fetch(
                new URL("/trpc/auth.bootstrap", server.url),
                {
                    body: JSON.stringify({
                        json: {
                            gatewayCredential: "gateway-token",
                            password: "correct-horse-battery",
                            username: "operator",
                        },
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }
            );
            const setCookie = bootstrapResponse.headers.get("set-cookie");
            const cookie = setCookie?.split(";", 1)[0];
            if (cookie === undefined) {
                throw new Error("Bootstrap did not return a session cookie");
            }
            const client = createTRPCClient<AppRouter>({
                links: [
                    httpLink({
                        headers: { cookie },
                        transformer: superjson,
                        url: new URL("/trpc", server.url),
                    }),
                ],
            });

            expect(bootstrapResponse.status).toBe(200);
            expect(server.url.hostname).toBe("127.0.0.1");
            expect(observedGatewayCredential).toBe("gateway-token");
            expect(await client.auth.status.query()).toMatchObject({
                authenticated: true,
                isBootstrapRequired: false,
                user: { username: "operator" },
            });
        } finally {
            await server.stop(true);
            servers.splice(servers.indexOf(server), 1);
            database.sqlite.close(true);
        }
    });
});
