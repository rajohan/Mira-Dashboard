import * as v from "valibot";

import { securityRecordIdSchema } from "../../../../contracts/security.ts";
import {
    totpEncryptedSecretEnvelopeLength,
    totpEncryptedSecretEnvelopePattern,
    totpEncryptionKeyIdMaximumLength,
    totpEncryptionKeyIdPattern,
} from "../../../shared/totpSecretFormat.ts";
import { isCanonicalTotpSecret } from "./totp.ts";

const encryptionKeyByteLength = 32;
const encryptionKeyRingMaximumBytes = 4 * 1024;
const encryptionKeyRingMaximumKeys = 8;
const aesGcmNonceByteLength = 12;
const aesGcmTagLengthBits = 128;
/** Minimum canonical TOTP key-id length shared with the SQLite boundary. */
export const totpEncryptionKeyIdMinimumLength = 1;
export {
    totpEncryptedSecretEnvelopeLength,
    totpEncryptedSecretEnvelopePattern,
    totpEncryptionKeyIdMaximumLength,
    totpEncryptionKeyIdPattern,
} from "../../../shared/totpSecretFormat.ts";
const encodedEncryptionKeyPattern = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u;

/** Stable, non-secret identifier for one TOTP encryption key. */
export const totpEncryptionKeyIdSchema = v.pipe(
    v.string("TOTP encryption key id is invalid"),
    v.minLength(totpEncryptionKeyIdMinimumLength, "TOTP encryption key id is invalid"),
    v.maxLength(totpEncryptionKeyIdMaximumLength, "TOTP encryption key id is invalid"),
    v.regex(totpEncryptionKeyIdPattern, "TOTP encryption key id is invalid")
);

/** Canonical versioned AES-256-GCM envelope stored beside its key id. */
export const encryptedTotpSecretEnvelopeSchema = v.pipe(
    v.string("Encrypted TOTP secret is invalid"),
    v.length(totpEncryptedSecretEnvelopeLength, "Encrypted TOTP secret is invalid"),
    v.regex(totpEncryptedSecretEnvelopePattern, "Encrypted TOTP secret is invalid")
);

const encodedEncryptionKeySchema = v.pipe(
    v.string("TOTP encryption key is invalid"),
    v.length(44, "TOTP encryption key is invalid"),
    v.regex(encodedEncryptionKeyPattern, "TOTP encryption key is invalid")
);

const encryptionKeyRingEntrySchema = v.strictObject({
    id: totpEncryptionKeyIdSchema,
    keyBase64: encodedEncryptionKeySchema,
});

const encryptionKeysSchema = v.pipe(
    v.array(encryptionKeyRingEntrySchema, "TOTP encryption keys are invalid"),
    v.minLength(1, "TOTP encryption keyring must contain a key"),
    v.maxLength(
        encryptionKeyRingMaximumKeys,
        "TOTP encryption keyring contains too many keys"
    )
);

const encryptionKeyRingSchema = v.pipe(
    v.strictObject({
        activeKeyId: totpEncryptionKeyIdSchema,
        formatVersion: v.literal(1, "TOTP encryption keyring version is invalid"),
        keys: encryptionKeysSchema,
    }),
    v.check((keyRing) => {
        const keyIds = new Set(keyRing.keys.map((key) => key.id));
        const keyValues = new Set(keyRing.keys.map((key) => key.keyBase64));
        return (
            keyIds.size === keyRing.keys.length &&
            keyValues.size === keyRing.keys.length &&
            keyIds.has(keyRing.activeKeyId)
        );
    }, "TOTP encryption keyring is inconsistent")
);

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

function invalidKeyRingError(): TypeError {
    return new TypeError("TOTP encryption keyring is invalid");
}

function secretUnavailableError(): Error {
    return new Error("TOTP secret is unavailable");
}

