import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { requestAuthenticationSchema } from "./security.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const sessionSelector = "a".repeat(32);

describe("request authentication contract", () => {
    test("normalizes and freezes an authenticated principal", () => {
        const authentication = v.parse(requestAuthenticationSchema, {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: ["reports:read", "notifications:read"],
                authenticatorId: sessionSelector,
                id: userId,
                kind: "session",
            },
        });

        expect(authentication).toEqual({
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: ["notifications:read", "reports:read"],
                authenticatorId: sessionSelector,
                id: userId,
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
                    authorizationVersion: 1,
                    capabilities: ["reports:read", "reports:read"],
                    authenticatorId: sessionSelector,
                    id: userId,
                    kind: "session",
                },
            },
            {
                kind: "authenticated",
                principal: {
                    authorizationVersion: 1,
                    capabilities: ["unknown:admin"],
                    authenticatorId: sessionSelector,
                    id: userId,
                    kind: "session",
                },
            },
            {
                kind: "authenticated",
                principal: {
                    authorizationVersion: 1,
                    capabilities: [],
                    authenticatorId: sessionSelector,
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
