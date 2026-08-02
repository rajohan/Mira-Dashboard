import type { FactorConfirmation } from "../../../../contracts/accountSecurity/responses.ts";
import { database } from "../../database/connection.ts";
import { randomHex } from "../mfaCrypto.ts";

const RECOVERY_SELECTOR_BYTES = 4;
const RECOVERY_VALIDATOR_BYTES = 16;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_PATTERN = /^([a-f0-9]{8})-([a-f0-9]{32})$/u;

function nowIso(now = new Date()): string {
    return now.toISOString();
}

export interface GeneratedRecoveryCode {
    code: string;
    selector: string;
    validatorHash: string;
}

/**
 * Prepares one recovery-code set without persisting plaintext code material.
 * @returns Promise resolving to the generate recovery code set result.
 */
export async function generateRecoveryCodeSet(): Promise<GeneratedRecoveryCode[]> {
    return Promise.all(
        Array.from({ length: RECOVERY_CODE_COUNT }, async () => {
            const selector = randomHex(RECOVERY_SELECTOR_BYTES);
            const validator = randomHex(RECOVERY_VALIDATOR_BYTES);
            return {
                code: `${selector}-${validator}`,
                selector,
                validatorHash: await Bun.password.hash(validator),
            };
        })
    );
}

function insertRecoveryCodeSet(
    userId: number,
    generated: GeneratedRecoveryCode[],
    createdAt: string
): void {
    const insert = database.prepare(
        `INSERT INTO user_recovery_codes (
            id, user_id, validator_hash, created_at
         ) VALUES (?, ?, ?, ?)`
    );
    for (const code of generated) {
        insert.run(code.selector, userId, code.validatorHash, createdAt);
    }
}

/**
 * Enables MFA and persists a prepared recovery-code set.
 *
 * This must run inside the same immediate transaction that activates the first
 * factor. The conditional user update ensures concurrent enrollments cannot
 * both replace the recovery-code set or reveal an unusable set.
 * @param userId User identifier.
 * @param generatedRecoveryCodes Generated recovery codes value.
 * @param timestamp Timestamp value.
 * @returns Enable multi factor in transaction result.
 */
export function enableMultiFactorInTransaction(
    userId: number,
    generatedRecoveryCodes: GeneratedRecoveryCode[],
    timestamp: string
): FactorConfirmation {
    const enabled = database
        .prepare(
            `UPDATE users
             SET mfa_enabled_at = ?, updated_at = ?
             WHERE id = ? AND mfa_enabled_at IS NULL`
        )
        .run(timestamp, timestamp, userId);
    if (enabled.changes !== 1) {
        return { enabledMfa: false };
    }
    database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
    insertRecoveryCodeSet(userId, generatedRecoveryCodes, timestamp);
    return {
        enabledMfa: true,
        recoveryCodes: generatedRecoveryCodes.map((code) => code.code),
    };
}

/**
 * Generates and replaces the user's one-time recovery codes.
 * @param userId User identifier.
 * @param now Now value.
 * @returns Promise resolving to the rotate recovery codes result.
 */
export async function rotateRecoveryCodes(
    userId: number,
    now = new Date()
): Promise<string[]> {
    const generated = await generateRecoveryCodeSet();
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
        insertRecoveryCodeSet(userId, generated, timestamp);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "Recovery-code rotation and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
    return generated.map((code) => code.code);
}

/**
 * Consumes one high-entropy recovery code after password-hash verification.
 * @param userId User identifier.
 * @param code Status or verification code.
 * @param now Now value.
 * @returns Promise resolving to the verify recovery code for user result.
 */
export async function verifyRecoveryCodeForUser(
    userId: number,
    code: string,
    now = new Date()
): Promise<boolean> {
    const normalized = code.trim().toLowerCase();
    const match = normalized.match(RECOVERY_CODE_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    if (!selector || !validator) {
        return false;
    }
    const row = database
        .prepare(
            `SELECT validator_hash
             FROM user_recovery_codes
             WHERE id = ? AND user_id = ? AND used_at IS NULL`
        )
        .get(selector, userId) as { validator_hash: string } | undefined;
    if (!row) {
        return false;
    }
    try {
        const isValid = await Bun.password.verify(validator, row.validator_hash);
        if (!isValid) {
            return false;
        }
    } catch {
        return false;
    }
    return (
        database
            .prepare(
                `UPDATE user_recovery_codes
                 SET used_at = ?
                 WHERE id = ? AND user_id = ? AND used_at IS NULL`
            )
            .run(nowIso(now), selector, userId).changes === 1
    );
}
