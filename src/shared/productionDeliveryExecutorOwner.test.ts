import { describe, expect, test } from "bun:test";

import {
    parseProductionDeliveryExecutorOwner,
    serializeProductionDeliveryExecutorOwner,
} from "./productionDeliveryExecutorOwner.ts";

const owner = {
    formatVersion: 1,
    releaseId: "a".repeat(40),
    runtimeRevision: "b".repeat(40),
    transitionId: "018f0000-0000-7000-8000-000000000001",
} as const;

describe("Production Delivery executor owner", () => {
    test("accepts and freezes the stable owner record", () => {
        const parsed = parseProductionDeliveryExecutorOwner(owner);
        expect(parsed).toEqual(owner);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(serializeProductionDeliveryExecutorOwner(parsed)).toBe(
            `${JSON.stringify(owner)}\n`
        );
    });

    test("rejects unknown fields and malformed identities", () => {
        expect(() =>
            parseProductionDeliveryExecutorOwner({ ...owner, future: true })
        ).toThrow("Production Delivery executor owner is invalid");
        expect(() =>
            parseProductionDeliveryExecutorOwner({ ...owner, releaseId: "no" })
        ).toThrow("Production Delivery executor owner is invalid");
    });
});
