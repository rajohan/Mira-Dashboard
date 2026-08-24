import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import {
    authenticationRequestBodyMaximumBytes,
    type ApplicationServer,
    createServer,
    serverListenerRequestBodyMaximumBytes,
    serverRequestBodyMaximumBytes,
} from "../../../app/server.ts";
import { chatAttachmentLimits } from "../../../contracts/chatMedia.ts";
import { bunRuntimePolicy } from "../../../shared/bunRuntimePolicy.ts";
import {
    createReadinessController,
    type ReadinessController,
} from "../../platform/readiness/readinessState.ts";
import * as runtimeIdentityModule from "../../platform/runtime/readRuntimeIdentity.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { rejectOnAbort, withTestTimeout } from "../support/promise.ts";
import {
    createCapturingTestStructuredLogger,
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestServerSecurityServices,
    waitForTestLogQuiescence,
} from "../support/requestContext.ts";

const servers: ApplicationServer[] = [];
const requestIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function compareUnknownStrings(left: unknown, right: unknown): number {
    return String(left).localeCompare(String(right));
}

async function startServer(): Promise<{
    readiness: ReadinessController;
    server: ApplicationServer;
}> {
    const readiness = createReadinessController();
    const server = await createServer({
        ...createTestServerSecurityServices(),
        applicationRuntime: createTestApplicationRuntime(),
        authenticationLifecycle: createTestAuthenticationLifecycleService(),
        authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
        hostname: "127.0.0.1",
        port: 0,
        readiness,
    });
    servers.push(server);
    return { readiness, server };
}

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

