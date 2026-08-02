import { generateSecret, generateURI, verify } from "otplib";

import type {
    FactorConfirmation,
    TotpEnrollment,
} from "../../../../contracts/accountSecurity/responses.ts";
import type { TotpFactor as TotpFactorSummary } from "../../../../contracts/accountSecurity/summary.ts";
import { database } from "../../database/connection.ts";
import {
    decryptStoredSecret,
    encryptStoredSecret,
    secretEncryptionKeyBytes,
} from "../mfaCrypto.ts";
import { normalizeFactorLabel } from "./factorIdentity.ts";
import { totalConfirmedFactorCount } from "./factorInventory.ts";
import {
    enableMultiFactorInTransaction,
    generateRecoveryCodeSet,
} from "./recoveryCodeService.ts";

const TOTP_TOKEN_PATTERN = /^\d{6}$/u;

interface TotpFactorRow {
    confirmed_at: string | null;
    created_at: string;
    encrypted_secret: string;
    id: string;
    label: string;
    last_used_step: number | null;
    user_id: number;
}

function nowIso(now = new Date()): string {
    return now.toISOString();
}

function totpAssociatedData(userId: number, factorId: string): string {
    return `mira-dashboard:totp:v1:user:${userId}:factor:${factorId}`;
}

/**
 * Creates an encrypted, inactive TOTP enrollment.
 * @param userId User identifier.
 * @param username Username value.
 * @param label Label value.
 * @param now Now value.
 * @returns Created an encrypted, inactive TOTP enrollment.
 */
