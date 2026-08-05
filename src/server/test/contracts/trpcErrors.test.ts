import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { publicProcedure, router } from "../../trpc/trpc.ts";
import { createTestRequestContext } from "../support/requestContext.ts";

async function queryWireBody(procedure: "expected" | "unexpected"): Promise<{
    response: Response;
    text: string;
}> {
    const sentinel = "secret /home/ubuntu/private-stack-path";
    const errorRouter = router({
        expected: publicProcedure.query(() => {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Safe client error" });
        }),
        unexpected: publicProcedure.query(() => {
            throw new Error(sentinel);
        }),
    });
    const response = await fetchRequestHandler({
        createContext: () => createTestRequestContext(),
        endpoint: "/trpc",
        req: new Request(`http://localhost/trpc/${procedure}`),
        router: errorRouter,
    });
    return { response, text: await response.text() };
}

describe("tRPC error transport", () => {
    test("redacts unknown internal errors from the wire shape", async () => {
        const { response, text } = await queryWireBody("unexpected");

        expect(response.status).toBe(500);
        expect(text).toContain("Internal server error");
        expect(text).not.toContain("secret /home/ubuntu/private-stack-path");
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("preserves explicitly safe expected error messages without stack or path", async () => {
        const { response, text } = await queryWireBody("expected");

        expect(response.status).toBe(400);
        expect(text).toContain("Safe client error");
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });
});
