import { describe, expect, test } from "bun:test";

import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    automationPrincipalInsertSchema,
    automationPrincipalSelectSchema,
} from "./automationPrincipals.ts";
import {
    securityCreatedAt,
    validAutomationPrincipalInsert,
} from "./testSupport/securityRows.ts";

describe("automation principal row schemas", () => {
    test("accepts one named principal independently of credentials", () => {
        expect(
            v.parse(automationPrincipalInsertSchema, validAutomationPrincipalInsert)
        ).toEqual(validAutomationPrincipalInsert);
        expect(
            v.parse(automationPrincipalSelectSchema, {
                ...validAutomationPrincipalInsert,
                authorizationVersion: 1,
                disabledAt: null,
            })
        ).toBeDefined();
        for (const authorizationVersion of [0, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() =>
                v.parse(automationPrincipalSelectSchema, {
                    ...validAutomationPrincipalInsert,
                    authorizationVersion,
                    disabledAt: null,
                })
            ).toThrow();
        }
    });

    test("keeps authorizationVersion database-owned on insert", () => {
        expect(() =>
            v.parse(automationPrincipalInsertSchema, {
                ...validAutomationPrincipalInsert,
                authorizationVersion: 1,
            })
        ).toThrow();
    });

    test.each([
        { id: "Uppercase" },
        { id: "-leading" },
        { id: "openclaw-task-tracking\0suffix" },
        { label: "   " },
        { label: "\t\n" },
        { label: "OpenClaw\u0007tracking" },
        { label: "OpenClaw\u200Btracking" },
        { updatedAt: subMilliseconds(securityCreatedAt, 1) },
    ])("rejects invalid automation principal %#", (replacement) => {
        expect(() =>
            v.parse(automationPrincipalInsertSchema, {
                ...validAutomationPrincipalInsert,
                ...replacement,
            })
        ).toThrow();
    });
});
