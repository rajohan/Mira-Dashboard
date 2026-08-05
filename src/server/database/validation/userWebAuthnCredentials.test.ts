import { describe, expect, test } from "bun:test";

import { addMilliseconds, subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    securityCreatedAt,
    validUserWebAuthnCredentialInsert,
} from "./testSupport/securityRows.ts";
import {
    userWebAuthnCredentialInsertSchema,
    userWebAuthnCredentialSelectSchema,
} from "./userWebAuthnCredentials.ts";

describe("WebAuthn credential row schemas", () => {
    test("accepts roaming and backed-up multi-device credentials", () => {
        expect(
            v.parse(userWebAuthnCredentialInsertSchema, validUserWebAuthnCredentialInsert)
        ).toEqual(validUserWebAuthnCredentialInsert);
        expect(
            v.parse(userWebAuthnCredentialSelectSchema, {
                ...validUserWebAuthnCredentialInsert,
                backedUp: true,
                deviceType: "multiDevice",
                lastUsedAt: addMilliseconds(securityCreatedAt, 1),
            })
        ).toBeDefined();
    });

    test.each([
        { algorithm: -257 },
        { counter: -1 },
        { counter: 1.5 },
        { counter: 4_294_967_296 },
        { credentialId: "A".repeat(7) },
        { credentialId: `${"A".repeat(8)}=` },
        { credentialId: `${"A".repeat(9)}B` },
        { credentialId: "A".repeat(1025) },
        { backedUp: true, deviceType: "singleDevice" },
        { deviceType: "unknown" },
        { id: "550e8400-e29b-41d4-a716-446655440000" },
        { label: "Security key\u200B" },
        { label: "a".repeat(129) },
        { lastUsedAt: subMilliseconds(securityCreatedAt, 1) },
        { publicKey: Buffer.alloc(0) },
        { publicKey: Buffer.alloc(2049) },
        { publicKey: new Uint8Array([1, 2, 3]) },
        { rpId: "Dashboard.EXAMPLE.com" },
        { rpId: "a".repeat(254) },
        { transportMask: -1 },
        { transportMask: 128 },
        { transportMask: 1.5 },
        { unexpected: true },
    ])("rejects invalid credential row %#", (replacement) => {
        expect(() =>
            v.parse(userWebAuthnCredentialInsertSchema, {
                ...validUserWebAuthnCredentialInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test("accepts uint32 and transport-bitmask boundaries", () => {
        expect(
            v.parse(userWebAuthnCredentialInsertSchema, {
                ...validUserWebAuthnCredentialInsert,
                counter: 4_294_967_295,
                transportMask: 127,
            })
        ).toBeDefined();
    });
});
