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
                    authentication: {
                        kind: "authenticated",
                        principal: {
                            authorizationVersion: 1,
                            capabilities: ["reports:read", "notifications:read"],
                            authenticatorId: "a".repeat(32),
                            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            kind: "session",
                        },
                    },
                    lease: {
                        expiresAtMs: 1_800_000_000_000,
                        revalidate: () => Promise.resolve({ kind: "invalid" }),
                    },
                };
            },
            request,
        });

        expect(observedRequest).toBe(request);
        expect(context.authentication).toEqual({
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: ["notifications:read", "reports:read"],
                authenticatorId: "a".repeat(32),
                id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "session",
            },
        });
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.authentication)).toBe(true);
        expect(Object.isFrozen(context.authenticationLease)).toBe(true);
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
                    authentication: {
                        kind: "authenticated",
                        principal: {
                            authorizationVersion: 1,
                            capabilities: ["unknown:admin"],
                            authenticatorId: "a".repeat(32),
                            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            kind: "session",
                        },
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
