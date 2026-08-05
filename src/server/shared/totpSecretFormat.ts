import * as v from "valibot";

/** Minimum canonical non-secret key-id length for encrypted TOTP factors. */
export const totpEncryptionKeyIdMinimumLength = 1;
/** Maximum canonical non-secret key-id length for encrypted TOTP factors. */
export const totpEncryptionKeyIdMaximumLength = 32;
/** Canonical non-secret key-id representation for encrypted TOTP factors. */
export const totpEncryptionKeyIdPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
/** Exact v1 AES-GCM envelope length: version, nonce, and sealed secret. */
export const totpEncryptedSecretEnvelopeLength = 84;
/** Canonical v1 nonce and ciphertext-plus-tag envelope representation. */
export const totpEncryptedSecretEnvelopePattern =
    /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/u;

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