describe("system foundation", () => {
    test("serves typed runtime identity through tRPC", async () => {
        const { server } = await startServer();
        const client = createTRPCClient<AppRouter>({
            links: [
                httpBatchLink({
                    transformer: superjson,
                    url: new URL("/trpc", server.url),
                }),
            ],
        });

        expect(await client.system.runtimeIdentity.query()).toEqual({
            revision: Bun.revision,
            version: Bun.version,
            versionWithRevision: `${Bun.version}+${Bun.revision.slice(0, 9)}`,
        });
        let invalidInputError: unknown;
        try {
            await client.system.runtimeIdentity.query({ unexpected: true });
        } catch (error) {
            invalidInputError = error;
        }
        expect(invalidInputError).toBeInstanceOf(Error);
    });

    test("keeps health checks as explicit raw HTTP protocol routes", async () => {
        const { readiness: readinessController, server } = await startServer();

        const liveness = await fetch(new URL("/api/health/live", server.url));
        const readiness = await fetch(new URL("/api/health/ready", server.url));
        const headLiveness = await fetch(new URL("/api/health/live", server.url), {
            method: "HEAD",
        });
        const headReadiness = await fetch(new URL("/api/health/ready", server.url), {
            method: "HEAD",
        });
        const missing = await fetch(new URL("/api/unknown", server.url));
        const misleadingTrpcPrefix = await fetch(new URL("/trpc-unrelated", server.url));

        expect(liveness.status).toBe(200);
        expect(liveness.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(await liveness.json()).toEqual({ status: "live" });
        expect(readiness.status).toBe(503);
        expect(readiness.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(await readiness.json()).toEqual({ status: "not-ready" });
        expect(headLiveness.status).toBe(200);
        expect(headLiveness.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(await headLiveness.text()).toBe("");
        expect(headReadiness.status).toBe(503);
        expect(headReadiness.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(await headReadiness.text()).toBe("");
        expect(missing.status).toBe(404);
        expect(missing.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(misleadingTrpcPrefix.status).toBe(404);
        expect(misleadingTrpcPrefix.headers.get("x-request-id")).toMatch(
            requestIdPattern
        );

        readinessController.markReady();
        const ready = await fetch(new URL("/api/health/ready", server.url));
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: "ready" });

        readinessController.markUnavailable();
        const unavailable = await fetch(new URL("/api/health/ready", server.url));
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toEqual({ status: "not-ready" });
    });

    test("dispatches frontend paths after tRPC and health ownership", async () => {
        const frontendPaths: string[] = [];
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            frontendAssets(_request, requestUrl) {
                frontendPaths.push(requestUrl.pathname);
                let response: Response | undefined;
                if (requestUrl.pathname === "/") {
                    response = new Response("dashboard-browser");
                } else if (requestUrl.pathname === "/immutable-a1b2c3d4.js") {
                    response = new Response("immutable-browser-asset", {
                        headers: {
                            "cache-control": "public, max-age=31536000, immutable",
                        },
                    });
                }
                return Promise.resolve(response);
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const browser = await fetch(server.url);
        const immutable = await fetch(new URL("/immutable-a1b2c3d4.js", server.url));
        const health = await fetch(new URL("/api/health/live", server.url));
        const trpc = await fetch(new URL("/trpc/system.runtimeIdentity", server.url));
        const missing = await fetch(new URL("/unowned", server.url));

        expect(browser.status).toBe(200);
        expect(browser.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(await browser.text()).toBe("dashboard-browser");
        expect(immutable.status).toBe(200);
        expect(immutable.headers.get("x-request-id")).toBeNull();
        expect(await immutable.text()).toBe("immutable-browser-asset");
        expect(health.status).toBe(200);
        expect(trpc.status).toBe(200);
        expect(missing.status).toBe(404);
        expect(frontendPaths).toEqual(["/", "/immutable-a1b2c3d4.js", "/unowned"]);
    });

    test("correlates request bodies rejected by the application transport budget", async () => {
        const { server } = await startServer();
        const response = await fetch(new URL("/trpc/auth.status", server.url), {
            body: "x".repeat(authenticationRequestBodyMaximumBytes + 1),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(response.status).toBe(413);
        expect(response.headers.get("x-request-id")).toMatch(requestIdPattern);
    });

    test("keeps the tRPC route ceiling below the raw-upload listener ceiling", async () => {
        const { server } = await startServer();
        const response = await fetch(
            new URL("/trpc/system.runtimeIdentity", server.url),
            {
                body: "x".repeat(serverRequestBodyMaximumBytes + 1),
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );

        expect(response.status).toBe(413);
        expect(response.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(serverListenerRequestBodyMaximumBytes).toBe(
            chatAttachmentLimits.maximumFileBytes
        );
    });

    test("mounts an exact-cap chat upload before the browser fallback", async () => {
        let observedBytes: number | undefined;
        const frontendPaths: string[] = [];
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            chatRawHttpHandler: async (request, requestUrl) => {
                if (requestUrl.pathname !== "/api/chat/attachments/fixture") {
                    return;
                }
                observedBytes = Number(request.headers.get("content-length"));
                await request.body?.cancel("fixture raw handler owns the upload");
                return new Response(null, { status: 204 });
            },
            frontendAssets: (_request, requestUrl) => {
                frontendPaths.push(requestUrl.pathname);
                return Promise.resolve(new Response("browser-fallback"));
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const response = await fetch(
            new URL("/api/chat/attachments/fixture", server.url),
            {
                body: new Uint8Array(chatAttachmentLimits.maximumFileBytes),
                method: "PUT",
            }
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(observedBytes).toBe(chatAttachmentLimits.maximumFileBytes);
        expect(frontendPaths).toEqual([]);
    });

    test("mounts Files GET, HEAD, and PUT before chat and browser fallbacks", async () => {
        const observed: string[] = [];
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            chatRawHttpHandler: (_request, requestUrl) => {
                observed.push(`chat:${requestUrl.pathname}`);
                return Promise.resolve(new Response("chat-fallback"));
            },
            frontendAssets: (_request, requestUrl) => {
                observed.push(`frontend:${requestUrl.pathname}`);
                return Promise.resolve(new Response("browser-fallback"));
            },
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
            workspaceFileRawHttpHandler: async (request, requestUrl) => {
                if (!requestUrl.pathname.startsWith("/api/files/")) return;
                observed.push(`files:${request.method}:${requestUrl.pathname}`);
                await request.body?.cancel("fixture Files handler owns the upload");
                return new Response(request.method === "HEAD" ? null : "files", {
                    status: request.method === "PUT" ? 204 : 200,
                });
            },
        });
        servers.push(server);

        const get = await fetch(new URL("/api/files/content/fixture-ticket", server.url));
        const head = await fetch(
            new URL("/api/files/content/fixture-ticket", server.url),
            { method: "HEAD" }
        );
        const put = await fetch(
            new URL("/api/files/uploads/fixture-ticket", server.url),
            { body: "x", method: "PUT" }
        );

        expect([get.status, head.status, put.status]).toEqual([200, 200, 204]);
        expect(observed).toEqual([
            "files:GET:/api/files/content/fixture-ticket",
            "files:HEAD:/api/files/content/fixture-ticket",
            "files:PUT:/api/files/uploads/fixture-ticket",
        ]);
    });

    test("mounts configuration exports before chat and browser fallbacks", async () => {
        const observed: string[] = [];
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            chatRawHttpHandler: (_request, requestUrl) => {
                observed.push(`chat:${requestUrl.pathname}`);
                return Promise.resolve(new Response("chat-fallback"));
            },
            frontendAssets: (_request, requestUrl) => {
                observed.push(`frontend:${requestUrl.pathname}`);
                return Promise.resolve(new Response("browser-fallback"));
            },
            hostname: "127.0.0.1",
            openClawConfigurationBackupRawHttpHandler: (_request, requestUrl) => {
                if (
                    !requestUrl.pathname.startsWith(
                        "/api/openclaw-settings/configuration-backups/"
                    )
                ) {
                    return Promise.resolve(undefined);
                }
                observed.push(`backup:${requestUrl.pathname}`);
                return Promise.resolve(new Response("configuration-backup"));
            },
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const response = await fetch(
            new URL(
                "/api/openclaw-settings/configuration-backups/fixture-ticket",
                server.url
            )
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("configuration-backup");
        expect(observed).toEqual([
            "backup:/api/openclaw-settings/configuration-backups/fixture-ticket",
        ]);
    });

    test("passes unrelated configuration-export paths to the chat fallback", async () => {
        const observed: string[] = [];
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            chatRawHttpHandler: (_request, requestUrl) => {
                observed.push(`chat:${requestUrl.pathname}`);
                return Promise.resolve(new Response("chat-fallback"));
            },
            frontendAssets: (_request, requestUrl) => {
                observed.push(`frontend:${requestUrl.pathname}`);
                return Promise.resolve(new Response("browser-fallback"));
            },
            hostname: "127.0.0.1",
            openClawConfigurationBackupRawHttpHandler: (_request, requestUrl) => {
                observed.push(`backup:${requestUrl.pathname}`);
                return Promise.resolve(undefined);
            },
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const response = await fetch(
            new URL("/api/chat/media/unrelated-reference", server.url)
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("chat-fallback");
        expect(observed).toEqual([
            "backup:/api/chat/media/unrelated-reference",
            "chat:/api/chat/media/unrelated-reference",
        ]);
    });

    test("emits one correlated response-created event for every response class", async () => {
        const { logger, logLines } = createCapturingTestStructuredLogger();
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime({ logger }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        const responses = await Promise.all([
            fetch(new URL("/api/health/live", server.url)),
            fetch(new URL("/api/unknown", server.url)),
            fetch(new URL("/trpc/system.runtimeIdentity", server.url)),
        ]);
        await Promise.all(responses.map((response) => response.text()));
        await waitForTestLogQuiescence(logLines, 3);
        const records = logLines.map(
            (line) => JSON.parse(line) as Record<string, unknown>
        );

        expect(records).toHaveLength(3);
        expect(records.map((record) => record.event)).toEqual([
            "http.response.created",
            "http.response.created",
            "http.response.created",
        ]);
        expect(
            records.map((record) => record.requestId).toSorted(compareUnknownStrings)
        ).toEqual(
            responses
                .map((response) => response.headers.get("x-request-id"))
                .toSorted(compareUnknownStrings)
        );
        expect(
            records.every(
                (record) =>
                    Number.isSafeInteger(record.durationMs) &&
                    Number(record.durationMs) >= 0
            )
        ).toBe(true);
    });

    test("classifies an aborted streaming upload without a server-error event", async () => {
        const { logger, logLines } = createCapturingTestStructuredLogger();
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime({ logger }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const abortController = new AbortController();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
            },
        });
        const pendingRequest = fetch(new URL("/trpc/auth.status", server.url), {
            body,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: abortController.signal,
        }).catch((error: unknown) => error);

        await Bun.sleep(50);
        abortController.abort();
        expect(await pendingRequest).toBeInstanceOf(Error);
        await waitForTestLogQuiescence(logLines, 1);

        const records = logLines.map(
            (line) => JSON.parse(line) as Record<string, unknown>
        );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            component: "http",
            event: "http.request.cancelled",
            level: "info",
            outcome: "cancelled",
        });
        expect(records[0]).not.toHaveProperty("failure");
        expect(logLines.join("\n")).not.toContain("server-error");
    });

    test("classifies resolver cancellation after dispatch as one cancellation event", async () => {
        const { logger, logLines } = createCapturingTestStructuredLogger();
        const resolverStarted = Promise.withResolvers<void>();
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime({ logger }),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login(_input, metadata) {
                    resolverStarted.resolve();
                    if (metadata.signal === undefined) {
                        return Promise.reject(
                            new Error("Login resolver did not receive cancellation")
                        );
                    }
                    return rejectOnAbort(metadata.signal, "Login request was cancelled");
                },
            }),
            authenticateCredential: () => ({
                authentication: { kind: "anonymous" },
            }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const abortController = new AbortController();
        const pendingRequest = fetch(new URL("/trpc/auth.login", server.url), {
            body: JSON.stringify({
                json: {
                    password: "correct-horse-battery",
                    username: "operator",
                },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: abortController.signal,
        }).catch((error: unknown) => error);

        await withTestTimeout(
            resolverStarted.promise,
            1000,
            "Login resolver did not start"
        );
        abortController.abort();
        expect(await pendingRequest).toBeInstanceOf(Error);
        await waitForTestLogQuiescence(logLines, 1);

        const records = logLines.map(
            (line) => JSON.parse(line) as Record<string, unknown>
        );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            component: "http",
            event: "http.request.cancelled",
            level: "info",
            outcome: "cancelled",
        });
        expect(records[0]).not.toHaveProperty("failure");
        expect(logLines.join("\n")).not.toContain("server-error");
        expect(logLines.join("\n")).not.toContain("trpc.request.defect");
        expect(logLines.join("\n")).not.toContain("http.response.created");
        expect(logLines.join("\n")).not.toContain("http.request.failed");
    });

    test("returns a correlated sanitized 500 when a raw handler defects", async () => {
        const sentinel = "readiness-defect-secret";
        const { logger, logLines } = createCapturingTestStructuredLogger();
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime({ logger }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: {
                isReady() {
                    throw new Error(sentinel);
                },
                markReady() {},
                markUnavailable() {},
            },
        });
        servers.push(server);

        const response = await fetch(new URL("/api/health/ready", server.url));
        const body = await response.text();
        const requestId = response.headers.get("x-request-id");
        await waitForTestLogQuiescence(logLines, 1);

        expect(response.status).toBe(500);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(requestId).toMatch(requestIdPattern);
        expect(body).toBe("Internal Server Error");
        expect(body).not.toContain(sentinel);
        expect(logLines).toHaveLength(1);
        expect(JSON.stringify(logLines)).not.toContain(sentinel);
        expect(JSON.parse(logLines[0] ?? "null")).toMatchObject({
            component: "http",
            event: "http.request.failed",
            outcome: "server-error",
            requestId,
        });
    });

    test("rejects untrusted browser requests before authentication", async () => {
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

        const mutationResponse = await fetch(
            new URL("/trpc/system.runtimeIdentity", server.url),
            {
                body: "{}",
                headers: {
                    "content-type": "application/json",
                    origin: "https://attacker.example",
                    "sec-fetch-site": "cross-site",
                },
                method: "POST",
            }
        );
        const queryResponse = await fetch(
            new URL("/trpc/system.runtimeIdentity", server.url),
            {
                headers: {
                    origin: "https://attacker.example",
                    "sec-fetch-site": "cross-site",
                },
                method: "GET",
            }
        );

        expect(mutationResponse.status).toBe(403);
        expect(queryResponse.status).toBe(403);
        expect(authenticationCalls).toBe(0);
    });

    test("prewarms and disposes the process runtime exactly once", async () => {
        let disposals = 0;
        let initializations = 0;
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime({
                dispose: () => {
                    disposals += 1;
                    return Promise.resolve();
                },
                initialize: () => {
                    initializations += 1;
                    return Promise.resolve();
                },
            }),
            authenticationLifecycle: createTestAuthenticationLifecycleService(),
            authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);

        expect(initializations).toBe(1);
        await server.stop(true);
        await server.stop(true);
        expect(disposals).toBe(1);
    });

    test("stops a listener that reports an invalid bound port", async () => {
        let disposals = 0;
        let forcedStops = 0;
        const serveSpy = spyOn(Bun, "serve").mockImplementation(
            () =>
                ({
                    port: 0,
                    stop(force?: boolean) {
                        if (force) forcedStops += 1;
                        return Promise.resolve();
                    },
                    url: new URL("http://127.0.0.1"),
                }) as unknown as ReturnType<typeof Bun.serve>
        );

        try {
            let startupFailure: unknown;
            try {
                await createServer({
                    ...createTestServerSecurityServices(),
                    applicationRuntime: createTestApplicationRuntime({
                        dispose: () => {
                            disposals += 1;
                            return Promise.resolve();
                        },
                    }),
                    authenticationLifecycle: createTestAuthenticationLifecycleService(),
                    authenticateCredential: () => ({
                        authentication: { kind: "anonymous" },
                    }),
                    port: 0,
                    readiness: createReadinessController(),
                });
            } catch (error) {
                startupFailure = error;
            }

            expect(startupFailure).toBeInstanceOf(Error);
            expect(forcedStops).toBe(1);
            expect(disposals).toBe(1);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test("accepts new canary revisions on Bun 1.4", () => {
        expect(
            runtimeIdentityModule.readRuntimeIdentity({
                revision: "0".repeat(40),
                version: bunRuntimePolicy.version,
            })
        ).toEqual({
            revision: "0".repeat(40),
            version: bunRuntimePolicy.version,
            versionWithRevision: `${bunRuntimePolicy.version}+${"0".repeat(9)}`,
        });
    });

    test("rejects a runtime outside the Bun 1.4 baseline", () => {
        expect(() =>
            runtimeIdentityModule.readRuntimeIdentity({
                revision: "0000000000000000000000000000000000000000",
                version: "1.3.0",
            })
        ).toThrow(`Serving Bun runtime must be ${bunRuntimePolicy.version}`);
    });

    test("runs the runtime guard before invoking Bun.serve", async () => {
        const runtimeError = new Error("simulated unqualified runtime");
        const runtimeSpy = spyOn(
            runtimeIdentityModule,
            "readRuntimeIdentity"
        ).mockImplementation(() => {
            throw runtimeError;
        });
        const serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
            throw new Error("Bun.serve must not run before runtime verification");
        });

        try {
            const readiness = createReadinessController();
            let disposals = 0;
            let initializations = 0;
            let startupFailure: unknown;
            try {
                await createServer({
                    ...createTestServerSecurityServices(),
                    applicationRuntime: createTestApplicationRuntime({
                        dispose: () => {
                            disposals += 1;
                            return Promise.resolve();
                        },
                        initialize: () => {
                            initializations += 1;
                            return Promise.resolve();
                        },
                    }),
                    authenticationLifecycle: createTestAuthenticationLifecycleService(),
                    authenticateCredential: () => ({
                        authentication: { kind: "anonymous" },
                    }),
                    port: 0,
                    readiness,
                });
            } catch (error) {
                startupFailure = error;
            }
            expect(startupFailure).toBe(runtimeError);
            expect(disposals).toBe(1);
            expect(initializations).toBe(0);
            expect(serveSpy).not.toHaveBeenCalled();
        } finally {
            serveSpy.mockRestore();
            runtimeSpy.mockRestore();
        }
    });
});
