import { describe, expect, test } from "bun:test";

import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    automationCredentialInsertSchema,
    automationCredentialSelectSchema,
} from "./automationCredentials.ts";
import {
    automationReplacementSourceCredentialId,
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
                revokedAt: null,
                validatorVersion: 1,
            })
        ).toBeDefined();
        expect(
            v.parse(automationCredentialInsertSchema, {
                ...validAutomationCredentialInsert,
                replacesCredentialId: automationReplacementSourceCredentialId,
            }).replacesCredentialId
        ).toBe(automationReplacementSourceCredentialId);
    });

    test.each([
        { prefix: "C".repeat(32) },
        { prefix: `${"c".repeat(32)}\0suffix` },
        { validatorHash: "d".repeat(63) },
        { validatorHash: `${"d".repeat(64)}\0suffix` },
        { label: "\0" },
        { label: "Primary\u0007credential" },
        { label: "Primary\u200Bcredential" },
        { label: "\u3000" },
        { expiresAt: securityCreatedAt },
        { replacesCredentialId: "not-a-credential-id" },
        { replacesCredentialId: validAutomationCredentialInsert.id },
        { revokedAt: subMilliseconds(securityCreatedAt, 1) },
    ])("rejects invalid automation credential %#", (replacement) => {
        expect(() =>
            v.parse(automationCredentialInsertSchema, {
                ...validAutomationCredentialInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test("rejects the removed lastUsedAt column", () => {
        expect(() =>
            v.parse(automationCredentialInsertSchema, {
                ...validAutomationCredentialInsert,
                lastUsedAt: null,
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
