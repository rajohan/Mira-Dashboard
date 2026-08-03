import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { createGreenfieldServer } from "../../app/server.ts";
import { runtimeManifest } from "../../shared/runtimeManifest.ts";
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
            revision: runtimeManifest.revision,
            version: runtimeManifest.version,
            versionWithRevision: runtimeManifest.versionWithRevision,
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
        const missing = await fetch(new URL("/api/unknown", server.url));
        const misleadingTrpcPrefix = await fetch(new URL("/trpc-unrelated", server.url));

        expect(liveness.status).toBe(200);
        expect(await liveness.json()).toEqual({ status: "live" });
        expect(readiness.status).toBe(200);
        expect(await readiness.json()).toEqual({ status: "ready" });
        expect(missing.status).toBe(404);
        expect(misleadingTrpcPrefix.status).toBe(404);
    });
});
