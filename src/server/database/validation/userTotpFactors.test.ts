import { describe, expect, test } from "bun:test";

import { addMilliseconds, subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    securityCreatedAt,
    validUserTotpFactorInsert,
} from "./testSupport/securityRows.ts";
import {
    userTotpFactorInsertSchema,
    userTotpFactorSelectSchema,
} from "./userTotpFactors.ts";

describe("TOTP factor row schemas", () => {
    test("accepts exact pending and confirmed encrypted factors", () => {
        expect(v.parse(userTotpFactorInsertSchema, validUserTotpFactorInsert)).toEqual(
            validUserTotpFactorInsert
        );
        expect(
            v.parse(userTotpFactorSelectSchema, {
                ...validUserTotpFactorInsert,
                confirmedAt: securityCreatedAt,
                lastUsedStep: 59,
                secretKeyId: `a${"b".repeat(31)}`,
            })
        ).toBeDefined();
    });

    test.each([
        { id: "550e8400-e29b-41d4-a716-446655440000" },
        { label: "Authenticator\u061C" },
        { label: "Authenticator\u200B" },
        { label: "Authenticator\u202E" },
        { label: "Authenticator\u2060" },
        { label: "a".repeat(129) },
        { secretKeyId: "Primary" },
        { secretKeyId: "primary.key" },
        { secretKeyId: "a".repeat(33) },
        { encryptedSecret: `v2.${"A".repeat(16)}.${"B".repeat(64)}` },
        { encryptedSecret: `v1.${"A".repeat(15)}.${"B".repeat(64)}` },
        { encryptedSecret: `v1.${"A".repeat(16)}.${"B".repeat(64)}=` },
        { encryptedSecret: `v1.${"A".repeat(16)}.${"B".repeat(63)}+` },
        { enrollmentExpiresAt: securityCreatedAt },
        { enrollmentExpiresAt: addMilliseconds(securityCreatedAt, 300_001) },
        { confirmedAt: securityCreatedAt },
        { lastUsedStep: 0 },
        { confirmedAt: subMilliseconds(securityCreatedAt, 1), lastUsedStep: 0 },
        {
            confirmedAt: validUserTotpFactorInsert.enrollmentExpiresAt,
            lastUsedStep: 0,
        },
        { confirmedAt: securityCreatedAt, lastUsedStep: -1 },
        {
            confirmedAt: securityCreatedAt,
            lastUsedStep: Number.MAX_SAFE_INTEGER + 1,
        },
    ])("rejects invalid TOTP factor %#", (replacement) => {
        expect(() =>
            v.parse(userTotpFactorInsertSchema, {
                ...validUserTotpFactorInsert,
                ...replacement,
            })
        ).toThrow();
    });
});
