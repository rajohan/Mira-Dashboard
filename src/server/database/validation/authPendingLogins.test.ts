import { describe, expect, test } from "bun:test";

import { addMilliseconds, subMilliseconds } from "date-fns";
import * as v from "valibot";

import { pendingLoginLifetimeMs } from "../../shared/pendingLoginPolicy.ts";
import {
    authPendingLoginInsertSchema,
    authPendingLoginSelectSchema,
} from "./authPendingLogins.ts";
import {
    securityCreatedAt,
    validAuthPendingLoginInsert,
} from "./testSupport/securityRows.ts";

describe("pending login row schemas", () => {
    test("accepts a canonical password-to-MFA handoff", () => {
        expect(
            v.parse(authPendingLoginInsertSchema, validAuthPendingLoginInsert)
        ).toEqual(validAuthPendingLoginInsert);
        expect(
            v.parse(authPendingLoginSelectSchema, {
                ...validAuthPendingLoginInsert,
                attemptCount: 0,
                validatorVersion: 1,
            })
        ).toBeDefined();
    });

    test.each([
        { allowsRecovery: false, allowsTotp: false },
        { authenticationVersion: 0 },
        { id: "A".repeat(32) },
        { passwordVerifiedAt: addMilliseconds(securityCreatedAt, 1) },
        { expiresAt: securityCreatedAt },
        { expiresAt: addMilliseconds(securityCreatedAt, pendingLoginLifetimeMs + 1) },
        { replacedSessionId: "A".repeat(32) },
        { userAgent: "browser\0agent" },
        { validatorHash: "a".repeat(63) },
        { unexpected: true },
    ])("rejects invalid pending-login insert %#", (replacement) => {
        expect(() =>
            v.parse(authPendingLoginInsertSchema, {
                ...validAuthPendingLoginInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test.each([-1, 9, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects persisted attempt count %s",
        (attemptCount) => {
            expect(() =>
                v.parse(authPendingLoginSelectSchema, {
                    ...validAuthPendingLoginInsert,
                    attemptCount,
                    validatorVersion: 1,
                })
            ).toThrow();
        }
    );

    test("accepts the exhausted attempt boundary", () => {
        expect(
            v.parse(authPendingLoginSelectSchema, {
                ...validAuthPendingLoginInsert,
                attemptCount: 8,
                validatorVersion: 1,
            })
        ).toBeDefined();
    });

    test("keeps counter and token version database-owned on insert", () => {
        for (const replacement of [{ attemptCount: 0 }, { validatorVersion: 1 }]) {
            expect(() =>
                v.parse(authPendingLoginInsertSchema, {
                    ...validAuthPendingLoginInsert,
                    ...replacement,
                })
            ).toThrow();
        }
    });

    test("accepts the exact five-minute expiry boundary", () => {
        const passwordVerifiedAt = subMilliseconds(securityCreatedAt, 1);
        expect(
            v.parse(authPendingLoginInsertSchema, {
                ...validAuthPendingLoginInsert,
                expiresAt: addMilliseconds(passwordVerifiedAt, pendingLoginLifetimeMs),
                passwordVerifiedAt,
            })
        ).toBeDefined();
    });
});
