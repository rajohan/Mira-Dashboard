import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { requestAuthenticationSchema } from "./security.ts";

describe("request authentication contract", () => {
    test("normalizes and freezes an authenticated principal", () => {
        const authentication = v.parse(requestAuthenticationSchema, {
            kind: "authenticated",
            principal: {
                capabilities: ["reports:read", "notifications:read"],
                id: "operator-session",
                kind: "session",
            },
        });

        expect(authentication).toEqual({
            kind: "authenticated",
            principal: {
                capabilities: ["notifications:read", "reports:read"],
                id: "operator-session",
                kind: "session",
            },
        });
        expect(Object.isFrozen(authentication)).toBe(true);
        if (authentication.kind === "authenticated") {
            expect(Object.isFrozen(authentication.principal)).toBe(true);
            expect(Object.isFrozen(authentication.principal.capabilities)).toBe(true);
        }
    });

    test("rejects duplicate, unknown, blank, and excess authentication data", () => {
        const invalidAuthentication = [
            {
                kind: "authenticated",
                principal: {
                    capabilities: ["reports:read", "reports:read"],
                    id: "operator-session",
                    kind: "session",
                },
            },
            {
                kind: "authenticated",
                principal: {
                    capabilities: ["unknown:admin"],
                    id: "operator-session",
                    kind: "session",
                },
            },
            {
                kind: "authenticated",
                principal: {
                    capabilities: [],
                    id: "   ",
                    kind: "session",
                },
            },
            { kind: "anonymous", unexpected: true },
        ];

        for (const authentication of invalidAuthentication) {
            expect(v.safeParse(requestAuthenticationSchema, authentication).success).toBe(
                false
            );
        }
    });
});
