import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../test/support/securityPassword.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const factorId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";
const recoveryId = "019fc968-1a9b-7772-8f1b-d5b863b0e7b4";
const sessionId = "a".repeat(32);
const sessionValidatorHash = "b".repeat(64);
const pendingLoginId = "c".repeat(32);
const pendingValidatorHash = "d".repeat(64);
const recoverySelector = "e".repeat(32);
const encryptedTotpSecret = `v1.${"A".repeat(16)}.${"B".repeat(64)}`;

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

function insertMfaUser(database: FreshDatabase): void {
    database.sqlite.run(
        `INSERT INTO users (
            created_at,
            email,
            id,
            mfa_enabled_at,
            password_hash,
            updated_at,
            username
        ) VALUES (1000, lower(hex(randomblob(16))) || '@example.com', ?, 2000, ?, 2000, 'raymond')`,
        [userId, testDashboardPasswordHash]
    );
}

function insertMfaSession(database: FreshDatabase): void {
    database.sqlite.run(
        `INSERT INTO auth_sessions (
            authenticated_at,
            authentication_version,
            auth_method,
            created_at,
            expires_at,
            id,
            last_seen_at,
            mfa_verified_at,
            password_verified_at,
            user_id,
            validator_hash
        ) VALUES (1000, 1, 'totp', 2000, 10000, ?, 2000, 2000, 1000, ?, ?)`,
        [sessionId, userId, sessionValidatorHash]
    );
}

function insertPendingLogin(database: FreshDatabase): void {
    database.sqlite.run(
        `INSERT INTO auth_pending_logins (
            allows_recovery,
            allows_totp,
            allows_webauthn,
            authentication_version,
            created_at,
            expires_at,
            id,
            password_verified_at,
            replaced_session_id,
            user_id,
            validator_hash
        ) VALUES (1, 1, 1, 1, 2000, 301000, ?, 1000, ?, ?, ?)`,
        [pendingLoginId, sessionId, userId, pendingValidatorHash]
    );
}

describe("MFA lifecycle schema", () => {
    test("enforces coupled session and TOTP-factor state", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertMfaUser(database);
            insertMfaSession(database);
            database.sqlite.run(
                `INSERT INTO user_totp_factors (
                    confirmed_at,
                    created_at,
                    encrypted_secret,
                    enrollment_expires_at,
                    id,
                    label,
                    last_used_step,
                    secret_key_id,
                    user_id
                ) VALUES (3000, 2000, ?, 302000, ?, 'Primary phone', 100, 'primary', ?)`,
                [encryptedTotpSecret, factorId, userId]
            );

            expect(() =>
                database.sqlite.run(
                    `INSERT INTO auth_sessions (
                        authenticated_at,
                        authentication_version,
                        auth_method,
                        created_at,
                        expires_at,
                        id,
                        last_seen_at,
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 1, 'recovery', 2000, 10000, ?, 2000, 1000, ?, ?)`,
                    ["f".repeat(32), userId, "1".repeat(64)]
                )
            ).toThrow("auth_sessions_mfa_method_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO user_totp_factors (
                        created_at,
                        encrypted_secret,
                        enrollment_expires_at,
                        id,
                        label,
                        last_used_step,
                        secret_key_id,
                        user_id
                    ) VALUES (2000, ?, 302000, ?, 'Incomplete', 1, 'primary', ?)`,
                    [encryptedTotpSecret, "019fc968-1a9b-7773-8f1b-d5b863b0e7b4", userId]
                )
            ).toThrow("user_totp_factors_confirmation_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO user_totp_factors (
                        created_at,
                        encrypted_secret,
                        enrollment_expires_at,
                        id,
                        label,
                        secret_key_id,
                        user_id
                    ) VALUES (2000, ?, 302000, ?, ?, 'primary', ?)`,
                    [
                        encryptedTotpSecret,
                        "019fc968-1a9b-7774-8f1b-d5b863b0e7b4",
                        "Unsafe\u0007label",
                        userId,
                    ]
                )
            ).toThrow("user_totp_factors_label_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces pending-login and recovery-code proof boundaries", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertMfaUser(database);
            insertMfaSession(database);
            insertPendingLogin(database);
            database.sqlite.run(
                `INSERT INTO user_recovery_codes (
                    created_at,
                    id,
                    selector,
                    user_id,
                    validator_hash
                ) VALUES (3000, ?, ?, ?, ?)`,
                [recoveryId, recoverySelector, userId, testDashboardPasswordHash]
            );

            database.sqlite.run(
                `INSERT INTO auth_pending_logins (
                    allows_recovery,
                    allows_totp,
                    allows_webauthn,
                    authentication_version,
                    created_at,
                    expires_at,
                    id,
                    password_verified_at,
                    user_id,
                    validator_hash
                ) VALUES (1, 0, 0, 1, 2000, 301000, ?, 1000, ?, ?)`,
                ["2".repeat(32), userId, "3".repeat(64)]
            );
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO auth_pending_logins (
                        allows_recovery,
                        allows_totp,
                        allows_webauthn,
                        authentication_version,
                        created_at,
                        expires_at,
                        id,
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (0, 0, 0, 1, 2000, 301000, ?, 1000, ?, ?)`,
                    ["9".repeat(32), userId, "a".repeat(64)]
                )
            ).toThrow("auth_pending_logins_methods_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO auth_pending_logins (
                        allows_recovery,
                        allows_totp,
                        allows_webauthn,
                        attempt_count,
                        authentication_version,
                        created_at,
                        expires_at,
                        id,
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (0, 1, 0, 9, 1, 2000, 301000, ?, 1000, ?, ?)`,
                    ["4".repeat(32), userId, "5".repeat(64)]
                )
            ).toThrow("auth_pending_logins_attempt_count_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO auth_pending_logins (
                        allows_recovery,
                        allows_totp,
                        allows_webauthn,
                        authentication_version,
                        created_at,
                        expires_at,
                        id,
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (0, 1, 0, 1, 2000, 301001, ?, 1000, ?, ?)`,
                    ["6".repeat(32), userId, "7".repeat(64)]
                )
            ).toThrow("auth_pending_logins_time_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO user_recovery_codes (
                        created_at,
                        id,
                        selector,
                        used_at,
                        user_id,
                        validator_hash
                    ) VALUES (3000, ?, ?, 2999, ?, ?)`,
                    [
                        "019fc968-1a9b-7775-8f1b-d5b863b0e7b4",
                        "8".repeat(32),
                        userId,
                        testDashboardPasswordHash,
                    ]
                )
            ).toThrow("user_recovery_codes_time_check");

            database.sqlite.run("DELETE FROM auth_sessions WHERE id = ?", [sessionId]);
            expect(
                database.sqlite
                    .query<{ replacedSessionId: string | null }, [string]>(`
                        SELECT replaced_session_id AS "replacedSessionId"
                        FROM auth_pending_logins
                        WHERE id = ?
                    `)
                    .get(pendingLoginId)
            ).toEqual({ replacedSessionId: null });

            database.sqlite.run("DELETE FROM users WHERE id = ?", [userId]);
            for (const table of [
                "auth_pending_logins",
                "user_recovery_codes",
                "user_totp_factors",
            ]) {
                expect(
                    database.sqlite
                        .query<{ count: number }, []>(
                            `SELECT count(*) AS count FROM ${table}`
                        )
                        .get()
                ).toEqual({ count: 0 });
            }
        } finally {
            database.sqlite.close(true);
        }
    });
});
