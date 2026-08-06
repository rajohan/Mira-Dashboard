import { describe, expect, test } from "bun:test";

import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    securityCreatedAt,
    validUserRecoveryCodeInsert,
} from "./testSupport/securityRows.ts";
import {
    userRecoveryCodeInsertSchema,
    userRecoveryCodeSelectSchema,
} from "./userRecoveryCodes.ts";

describe("recovery code row schemas", () => {
    test("accepts canonical unused and consumed recovery proofs", () => {
        expect(
            v.parse(userRecoveryCodeInsertSchema, validUserRecoveryCodeInsert)
        ).toEqual(validUserRecoveryCodeInsert);
        expect(
            v.parse(userRecoveryCodeSelectSchema, {
                ...validUserRecoveryCodeInsert,
                usedAt: securityCreatedAt,
            })
        ).toBeDefined();
    });

    test.each([
        { id: "550e8400-e29b-41d4-a716-446655440000" },
        { selector: "A".repeat(32) },
        { selector: "a".repeat(31) },
        { usedAt: subMilliseconds(securityCreatedAt, 1) },
        { validatorHash: "not-an-argon-hash" },
        {
            validatorHash: validUserRecoveryCodeInsert.validatorHash.replace(
                "m=65536",
                "m=1048576"
            ),
        },
        { unexpected: true },
    ])("rejects invalid recovery-code row %#", (replacement) => {
        expect(() =>
            v.parse(userRecoveryCodeInsertSchema, {
                ...validUserRecoveryCodeInsert,
                ...replacement,
            })
        ).toThrow();
    });
});
