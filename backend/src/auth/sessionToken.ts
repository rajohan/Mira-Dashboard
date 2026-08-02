const SESSION_TOKEN_PATTERN = /^([a-f0-9]{32})\.([a-f0-9]{64})$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Returns cryptographically secure random bytes as lowercase hex.
 * @param byteLength Number of random bytes.
 * @returns Random bytes encoded as lowercase hex.
 */
export function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes.toHex();
}

export function hashSessionValidator(validator: string): string {
    return new Bun.CryptoHasher("sha256").update(validator).digest("hex");
}

export function parseSessionToken(
    sessionToken: string
): { selector: string; validatorHash: string } | undefined {
    const match = sessionToken.match(SESSION_TOKEN_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    if (!selector || !validator) {
        return undefined;
    }
    return { selector, validatorHash: hashSessionValidator(validator) };
}

/**
 * Returns the non-secret selector portion of a valid session token.
 * @param sessionToken Session token value.
 * @returns the non-secret selector portion of a valid session token.
 */
export function sessionSelectorFromToken(sessionToken: string): string | undefined {
    return parseSessionToken(sessionToken)?.selector;
}

export function areSessionHashesEqual(
    storedHash: string,
    candidateHash: string
): boolean {
    if (
        !SESSION_HASH_PATTERN.test(storedHash) ||
        !SESSION_HASH_PATTERN.test(candidateHash)
    ) {
        return false;
    }
    return crypto.timingSafeEqual(
        Uint8Array.fromHex(storedHash),
        Uint8Array.fromHex(candidateHash)
    );
}
