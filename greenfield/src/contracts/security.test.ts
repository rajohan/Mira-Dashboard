import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    applicationCapabilities,
    applicationCapabilityListSchema,
    authenticationMethods,
    multiFactorAuthenticationMethods,
    requestAuthenticationSchema,
} from "./security.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const sessionSelector = "a".repeat(32);

describe("request authentication contract", () => {
    test("includes canonical least-privilege job capabilities", () => {
        expect(applicationCapabilities).toEqual([
            "agents:read",
            "agents:write",
            "cache:read",
            "cache:write",
            "chat:read",
            "chat:write",
            "files:read",
            "files:write",
            "gateway-sessions:read",
            "gateway-sessions:write",
            "jobs:read",
            "jobs:write",
            "logs:read",
            "logs:write",
            "monitoring:write",
            "notifications:read",
            "notifications:write",
            "openclaw-settings:read",
            "openclaw-settings:write",
            "openclaw-tasks:read",
            "openclaw-tasks:write",
            "reports:read",
            "reports:write",
            "service-actions:read",
            "service-actions:write",
            "tasks:read",
            "tasks:write",
            "terminal:read",
            "terminal:write",
        ]);
        expect(
            v.parse(applicationCapabilityListSchema, ["jobs:write", "jobs:read"])
        ).toEqual(["jobs:read", "jobs:write"]);
    });

    test("advertises only authentication methods implemented by this slice", () => {
        expect(authenticationMethods).toEqual([
            "password",
            "recovery",
            "totp",
            "webauthn",
        ]);
        expect(multiFactorAuthenticationMethods).toEqual([
            "recovery",
            "totp",
            "webauthn",
        ]);
    });

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
