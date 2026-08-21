import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    automationPrincipalCapabilityInsertSchema,
    automationPrincipalCapabilitySelectSchema,
} from "./automationPrincipalCapabilities.ts";
import { validAutomationCapabilityInsert } from "./testSupport/securityRows.ts";

describe("automation principal capability row schemas", () => {
    test("accepts only capabilities registered by the application", () => {
        expect(
            v.parse(
                automationPrincipalCapabilityInsertSchema,
                validAutomationCapabilityInsert
            )
        ).toEqual(validAutomationCapabilityInsert);
        expect(
            v.parse(
                automationPrincipalCapabilitySelectSchema,
                validAutomationCapabilityInsert
            )
        ).toBeDefined();
        expect(() =>
            v.parse(automationPrincipalCapabilityInsertSchema, {
                ...validAutomationCapabilityInsert,
                capability: "root:everything",
            })
        ).toThrow();
    });
});
