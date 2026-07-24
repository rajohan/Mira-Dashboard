import { createCipheriv, createDecipheriv } from "node:crypto";

const SECRET_ENCRYPTION_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ENCRYPTED_VALUE_PATTERN = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/u;
const SHA256_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Returns cryptographically secure random bytes. */
export function randomBytes(byteLength: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes;
}

/** Returns cryptographically secure random bytes encoded as lowercase hex. */
export function randomHex(byteLength: number): string {
    return randomBytes(byteLength).toHex();
}

/** Returns a SHA-256 digest as lowercase hex. */
export function sha256Hex(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Compares two valid SHA-256 hex digests without timing-sensitive string equality. */
export function areTimingSafeHashesEqual(
    storedHash: string,
    candidateHash: string
): boolean {
    if (
        !SHA256_HASH_PATTERN.test(storedHash) ||
        !SHA256_HASH_PATTERN.test(candidateHash)
    ) {
        return false;
    }
    return crypto.timingSafeEqual(
        Uint8Array.fromHex(storedHash),
        Uint8Array.fromHex(candidateHash)
    );
}

function base64Url(bytes: Uint8Array): string {
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function bytesFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Uint8Array.fromBase64(value, { alphabet: "base64url" }));
}

/** Parses the external AES-256-GCM key without accepting ambiguous lengths. */
export function secretEncryptionKeyBytes(
    encodedKey = process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY
): Uint8Array<ArrayBuffer> {
    const normalized = encodedKey?.trim();
    if (!normalized) {
        throw new Error("MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY is not configured");
    }
    let key: Uint8Array;
    try {
        key = Uint8Array.fromBase64(normalized);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY must be valid base64");
    }
    if (key.byteLength !== SECRET_ENCRYPTION_KEY_BYTES) {
        throw new RangeError(
            `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY must decode to ${SECRET_ENCRYPTION_KEY_BYTES} bytes`
        );
    }
    return new Uint8Array(key);
}

/** Returns whether a value uses the supported versioned encrypted envelope. */
export function isEncryptedStoredSecret(value: string): boolean {
    return ENCRYPTED_VALUE_PATTERN.test(value);
}

/** Encrypts a stored secret with versioned AES-256-GCM envelope encryption. */
export function encryptStoredSecret(
    plaintext: string,
    associatedData: string,
    encodedKey?: string
): string {
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv(
        "aes-256-gcm",
        secretEncryptionKeyBytes(encodedKey),
        nonce,
        { authTagLength: AES_GCM_TAG_BYTES }
    );
    const plaintextBytes = new TextEncoder().encode(plaintext);
    cipher.setAAD(new TextEncoder().encode(associatedData), {
        plaintextLength: plaintextBytes.byteLength,
    });
    const ciphertext = Buffer.concat([
        cipher.update(plaintextBytes),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    return `v1.${base64Url(nonce)}.${base64Url(ciphertext)}`;
}

/** Decrypts one versioned stored secret and authenticates its storage context. */
export function decryptStoredSecret(
    envelope: string,
    associatedData: string,
    encodedKey?: string
): string {
    const match = envelope.match(ENCRYPTED_VALUE_PATTERN);
    const nonce = match?.[1];
    const ciphertext = match?.[2];
    if (!nonce || !ciphertext) {
        throw new TypeError("Unsupported stored-secret envelope");
    }
    try {
        const sealed = bytesFromBase64Url(ciphertext);
        if (sealed.byteLength <= AES_GCM_TAG_BYTES) {
            throw new TypeError("Encrypted secret is too short");
        }
        const ciphertextBytes = sealed.subarray(0, sealed.byteLength - AES_GCM_TAG_BYTES);
        const authTag = sealed.subarray(sealed.byteLength - AES_GCM_TAG_BYTES);
        const decipher = createDecipheriv(
            "aes-256-gcm",
            secretEncryptionKeyBytes(encodedKey),
            bytesFromBase64Url(nonce),
            { authTagLength: AES_GCM_TAG_BYTES }
        );
        decipher.setAAD(new TextEncoder().encode(associatedData), {
            plaintextLength: ciphertextBytes.byteLength,
        });
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
            decipher.update(ciphertextBytes),
            decipher.final(),
        ]);
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
        throw new Error("Failed to decrypt stored secret");
    }
}
