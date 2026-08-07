import * as v from "valibot";

import {
    lowercaseSha256Schema,
    positiveSafeIntegerSchema,
} from "../../shared/validation.ts";

const randomByteLengthSchema = v.pipe(
    positiveSafeIntegerSchema("Random byte length is invalid"),
    v.maxValue(1024, "Random byte length is invalid")
);
const sha256DigestSchema = lowercaseSha256Schema();

/**
 * Returns a lowercase hexadecimal SHA-256 digest for server-side content.
 * @param value Content to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Hex(value: string | Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Generates a bounded number of cryptographically secure random bytes as lowercase hex.
 * @param byteLength Number of random bytes to generate.
 * @returns Random bytes encoded as lowercase hexadecimal text.
 */
export function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(v.parse(randomByteLengthSchema, byteLength));
    crypto.getRandomValues(bytes);
    return bytes.toHex();
}

/**
 * Compares two canonical SHA-256 digests without content-dependent early exit.
 * Malformed values are rejected before the fixed-length comparison.
 * @param left First lowercase SHA-256 digest.
 * @param right Second lowercase SHA-256 digest.
 * @returns Whether both canonical digests contain the same bytes.
 */
export function areSha256DigestsEqual(left: string, right: string): boolean {
    if (
        !v.safeParse(sha256DigestSchema, left).success ||
        !v.safeParse(sha256DigestSchema, right).success
    ) {
        return false;
    }
    return crypto.timingSafeEqual(Uint8Array.fromHex(left), Uint8Array.fromHex(right));
}
