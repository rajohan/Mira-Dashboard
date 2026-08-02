import type { DashboardMfaMethod as MfaLoginMethod } from "../../../../contracts/accountSecurity/methods.ts";
import type { AccountSecuritySummary } from "../../../../contracts/accountSecurity/summary.ts";
import { database } from "../../database/connection.ts";

interface WebAuthnFactorSummaryRow {
    backed_up: number;
    created_at: string;
    device_type: "multiDevice" | "singleDevice";
    id: string;
    label: string;
    last_used_at: string | null;
}

type MultiFactorSummary = AccountSecuritySummary["factors"];

/**
 * Returns the usable second-factor methods configured for one user.
 * @param userId User identifier.
 * @returns the usable second-factor methods configured for one user.
 */
export function mfaMethodsForUser(userId: number): MfaLoginMethod[] {
    const counts = database
        .prepare(
            `SELECT
                (
                    SELECT COUNT(*)
                    FROM user_totp_factors
                    WHERE user_id = ? AND confirmed_at IS NOT NULL
                ) AS totp_count,
                (
                    SELECT COUNT(*)
                    FROM user_webauthn_credentials
                    WHERE user_id = ?
                ) AS webauthn_count,
                (
                    SELECT COUNT(*)
                    FROM user_recovery_codes
                    WHERE user_id = ? AND used_at IS NULL
                ) AS recovery_count`
        )
        .get(userId, userId, userId) as {
        recovery_count: number;
        totp_count: number;
        webauthn_count: number;
    };
    return [
        ...(counts.webauthn_count > 0 ? (["webauthn"] as const) : []),
        ...(counts.totp_count > 0 ? (["totp"] as const) : []),
        ...(counts.recovery_count > 0 ? (["recovery"] as const) : []),
    ];
}

/**
 * Returns the number of active TOTP and WebAuthn factors for one user.
 * @param userId User identifier.
 * @returns the number of active TOTP and WebAuthn factors for one user.
 */
export function totalConfirmedFactorCount(userId: number): number {
    const row = database
        .prepare(
            `SELECT
                (
                    SELECT COUNT(*)
                    FROM user_totp_factors
                    WHERE user_id = ? AND confirmed_at IS NOT NULL
                ) + (
                    SELECT COUNT(*)
                    FROM user_webauthn_credentials
                    WHERE user_id = ?
                ) AS count`
        )
        .get(userId, userId) as { count: number };
    return row.count;
}

/**
 * Returns factor and recovery status without exposing secrets or hashes.
 * @param userId User identifier.
 * @returns factor and recovery status without exposing secrets or hashes.
 */
export function getMultiFactorSummary(userId: number): MultiFactorSummary {
    const user = database
        .prepare("SELECT mfa_enabled_at FROM users WHERE id = ?")
        .get(userId) as { mfa_enabled_at: string | null } | undefined;
    const totpFactors = database
        .prepare(
            `SELECT id, label, created_at, confirmed_at
             FROM user_totp_factors
             WHERE user_id = ? AND confirmed_at IS NOT NULL
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as Array<{
        confirmed_at: string;
        created_at: string;
        id: string;
        label: string;
    }>;
    const webAuthnCredentials = database
        .prepare(
            `SELECT id,
                    label,
                    device_type,
                    backed_up,
                    created_at,
                    last_used_at
             FROM user_webauthn_credentials
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as WebAuthnFactorSummaryRow[];
    const recovery = database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM user_recovery_codes
             WHERE user_id = ? AND used_at IS NULL`
        )
        .get(userId) as { count: number };
    return {
        ...(user?.mfa_enabled_at && { enabledAt: user.mfa_enabled_at }),
        methods: mfaMethodsForUser(userId),
        recoveryCodesRemaining: recovery.count,
        totpFactors: totpFactors.map((factor) => ({
            confirmedAt: factor.confirmed_at,
            createdAt: factor.created_at,
            id: factor.id,
            label: factor.label,
        })),
        webAuthnCredentials: webAuthnCredentials.map((credential) => ({
            backedUp: credential.backed_up === 1,
            createdAt: credential.created_at,
            deviceType: credential.device_type,
            id: credential.id,
            label: credential.label,
            ...(credential.last_used_at && {
                lastUsedAt: credential.last_used_at,
            }),
        })),
    };
}
