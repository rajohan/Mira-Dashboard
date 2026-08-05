import { describe, expect, test } from "bun:test";

import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    automationCredentialInsertSchema,
    automationCredentialSelectSchema,
} from "./automationCredentials.ts";
import {
    securityCreatedAt,
    validAutomationCredentialInsert,
} from "./testSupport/securityRows.ts";

describe("automation credential row schemas", () => {
    test("accepts a versioned hash and non-secret lookup prefix", () => {
        expect(
            v.parse(automationCredentialInsertSchema, validAutomationCredentialInsert)
        ).toEqual(validAutomationCredentialInsert);
        expect(
            v.parse(automationCredentialSelectSchema, {
                ...validAutomationCredentialInsert,
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
                validatorVersion: 1,
            })
        ).toBeDefined();
    });

    test.each([
        { prefix: "C".repeat(32) },
        { prefix: `${"c".repeat(32)}\0suffix` },
        { validatorHash: "d".repeat(63) },
        { validatorHash: `${"d".repeat(64)}\0suffix` },
        { label: "\0" },
        { label: "\u3000" },
        { expiresAt: securityCreatedAt },
        { lastUsedAt: subMilliseconds(securityCreatedAt, 1) },
        { revokedAt: subMilliseconds(securityCreatedAt, 1) },
    ])("rejects invalid automation credential %#", (replacement) => {
        expect(() =>
            v.parse(automationCredentialInsertSchema, {
                ...validAutomationCredentialInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test("keeps validatorVersion database-owned on insert", () => {
        expect(() =>
            v.parse(automationCredentialInsertSchema, {
                ...validAutomationCredentialInsert,
                validatorVersion: 1,
            })
        ).toThrow();
    });
});
