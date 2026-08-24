import { afterEach, describe, expect, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { parseISO } from "date-fns";
import superjson from "superjson";
import * as v from "valibot";
import { map as mapSchema } from "valibot";

import { publicProcedure, router } from "../../trpc/trpc.ts";
import { createTestRequestContext } from "../support/requestContext.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop(true);
    }
});

describe("SuperJSON transport contract", () => {
    test("round-trips rich values through the shared SuperJSON transport", async () => {
        const richValuesSchema = v.strictObject({
            capturedAt: v.date(),
            labels: v.set(v.string()),
            metadata: mapSchema(v.string(), v.number()),
            sequence: v.bigint(),
        });
        const transportRouter = router({
            richValues: publicProcedure
                .input(richValuesSchema)
                .output(richValuesSchema)
                .query(({ input }) => input),
        });
        const server = Bun.serve({
            fetch(request) {
                return fetchRequestHandler({
                    createContext: () => createTestRequestContext(),
                    endpoint: "/trpc",
                    req: request,
                    router: transportRouter,
                });
            },
            hostname: "127.0.0.1",
            port: 0,
        });
        servers.push(server);
        const client = createTRPCClient<typeof transportRouter>({
            links: [
                httpBatchLink({
                    transformer: superjson,
                    url: new URL("/trpc", server.url),
                }),
            ],
        });

        const input = {
            capturedAt: parseISO("2026-08-04T12:00:00.000Z"),
            labels: new Set(["monitoring", "realtime"]),
            metadata: new Map([["attempt", 2]]),
            sequence: 9_007_199_254_740_993n,
        };
        const result = await client.richValues.query(input);

        expect(result).toEqual(input);
        expect(result.capturedAt).toBeInstanceOf(Date);
        expect(result.labels).toBeInstanceOf(Set);
        expect(result.metadata).toBeInstanceOf(Map);
        expect(typeof result.sequence).toBe("bigint");
    });
});
