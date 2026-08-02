import { database } from "../../database/connection.ts";

function nowIso(now = new Date()): string {
    return now.toISOString();
}

/**
 * Removes all user-held factors and recovery codes after an explicit disable flow.
 * @param userId User identifier.
 * @param now Now value.
 */
export function disableMultiFactor(userId: number, now = new Date()): void {
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_pending_logins WHERE user_id = ?").run(userId);
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE user_id = ?")
            .run(userId);
        database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
        database.prepare("DELETE FROM user_totp_factors WHERE user_id = ?").run(userId);
        database
            .prepare("DELETE FROM user_webauthn_credentials WHERE user_id = ?")
            .run(userId);
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = NULL, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, userId);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "MFA disable and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}