function canonicalBase64Url(bytes: Uint8Array): string {
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function decodeCanonicalBase64Url(
    value: string,
    expectedByteLength: number
): Uint8Array<ArrayBuffer> | undefined {
    try {
        const bytes = new Uint8Array(
            Uint8Array.fromBase64(value, { alphabet: "base64url" })
        );
        return bytes.byteLength === expectedByteLength &&
            canonicalBase64Url(bytes) === value
            ? bytes
            : undefined;
    } catch {
        return undefined;
    }
}

function decodeCanonicalEncryptionKey(value: string): Uint8Array<ArrayBuffer> {
    try {
        const bytes = new Uint8Array(Uint8Array.fromBase64(value));
        if (bytes.byteLength !== encryptionKeyByteLength || bytes.toBase64() !== value) {
            throw invalidKeyRingError();
        }
        return bytes;
    } catch {
        throw invalidKeyRingError();
    }
}

function parseKeyRing(serializedKeyRing: unknown) {
    if (
        typeof serializedKeyRing !== "string" ||
        serializedKeyRing.length > encryptionKeyRingMaximumBytes ||
        textEncoder.encode(serializedKeyRing).byteLength > encryptionKeyRingMaximumBytes
    ) {
        throw invalidKeyRingError();
    }
    try {
        return v.parse(encryptionKeyRingSchema, JSON.parse(serializedKeyRing));
    } catch {
        throw invalidKeyRingError();
    }
}

function isCanonicalSecurityRecordId(value: string): boolean {
    return v.safeParse(securityRecordIdSchema, value, { abortEarly: true }).success;
}

function associatedData(
    keyId: string,
    userId: string,
    factorId: string
): Uint8Array<ArrayBuffer> {
    if (
        !v.safeParse(totpEncryptionKeyIdSchema, keyId, { abortEarly: true }).success ||
        !isCanonicalSecurityRecordId(userId) ||
        !isCanonicalSecurityRecordId(factorId)
    ) {
        throw new TypeError("TOTP secret storage context is invalid");
    }
    return textEncoder.encode(
        `mira-dashboard:totp-secret:v1:key:${keyId}:user:${userId}:factor:${factorId}`
    );
}

interface ParsedEnvelope {
    readonly nonce: Uint8Array<ArrayBuffer>;
    readonly sealed: Uint8Array<ArrayBuffer>;
}

function parseEnvelope(value: unknown): ParsedEnvelope | undefined {
    const parsed = v.safeParse(encryptedTotpSecretEnvelopeSchema, value, {
        abortEarly: true,
    });
    if (!parsed.success) return undefined;
    const nonce = decodeCanonicalBase64Url(parsed.output.slice(3, 19), 12);
    const sealed = decodeCanonicalBase64Url(parsed.output.slice(20), 48);
    return nonce === undefined || sealed === undefined ? undefined : { nonce, sealed };
}

/** Ciphertext and non-secret key reference persisted for one TOTP factor. */
export interface EncryptedTotpSecret {
    readonly envelope: string;
    readonly keyId: string;
}

export interface TotpSecretStorageContext {
    readonly factorId: string;
    readonly userId: string;
}

export interface TotpSecretCipher {
    readonly activeKeyId: string;
    decrypt(
        encrypted: EncryptedTotpSecret,
        context: TotpSecretStorageContext
    ): Promise<string>;
    encrypt(
        secret: string,
        context: TotpSecretStorageContext
    ): Promise<EncryptedTotpSecret>;
    hasKey(keyId: string): boolean;
}

export interface TotpSecretCipherOptions {
    readonly randomBytes?: (byteLength: number) => Uint8Array;
}

/**
 * Imports a strict, bounded keyring and creates the TOTP secret cipher.
 * @param serializedKeyRing Versioned keyring JSON from the process composition root.
 * @param options Injectable secure randomness for deterministic tests.
 * @returns Non-extractable AES-256-GCM keyring facade.
 */
export async function createTotpSecretCipher(
    serializedKeyRing: unknown,
    options: TotpSecretCipherOptions = {}
): Promise<TotpSecretCipher> {
    const keyRing = parseKeyRing(serializedKeyRing);
    const activeKeyId = keyRing.activeKeyId;
    const keys = new Map<string, CryptoKey>();
    try {
        for (const configuredKey of keyRing.keys) {
            const keyBytes = decodeCanonicalEncryptionKey(configuredKey.keyBase64);
            try {
                keys.set(
                    configuredKey.id,
                    await crypto.subtle.importKey(
                        "raw",
                        keyBytes,
                        { length: 256, name: "AES-GCM" },
                        false,
                        ["decrypt", "encrypt"]
                    )
                );
            } finally {
                keyBytes.fill(0);
            }
        }
    } catch {
        throw invalidKeyRingError();
    }

    const randomBytes =
        options.randomBytes ??
        ((byteLength: number): Uint8Array => {
            const bytes = new Uint8Array(byteLength);
            crypto.getRandomValues(bytes);
            return bytes;
        });

    return Object.freeze({
        activeKeyId,

        async decrypt(
            encrypted: EncryptedTotpSecret,
            context: TotpSecretStorageContext
        ): Promise<string> {
            try {
                const key = keys.get(encrypted.keyId);
                const parsedEnvelope = parseEnvelope(encrypted.envelope);
                if (key === undefined || parsedEnvelope === undefined) {
                    throw secretUnavailableError();
                }
                const plaintext = new Uint8Array(
                    await crypto.subtle.decrypt(
                        {
                            additionalData: associatedData(
                                encrypted.keyId,
                                context.userId,
                                context.factorId
                            ),
                            iv: parsedEnvelope.nonce,
                            name: "AES-GCM",
                            tagLength: aesGcmTagLengthBits,
                        },
                        key,
                        parsedEnvelope.sealed
                    )
                );
                try {
                    const secret = fatalTextDecoder.decode(plaintext);
                    if (!isCanonicalTotpSecret(secret)) {
                        throw secretUnavailableError();
                    }
                    return secret;
                } finally {
                    plaintext.fill(0);
                }
            } catch {
                throw secretUnavailableError();
            }
        },

        async encrypt(
            secret: string,
            context: TotpSecretStorageContext
        ): Promise<EncryptedTotpSecret> {
            if (!isCanonicalTotpSecret(secret)) {
                throw new TypeError("TOTP secret is invalid");
            }
            const key = keys.get(activeKeyId);
            if (key === undefined) throw new Error("TOTP encryption key is unavailable");
            const aad = associatedData(activeKeyId, context.userId, context.factorId);
            const nonce = new Uint8Array(randomBytes(aesGcmNonceByteLength));
            if (nonce.byteLength !== aesGcmNonceByteLength) {
                throw new Error("TOTP encryption randomness is invalid");
            }
            const plaintext = textEncoder.encode(secret);
            try {
                const sealed = new Uint8Array(
                    await crypto.subtle.encrypt(
                        {
                            additionalData: aad,
                            iv: nonce,
                            name: "AES-GCM",
                            tagLength: aesGcmTagLengthBits,
                        },
                        key,
                        plaintext
                    )
                );
                if (sealed.byteLength !== 48) {
                    throw new Error("TOTP encryption output is invalid");
                }
                return Object.freeze({
                    envelope: `v1.${canonicalBase64Url(nonce)}.${canonicalBase64Url(sealed)}`,
                    keyId: activeKeyId,
                });
            } finally {
                plaintext.fill(0);
                nonce.fill(0);
            }
        },

        hasKey(keyId: string): boolean {
            return (
                v.safeParse(totpEncryptionKeyIdSchema, keyId, {
                    abortEarly: true,
                }).success && keys.has(keyId)
            );
        },
    });
}
