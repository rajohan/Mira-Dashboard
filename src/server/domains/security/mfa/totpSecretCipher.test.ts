import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { captureFailure } from "../../../test/support/promise.ts";
import {
    createTotpSecretCipher,
    encryptedTotpSecretEnvelopeSchema,
    totpEncryptionKeyIdSchema,
} from "./totpSecretCipher.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const factorId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";
const otherFactorId = "019fc968-1a9b-7772-af1b-d5b863b0e7b4";
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function encryptionKey(byte: number): string {
    return new Uint8Array(32).fill(byte).toBase64();
}

function keyRing(
    activeKeyId = "primary-2026-08",
    keys = [
        {
            id: "primary-2026-08",
            keyBase64: encryptionKey(7),
        },
    ]
): string {
    return JSON.stringify({ activeKeyId, formatVersion: 1, keys });
}

describe("TOTP secret cipher", () => {
    test("round-trips one exact canonical envelope bound to its storage context", async () => {
        const cipher = await createTotpSecretCipher(keyRing(), {
            randomBytes: (byteLength) => {
                expect(byteLength).toBe(12);
                return new Uint8Array(byteLength).fill(9);
            },
        });

        const encrypted = await cipher.encrypt(totpSecret, { factorId, userId });

        expect(encrypted.keyId).toBe("primary-2026-08");
        expect(encrypted.envelope).toHaveLength(84);
        expect(encrypted.envelope).toStartWith("v1.CQkJCQkJCQkJCQkJ.");
        expect(
            v.safeParse(encryptedTotpSecretEnvelopeSchema, encrypted.envelope).success
        ).toBeTrue();
        expect(encrypted.envelope).not.toContain(totpSecret);
        expect(await cipher.decrypt(encrypted, { factorId, userId })).toBe(totpSecret);
        expect(cipher.hasKey("primary-2026-08")).toBeTrue();
        expect(cipher.hasKey("missing")).toBeFalse();
    });

    test("fails generically for wrong context, key reference, and tampering", async () => {
        const cipher = await createTotpSecretCipher(keyRing(), {
            randomBytes: () => new Uint8Array(12).fill(3),
        });
        const wrongKeyCipher = await createTotpSecretCipher(
            keyRing("primary-2026-08", [
                {
                    id: "primary-2026-08",
                    keyBase64: encryptionKey(8),
                },
            ])
        );
        const encrypted = await cipher.encrypt(totpSecret, { factorId, userId });
        const finalCharacter = encrypted.envelope.at(-1);
        const tamperedEnvelope = `${encrypted.envelope.slice(0, -1)}${
            finalCharacter === "A" ? "B" : "A"
        }`;

        for (const operation of [
            () => cipher.decrypt(encrypted, { factorId: otherFactorId, userId }),
            () => wrongKeyCipher.decrypt(encrypted, { factorId, userId }),
            () =>
                cipher.decrypt({ ...encrypted, keyId: "missing" }, { factorId, userId }),
            () =>
                cipher.decrypt(
                    { ...encrypted, envelope: tamperedEnvelope },
                    { factorId, userId }
                ),
            () =>
                cipher.decrypt(
                    { ...encrypted, envelope: "plaintext" },
                    { factorId, userId }
                ),
        ]) {
            const failure = await captureFailure(operation);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe("TOTP secret is unavailable");
        }
    });

    test("decrypts retiring keys while encrypting only with the active key", async () => {
        const configuredKeys = [
            { id: "old", keyBase64: encryptionKey(4) },
            { id: "new", keyBase64: encryptionKey(5) },
        ];
        const oldCipher = await createTotpSecretCipher(keyRing("old", configuredKeys), {
            randomBytes: () => new Uint8Array(12).fill(1),
        });
        const oldEncrypted = await oldCipher.encrypt(totpSecret, { factorId, userId });
        const rotatingCipher = await createTotpSecretCipher(
            keyRing("new", configuredKeys),
            { randomBytes: () => new Uint8Array(12).fill(2) }
        );

        expect(await rotatingCipher.decrypt(oldEncrypted, { factorId, userId })).toBe(
            totpSecret
        );
        const rewrapped = await rotatingCipher.encrypt(totpSecret, {
            factorId,
            userId,
        });
        expect(rewrapped.keyId).toBe("new");
        expect(rewrapped.envelope).not.toBe(oldEncrypted.envelope);
    });

    test("rejects malformed or ambiguous keyrings without echoing key material", async () => {
        const invalidKeyRings = [
            undefined,
            "not-json",
            JSON.stringify({
                activeKeyId: "missing",
                formatVersion: 1,
                keys: [{ id: "only", keyBase64: encryptionKey(1) }],
            }),
            keyRing("duplicate", [
                { id: "duplicate", keyBase64: encryptionKey(1) },
                { id: "duplicate", keyBase64: encryptionKey(2) },
            ]),
            keyRing("first", [
                { id: "first", keyBase64: encryptionKey(1) },
                { id: "second", keyBase64: encryptionKey(1) },
            ]),
            keyRing("bad", [{ id: "bad", keyBase64: "A".repeat(44) }]),
            JSON.stringify({
                activeKeyId: "only",
                extra: true,
                formatVersion: 1,
                keys: [{ id: "only", keyBase64: encryptionKey(1) }],
            }),
            " ".repeat(4097),
        ];

        for (const serialized of invalidKeyRings) {
            const failure = await captureFailure(() =>
                createTotpSecretCipher(serialized)
            );
            expect(failure).toBeInstanceOf(TypeError);
            expect((failure as Error).message).toBe("TOTP encryption keyring is invalid");
            expect((failure as Error).message).not.toContain(encryptionKey(1));
        }
    });

    test("exports persistence validators for key ids and envelopes", async () => {
        const cipher = await createTotpSecretCipher(keyRing(), {
            randomBytes: () => new Uint8Array(12).fill(6),
        });
        const encrypted = await cipher.encrypt(totpSecret, { factorId, userId });

        expect(
            v.safeParse(totpEncryptionKeyIdSchema, encrypted.keyId).success
        ).toBeTrue();
        expect(v.safeParse(totpEncryptionKeyIdSchema, "Uppercase").success).toBeFalse();
        expect(
            v.safeParse(encryptedTotpSecretEnvelopeSchema, encrypted.envelope).success
        ).toBeTrue();
        expect(
            v.safeParse(encryptedTotpSecretEnvelopeSchema, `${encrypted.envelope}=`)
                .success
        ).toBeFalse();
    });
});
