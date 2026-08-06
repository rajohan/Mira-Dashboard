import { sql, type SQLWrapper } from "drizzle-orm";

import {
    totpEncryptedSecretEnvelopeLength,
    totpEncryptionKeyIdMaximumLength,
} from "../../shared/totpSecretFormat.ts";
import { nulFreeTextCheck } from "./checks.ts";

/** Canonical identifier for one configured MFA secret-encryption key. */
export { totpEncryptionKeyIdPattern as mfaSecretKeyIdPattern } from "../../shared/totpSecretFormat.ts";
export const mfaSecretKeyIdMaximumLength = totpEncryptionKeyIdMaximumLength;

/** AES-256-GCM envelope: version, 12-byte nonce, then 32-byte ciphertext + tag. */
export { totpEncryptedSecretEnvelopePattern as encryptedTotpSecretEnvelopePattern } from "../../shared/totpSecretFormat.ts";
export const encryptedTotpSecretEnvelopeLength = totpEncryptedSecretEnvelopeLength;

/**
 * Builds the SQLite boundary for one non-secret encryption-key identifier.
 * @returns SQL predicate enforcing the canonical key-identifier boundary.
 */
export function mfaSecretKeyIdCheck(column: SQLWrapper) {
    return sql`length(${column}) BETWEEN 1 AND ${sql.raw(String(mfaSecretKeyIdMaximumLength))} AND ${nulFreeTextCheck(column)} AND ${column} = lower(${column}) AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9_-]*'`;
}

/**
 * Builds the SQLite boundary for one exact v1 TOTP ciphertext envelope.
 * @returns SQL predicate enforcing the exact encrypted-envelope boundary.
 */
export function encryptedTotpSecretEnvelopeCheck(column: SQLWrapper) {
    return sql`length(${column}) = ${sql.raw(String(encryptedTotpSecretEnvelopeLength))} AND ${nulFreeTextCheck(column)} AND substr(${column}, 1, 3) = 'v1.' AND substr(${column}, 4, 16) NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${column}, 20, 1) = '.' AND substr(${column}, 21, 64) NOT GLOB '*[^A-Za-z0-9_-]*'`;
}
