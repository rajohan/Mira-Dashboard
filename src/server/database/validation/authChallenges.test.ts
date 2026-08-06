import { describe, expect, test } from "bun:test";

import { addMilliseconds, addMinutes } from "date-fns";
import * as v from "valibot";

import {
    authChallengeInsertSchema,
    authChallengeSelectSchema,
} from "./authChallenges.ts";
import {
    pendingLoginSelector,
    securityCreatedAt,
    validAuthChallengeInsert,
} from "./testSupport/securityRows.ts";

describe("WebAuthn challenge row schemas", () => {
    test("accepts purpose-compatible session and pending-login bindings", () => {
        expect(v.parse(authChallengeInsertSchema, validAuthChallengeInsert)).toEqual(
            validAuthChallengeInsert
        );
        expect(
            v.parse(authChallengeSelectSchema, {
                ...validAuthChallengeInsert,
                purpose: "step-up",
            })
        ).toBeDefined();
        expect(
            v.parse(authChallengeInsertSchema, {
                ...validAuthChallengeInsert,
                pendingLoginId: pendingLoginSelector,
                purpose: "login",
                sessionId: null,
            })
        ).toBeDefined();
    });

    test.each([
        { authenticationVersion: 0 },
        { authenticationVersion: Number.MAX_SAFE_INTEGER + 1 },
        { challenge: "A".repeat(31) },
        { challenge: "A".repeat(257) },
        { challenge: `${"A".repeat(32)}=` },
        { challenge: `${"A".repeat(33)}B` },
        { configFingerprint: "E".repeat(64) },
        { configFingerprint: "e".repeat(63) },
        { id: "550e8400-e29b-41d4-a716-446655440000" },
        { expiresAt: securityCreatedAt },
        { expiresAt: addMilliseconds(securityCreatedAt, 300_001) },
        { pendingLoginId: pendingLoginSelector },
        { purpose: "login" },
        { purpose: "registration", sessionId: null },
        { purpose: "unknown" },
        { unexpected: true },
    ])("rejects invalid challenge row %#", (replacement) => {
        expect(() =>
            v.parse(authChallengeInsertSchema, {
                ...validAuthChallengeInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test("accepts canonical terminal bits and the exact five-minute lifetime", () => {
        expect(
            v.parse(authChallengeInsertSchema, {
                ...validAuthChallengeInsert,
                challenge: `${"A".repeat(33)}A`,
                expiresAt: addMinutes(securityCreatedAt, 5),
            })
        ).toBeDefined();
    });
});
