import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import {
    authenticationRequestBodyMaximumBytes,
    createServer,
    type ApplicationServer,
    trpcMaximumBatchSize,
    trpcRequestBodyMaximumBytes,
} from "../../../app/server.ts";
import { createRegistrationFixture } from "../../domains/security/mfa/webauthn/testSupport/ceremonyFixture.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestServerSecurityServices,
} from "../support/requestContext.ts";

const servers: ApplicationServer[] = [];

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

describe("authentication HTTP transport policy", () => {
    test("allowlists batched auth reads and rejects every other auth batch", async () => {
        let authenticationCalls = 0;
        let loginCalls = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
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
            authenticateCredential: () => {
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
            state: "bootstrap-required",
        });
        const allowedReads = await fetch(
            new URL("/trpc/auth.status,auth.sessions?batch=1", server.url)
        );
        expect(allowedReads.status).toBe(207);
        const allowedReadsBody = await allowedReads.text();
        expect(allowedReadsBody).toContain('"state":"bootstrap-required"');
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
            "/trpc/accountSecurity.stepUpTotp?batch=1",
            "/trpc/accountSecurity%2EstepUpRecovery?batch=1",
            "/trpc/auth.beginWebAuthnLogin?batch=1",
            "/trpc/auth.loginWebAuthn?batch=1",
            "/trpc/accountSecurity.beginWebAuthnStepUp?batch=1",
            "/trpc/accountSecurity.stepUpWebAuthn?batch=1",
            "/trpc/accountSecurity.beginWebAuthnEnrollment?batch=1",
            "/trpc/accountSecurity.confirmWebAuthnEnrollment?batch=1",
            "/trpc/accountSecurity.removeWebAuthnCredential?batch=1",
        ]) {
            const response = await fetch(new URL(path, server.url), {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
            });

            expect(response.status).toBe(400);
            expect(await response.text()).toBe("Security procedure is not batchable");
            expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(authenticationCalls).toBe(authenticationCallsBeforeRejections);
        expect(loginCalls).toBe(0);

        const doubleEncodedProcedure = await fetch(
            new URL("/trpc/auth%252Elogin?batch=1", server.url),
            {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );
        expect(doubleEncodedProcedure.status).toBe(404);
        expect(await doubleEncodedProcedure.text()).toContain("NOT_FOUND");
        expect(authenticationCalls).toBe(authenticationCallsBeforeRejections + 1);
        expect(loginCalls).toBe(0);
    });

    test("keeps a real WebAuthn registration fixture inside the auth body ceiling", async () => {
        let authenticationCalls = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService(),
            authenticateCredential: () => {
                authenticationCalls += 1;
                return { authentication: { kind: "anonymous" } };
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const body = JSON.stringify({
            json: {
                label: "Qualified roaming security key",
                response: createRegistrationFixture(),
            },
        });

        expect(Buffer.byteLength(body)).toBeLessThan(
            authenticationRequestBodyMaximumBytes
        );
        const response = await fetch(
            new URL("/trpc/accountSecurity.confirmWebAuthnEnrollment", server.url),
            {
                body,
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );

        expect(response.status).not.toBe(413);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(authenticationCalls).toBe(1);
    });

    test("rejects cross-site bootstrap before reaching the lifecycle service", async () => {
        let bootstrapCalls = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                bootstrap: () => {
                    bootstrapCalls += 1;
                    return Promise.resolve({ status: "invalid-gateway" });
                },
            }),
            authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
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
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () => {
                    loginCalls += 1;
                    return Promise.resolve({ status: "bootstrap-required" });
                },
            }),
            authenticateCredential: () => {
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

    test("rejects unsupported methods and raw GET bodies before context creation", async () => {
        let authenticationCalls = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService(),
            authenticateCredential: () => {
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
        const unsupportedResponse = await fetch(
            new URL("/trpc/auth.status", server.url),
            {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "PUT",
            }
        );

        expect(response).toContain("HTTP/1.1 400 Bad Request");
        expect(response.toLowerCase()).toContain("cache-control: no-store");
        expect(headResponse.status).toBe(405);
        expect(headResponse.headers.get("allow")).toBe("GET, POST");
        expect(headResponse.headers.get("cache-control")).toBe("no-store");
        expect(await headResponse.text()).toBe("");
        expect(unsupportedResponse.status).toBe(405);
        expect(unsupportedResponse.headers.get("allow")).toBe("GET, POST");
        expect(unsupportedResponse.headers.get("cache-control")).toBe("no-store");
        expect(await unsupportedResponse.text()).toBe("");
        expect(authenticationCalls).toBe(0);
    });

    test("rejects ambiguous credentials before authentication or logout", async () => {
        let authenticationCalls = 0;
        let logoutCalls = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                logout: () => {
                    logoutCalls += 1;
                    return true;
                },
            }),
            authenticateCredential: () => {
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
});
