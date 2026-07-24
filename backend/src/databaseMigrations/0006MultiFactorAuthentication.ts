import type { DatabaseMigration } from "./types.ts";

export const multiFactorAuthenticationMigration: DatabaseMigration = {
    version: 6,
    name: "multi-factor-authentication",
    sql: `
ALTER TABLE users ADD COLUMN mfa_enabled_at TEXT;

ALTER TABLE auth_sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN authenticated_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN mfa_verified_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN elevated_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN auth_method TEXT
    CHECK (auth_method IN ('password', 'recovery', 'totp', 'webauthn'));
ALTER TABLE auth_sessions ADD COLUMN elevated_method TEXT
    CHECK (elevated_method IN ('password', 'recovery', 'totp', 'webauthn'));
ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT;

-- Pre-v6 sessions either stored a reusable token directly or lack the
-- authentication metadata required by the new idle/MFA policy.
DELETE FROM auth_sessions;

CREATE TABLE auth_pending_logins (
    id TEXT PRIMARY KEY,
    validator_hash TEXT NOT NULL
        CHECK (length(validator_hash) = 64),
    user_id INTEGER NOT NULL,
    methods_json TEXT NOT NULL
        CHECK (json_valid(methods_json) AND json_type(methods_json) = 'array'),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    user_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_auth_pending_logins_user
    ON auth_pending_logins(user_id, expires_at DESC);

CREATE INDEX idx_auth_pending_logins_expires
    ON auth_pending_logins(expires_at);

CREATE TABLE auth_webauthn_challenges (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT,
    pending_login_id TEXT,
    purpose TEXT NOT NULL
        CHECK (purpose IN ('login', 'registration', 'step-up')),
    challenge TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK (
        (session_id IS NOT NULL AND pending_login_id IS NULL)
        OR (session_id IS NULL AND pending_login_id IS NOT NULL)
    ),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(pending_login_id) REFERENCES auth_pending_logins(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_auth_webauthn_challenges_expires
    ON auth_webauthn_challenges(expires_at);

CREATE TABLE user_totp_factors (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    last_used_step INTEGER,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_user_totp_factors_user
    ON user_totp_factors(user_id, confirmed_at DESC, created_at DESC);

CREATE TABLE user_webauthn_credentials (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL
        CHECK (counter >= 0),
    transports_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(transports_json) AND json_type(transports_json) = 'array'),
    device_type TEXT NOT NULL
        CHECK (device_type IN ('multiDevice', 'singleDevice')),
    backed_up INTEGER NOT NULL
        CHECK (backed_up IN (0, 1)),
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_user_webauthn_credentials_user
    ON user_webauthn_credentials(user_id, created_at DESC);

CREATE TABLE user_recovery_codes (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    validator_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_user_recovery_codes_user
    ON user_recovery_codes(user_id, used_at, created_at DESC);

CREATE TABLE auth_rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY
        CHECK (length(bucket_key) = 64),
    failure_count INTEGER NOT NULL
        CHECK (failure_count >= 1),
    first_failed_at TEXT NOT NULL,
    blocked_until TEXT,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_rate_limit_buckets_updated
    ON auth_rate_limit_buckets(updated_at);
`,
};
