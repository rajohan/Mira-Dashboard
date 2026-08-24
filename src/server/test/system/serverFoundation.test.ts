import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import {
    type ApplicationServer,
    createServer,
    serverRequestBodyMaximumBytes,
} from "../../../app/server.ts";
import { bunRuntimePolicy } from "../../../shared/bunRuntimePolicy.ts";
import {
    createReadinessController,
    type ReadinessController,
} from "../../platform/readiness/readinessState.ts";
import * as runtimeIdentityModule from "../../platform/runtime/readRuntimeIdentity.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

const servers: ApplicationServer[] = [];

async function startServer(): Promise<{
    readiness: ReadinessController;
    server: ApplicationServer;
}> {
    const readiness = createReadinessController();
    const server = await createServer({
        applicationRuntime: createTestApplicationRuntime(),
        authenticateRequest: () => ({ authentication: { kind: "anonymous" } }),
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
        expect(await liveness.json()).toEqual({ status: "live" });
        expect(readiness.status).toBe(503);
        expect(await readiness.json()).toEqual({ status: "not-ready" });
        expect(headLiveness.status).toBe(200);
        expect(await headLiveness.text()).toBe("");
        expect(headReadiness.status).toBe(503);
        expect(await headReadiness.text()).toBe("");
        expect(missing.status).toBe(404);
        expect(misleadingTrpcPrefix.status).toBe(404);

        readinessController.markReady();
        const ready = await fetch(new URL("/api/health/ready", server.url));
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: "ready" });

        readinessController.markUnavailable();
        const unavailable = await fetch(new URL("/api/health/ready", server.url));
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toEqual({ status: "not-ready" });
    });

    test("rejects request bodies above the bounded application transport budget", async () => {
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
    });

    test("rejects untrusted browser requests before authentication", async () => {
        let authenticationCalls = 0;
        const server = await createServer({
            applicationRuntime: createTestApplicationRuntime(),
            authenticateRequest: () => {
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
            authenticateRequest: () => ({ authentication: { kind: "anonymous" } }),
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
                    applicationRuntime: createTestApplicationRuntime({
                        dispose: () => {
                            disposals += 1;
                            return Promise.resolve();
                        },
                    }),
                    authenticateRequest: () => ({
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
                    authenticateRequest: () => ({
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
