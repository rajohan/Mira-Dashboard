/**
 * Returns a lowercase hexadecimal SHA-256 digest for server-side content.
 * @param value Content to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Hex(value: string | Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
