import { describe, expect, test } from "bun:test";

import { addMilliseconds } from "date-fns";

import { validUserWebAuthnCredentialInsert } from "../../../../database/validation/testSupport/securityRows.ts";
import type { MfaWebAuthnCredentialRecord } from "../lifecycleRepositoryTypes.ts";
import {
    webAuthnCredentialDescriptor,
    webAuthnCredentialSnapshotMatches,
    webAuthnCredentialSummary,
    webAuthnStoredCredential,
    webAuthnTransportMask,
    webAuthnTransportsFromMask,
} from "./credentialState.ts";

const credential: MfaWebAuthnCredentialRecord = {
    ...validUserWebAuthnCredentialInsert,
    publicKey: Buffer.from(validUserWebAuthnCredentialInsert.publicKey),
};

describe("WebAuthn credential state", () => {
    test("round-trips the canonical transport bit mapping", () => {
        const mask = webAuthnTransportMask(["usb", "ble", "hybrid"]);

        expect(mask).toBe(69);
        expect(webAuthnTransportsFromMask(mask)).toEqual(["ble", "hybrid", "usb"]);
        expect(() => webAuthnTransportMask(["usb", "usb"])).toThrow();
        expect(() => webAuthnTransportsFromMask(128)).toThrow();
    });

    test("creates public summaries and verifier-owned byte copies", () => {
        const withUsage = {
            ...credential,
            lastUsedAt: addMilliseconds(credential.createdAt, 1),
            transportMask: webAuthnTransportMask(["nfc", "usb"]),
        };
        const descriptor = webAuthnCredentialDescriptor(withUsage);
        const summary = webAuthnCredentialSummary(withUsage, withUsage.rpId);
        const stored = webAuthnStoredCredential(withUsage);

        expect(descriptor).toEqual({
            id: credential.credentialId,
        });
        expect(webAuthnCredentialSummary(withUsage, "drifted.example").usable).toBe(
            false
        );
        expect(summary).toMatchObject({
            backedUp: false,
            deviceType: "singleDevice",
            id: credential.id,
            label: credential.label,
            transports: ["nfc", "usb"],
            usable: true,
        });
        expect(summary.lastUsedAtMs).toBe(withUsage.lastUsedAt.getTime());
        expect(stored).toMatchObject({
            algorithm: -7,
            counter: 0,
            deviceType: "singleDevice",
            id: credential.credentialId,
            rpId: credential.rpId,
            transports: ["nfc", "usb"],
        });
        expect(stored.publicKey).not.toBe(credential.publicKey);
        expect(stored.publicKey).toEqual(credential.publicKey);
    });

    test("matches the complete credential snapshot", () => {
        expect(webAuthnCredentialSnapshotMatches({ ...credential }, credential)).toBe(
            true
        );
        expect(
            webAuthnCredentialSnapshotMatches(
                { ...credential, publicKey: Buffer.from([0]) },
                credential
            )
        ).toBe(false);
        expect(
            webAuthnCredentialSnapshotMatches(
                { ...credential, counter: credential.counter + 1 },
                credential
            )
        ).toBe(false);
        expect(webAuthnCredentialSnapshotMatches(undefined, credential)).toBe(false);
    });
});