export function createTotpEnrollment(
    userId: number,
    username: string,
    label: string,
    now = new Date()
): TotpEnrollment {
    const factorId = Bun.randomUUIDv7();
    const secret = generateSecret({ length: 20 });
    const encryptedSecret = encryptStoredSecret(
        secret,
        totpAssociatedData(userId, factorId)
    );
    const normalizedLabel = normalizeFactorLabel(label, "Authenticator app");
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE user_id = ? AND confirmed_at IS NULL`
            )
            .run(userId);
        database
            .prepare(
                `INSERT INTO user_totp_factors (
                    id,
                    user_id,
                    label,
                    encrypted_secret,
                    created_at
                 ) VALUES (?, ?, ?, ?, ?)`
            )
            .run(factorId, userId, normalizedLabel, encryptedSecret, nowIso(now));
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "TOTP enrollment creation and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
    return {
        factorId,
        label: normalizedLabel,
        otpauthUri: generateURI({
            algorithm: "sha1",
            digits: 6,
            issuer: "Mira Dashboard",
            label: username,
            period: 30,
            secret,
        }),
        secret,
    };
}

async function verifyTotpToken(
    factor: TotpFactorRow,
    token: string
): Promise<{ timeStep: number } | undefined> {
    if (!TOTP_TOKEN_PATTERN.test(token)) {
        return undefined;
    }
    const secret = decryptStoredSecret(
        factor.encrypted_secret,
        totpAssociatedData(factor.user_id, factor.id)
    );
    const result = await verify({
        ...(factor.last_used_step !== null && {
            afterTimeStep: factor.last_used_step,
        }),
        algorithm: "sha1",
        digits: 6,
        epochTolerance: [30, 0],
        period: 30,
        secret,
        strategy: "totp",
        token,
    });
    return result.valid && "timeStep" in result
        ? { timeStep: result.timeStep }
        : undefined;
}

function userMfaEnabledAt(userId: number): string | undefined {
    const row = database
        .prepare("SELECT mfa_enabled_at FROM users WHERE id = ?")
        .get(userId) as { mfa_enabled_at: string | null } | undefined;
    return row?.mfa_enabled_at ?? undefined;
}

/**
 * Confirms an encrypted TOTP enrollment and prevents time-step replay.
 * @param userId User identifier.
 * @param factorId Factor identifier.
 * @param token Token value.
 * @param now Now value.
 * @returns Promise resolving to the confirm totp enrollment result.
 */
export async function confirmTotpEnrollment(
    userId: number,
    factorId: string,
    token: string,
    now = new Date()
): Promise<FactorConfirmation | undefined> {
    const factor = database
        .prepare(
            `SELECT id,
                    user_id,
                    label,
                    encrypted_secret,
                    last_used_step,
                    created_at,
                    confirmed_at
             FROM user_totp_factors
             WHERE id = ? AND user_id = ? AND confirmed_at IS NULL`
        )
        .get(factorId, userId) as TotpFactorRow | undefined;
    if (!factor) {
        return undefined;
    }
    const verified = await verifyTotpToken(factor, token);
    if (!verified) {
        return undefined;
    }

    const shouldEnableMfa = !userMfaEnabledAt(userId);
    const generatedRecoveryCodes = shouldEnableMfa
        ? await generateRecoveryCodeSet()
        : undefined;
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        const confirmed = database
            .prepare(
                `UPDATE user_totp_factors
                 SET confirmed_at = ?, last_used_step = ?
                 WHERE id = ?
                   AND user_id = ?
                   AND confirmed_at IS NULL
                   AND (last_used_step IS NULL OR last_used_step < ?)`
            )
            .run(timestamp, verified.timeStep, factorId, userId, verified.timeStep);
        if (confirmed.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        const confirmation = generatedRecoveryCodes
            ? enableMultiFactorInTransaction(userId, generatedRecoveryCodes, timestamp)
            : { enabledMfa: false };
        database.run("COMMIT");
        return confirmation;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "TOTP confirmation and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/**
 * Verifies one confirmed authenticator-app code and atomically records its time step.
 * @param userId User identifier.
 * @param token Token value.
 * @returns Promise resolving to the verify totp for user result.
 */
export async function verifyTotpForUser(
    userId: number,
    token: string
): Promise<TotpFactorSummary | undefined> {
    if (!TOTP_TOKEN_PATTERN.test(token)) {
        return undefined;
    }
    const factors = database
        .prepare(
            `SELECT id,
                    user_id,
                    label,
                    encrypted_secret,
                    last_used_step,
                    created_at,
                    confirmed_at
             FROM user_totp_factors
             WHERE user_id = ? AND confirmed_at IS NOT NULL
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as TotpFactorRow[];
    for (const factor of factors) {
        const verified = await verifyTotpToken(factor, token);
        if (!verified) continue;
        const updated = database
            .prepare(
                `UPDATE user_totp_factors
                 SET last_used_step = ?
                 WHERE id = ?
                   AND user_id = ?
                   AND (last_used_step IS NULL OR last_used_step < ?)`
            )
            .run(verified.timeStep, factor.id, userId, verified.timeStep);
        if (updated.changes === 1 && factor.confirmed_at) {
            return {
                confirmedAt: factor.confirmed_at,
                createdAt: factor.created_at,
                id: factor.id,
                label: factor.label,
            };
        }
    }
    return undefined;
}

/**
 * Removes a TOTP factor without allowing deletion of the final second factor.
 * @param userId User identifier.
 * @param factorId Factor identifier.
 * @returns Did remove totp factor result.
 */
export function didRemoveTotpFactor(userId: number, factorId: string): boolean {
    database.run("BEGIN IMMEDIATE");
    try {
        if (totalConfirmedFactorCount(userId) <= 1) {
            database.run("ROLLBACK");
            return false;
        }
        const deleted = database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE id = ? AND user_id = ? AND confirmed_at IS NOT NULL`
            )
            .run(factorId, userId);
        database.run("COMMIT");
        return deleted.changes === 1;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "TOTP removal and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/** Fails startup when stored TOTP data cannot be decrypted with the external key. */
export function validateTotpStorageConfig(): void {
    const factors = database
        .prepare(
            `SELECT id, user_id, encrypted_secret
             FROM user_totp_factors
             ORDER BY id`
        )
        .all() as Array<{
        encrypted_secret: string;
        id: string;
        user_id: number;
    }>;
    if (factors.length === 0) {
        return;
    }
    secretEncryptionKeyBytes();
    for (const factor of factors) {
        decryptStoredSecret(
            factor.encrypted_secret,
            totpAssociatedData(factor.user_id, factor.id)
        );
    }
}
