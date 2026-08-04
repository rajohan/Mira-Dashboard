import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { createGreenfieldServer } from "../../app/server.ts";
import { bunRuntimePolicy } from "../../shared/bunRuntimePolicy.ts";
import * as runtimeIdentityModule from "../platform/runtime/readRuntimeIdentity.ts";
import type { AppRouter } from "../trpc/appRouter.ts";

const servers: Array<ReturnType<typeof createGreenfieldServer>> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

describe("greenfield system foundation", () => {
    test("serves typed runtime identity through tRPC", async () => {
        const server = createGreenfieldServer({ port: 0 });
        servers.push(server);
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
        const server = createGreenfieldServer({ port: 0 });
        servers.push(server);

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
        expect(readiness.status).toBe(200);
        expect(await readiness.json()).toEqual({ status: "ready" });
        expect(headLiveness.status).toBe(200);
        expect(await headLiveness.text()).toBe("");
        expect(headReadiness.status).toBe(200);
        expect(await headReadiness.text()).toBe("");
        expect(missing.status).toBe(404);
        expect(misleadingTrpcPrefix.status).toBe(404);
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
            expect(() => createGreenfieldServer({ port: 0 })).toThrow(runtimeError);
            expect(serveSpy).not.toHaveBeenCalled();
        } finally {
            serveSpy.mockRestore();
            runtimeSpy.mockRestore();
        }
    });
});
