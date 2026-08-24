import { describe, expect, test } from "bun:test";

import { createTestApplicationRuntime } from "../test/support/requestContext.ts";
import { createRequestContext } from "./context.ts";

describe("tRPC request context", () => {
    test("validates and freezes the authentication boundary", async () => {
        const request = new Request("http://localhost/trpc/events.stream");
        let observedRequest: Request | undefined;
        const applicationRuntime = createTestApplicationRuntime();

        const context = await createRequestContext({
            applicationRuntime,
            authenticateRequest(candidate) {
                observedRequest = candidate;
                return {
                    kind: "authenticated",
                    principal: {
                        capabilities: ["reports:read", "notifications:read"],
                        id: "operator-session",
                        kind: "session",
                    },
                };
            },
            request,
        });

        expect(observedRequest).toBe(request);
        expect(context.authentication).toEqual({
            kind: "authenticated",
            principal: {
                capabilities: ["notifications:read", "reports:read"],
                id: "operator-session",
                kind: "session",
            },
        });
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.authentication)).toBe(true);
        expect(context.services).toBe(applicationRuntime.services);
        expect("dispose" in context.services).toBe(false);
        if (context.authentication.kind === "authenticated") {
            expect(Object.isFrozen(context.authentication.principal)).toBe(true);
            expect(Object.isFrozen(context.authentication.principal.capabilities)).toBe(
                true
            );
        }
    });

    test("rejects malformed authentication service output", async () => {
        let failure: unknown;
        try {
            await createRequestContext({
                applicationRuntime: createTestApplicationRuntime(),
                authenticateRequest: () => ({
                    kind: "authenticated",
                    principal: {
                        capabilities: ["unknown:admin"],
                        id: "operator-session",
                        kind: "session",
                    },
                }),
                request: new Request("http://localhost/trpc/events.stream"),
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
    });
});
