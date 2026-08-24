import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { createServer } from "../../app/server.ts";
import { bunRuntimePolicy } from "../../shared/bunRuntimePolicy.ts";
import {
    createReadinessController,
    type ReadinessController,
} from "../platform/readiness/readinessState.ts";
import * as runtimeIdentityModule from "../platform/runtime/readRuntimeIdentity.ts";
import type { AppRouter } from "../trpc/appRouter.ts";

const servers: Array<ReturnType<typeof createServer>> = [];

function startServer(): {
    readiness: ReadinessController;
    server: ReturnType<typeof createServer>;
} {
    const readiness = createReadinessController();
    const server = createServer({ port: 0, readiness });
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
        const { server } = startServer();
        const client = createTRPCClient<AppRouter>({
            links: [httpBatchLink({ url: new URL("/trpc", server.url) })],
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
        const { readiness: readinessController, server } = startServer();

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

    test("runs the runtime guard before invoking Bun.serve", () => {
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
            expect(() => createServer({ port: 0, readiness })).toThrow(runtimeError);
            expect(serveSpy).not.toHaveBeenCalled();
        } finally {
            serveSpy.mockRestore();
            runtimeSpy.mockRestore();
        }
    });
});
