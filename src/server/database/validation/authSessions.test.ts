import { describe, expect, test } from "bun:test";

import { addMilliseconds, subMilliseconds } from "date-fns";
import * as v from "valibot";

import { authSessionInsertSchema, authSessionSelectSchema } from "./authSessions.ts";
import {
    securityCreatedAt,
    securityExpiresAt,
    validAuthSessionInsert,
} from "./testSupport/securityRows.ts";

describe("auth session row schemas", () => {
    test("accepts a canonical selector-validator session", () => {
        expect(v.parse(authSessionInsertSchema, validAuthSessionInsert)).toEqual(
            validAuthSessionInsert
        );
        expect(
            v.parse(authSessionSelectSchema, {
                ...validAuthSessionInsert,
                elevatedAt: null,
                elevatedMethod: null,
                mfaVerifiedAt: null,
                userAgent: null,
                validatorVersion: 1,
            })
        ).toBeDefined();
    });

    test("keeps validatorVersion database-owned on insert", () => {
        expect(() =>
            v.parse(authSessionInsertSchema, {
                ...validAuthSessionInsert,
                validatorVersion: 1,
            })
        ).toThrow();
    });

    test.each([
        { id: "A".repeat(32) },
        { id: `${"a".repeat(32)}\0suffix` },
        { validatorHash: "b".repeat(63) },
        { validatorHash: `${"b".repeat(64)}\0suffix` },
        { authenticationVersion: 0 },
        { authenticationVersion: Number.MAX_SAFE_INTEGER + 1 },
        { authenticatedAt: addMilliseconds(securityCreatedAt, 1) },
        { lastSeenAt: securityExpiresAt },
        { expiresAt: securityCreatedAt },
        { elevatedAt: securityCreatedAt },
        { userAgent: "\t\n" },
        { userAgent: "browser\0agent" },
        {
            elevatedAt: subMilliseconds(securityCreatedAt, 1),
            elevatedMethod: "password",
        },
        { authMethod: "magic-link" },
    ])("rejects invalid session row %#", (replacement) => {
        expect(() =>
            v.parse(authSessionInsertSchema, {
                ...validAuthSessionInsert,
                ...replacement,
            })
        ).toThrow();
    });
});
