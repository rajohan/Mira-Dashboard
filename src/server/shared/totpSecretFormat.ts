/** Maximum canonical non-secret key-id length for encrypted TOTP factors. */
export const totpEncryptionKeyIdMaximumLength = 32;
/** Canonical non-secret key-id representation for encrypted TOTP factors. */
export const totpEncryptionKeyIdPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
/** Exact v1 AES-GCM envelope length: version, nonce, and sealed secret. */
export const totpEncryptedSecretEnvelopeLength = 84;
/** Canonical v1 nonce and ciphertext-plus-tag envelope representation. */
export const totpEncryptedSecretEnvelopePattern =
    /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/u;
