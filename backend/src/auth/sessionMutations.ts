import type { DashboardAuthMethod } from "../../../contracts/accountSecurity/methods.ts";
import { database } from "../database/connection.ts";
import { getAuthSessionFromSessionId, insertSession } from "./sessionRepository.ts";
import { parseSessionToken } from "./sessionToken.ts";
import type { CreateSessionOptions } from "./sessionTypes.ts";
import { hashPassword } from "./userRepository.ts";

function nowIso(now = new Date()): string {
    return now.toISOString();
}

/**
 * Rotates a session selector/validator and optionally records fresh elevation.
 * @param sessionToken Session token value.
 * @param options Operation options.
 * @returns Rotate session result.
 */
export function rotateSession(
    sessionToken: string,
    options: Omit<CreateSessionOptions, "authenticatedAt"> & {
        authMethod?: DashboardAuthMethod;
        authenticatedAt?: string;
    } = {}
): string | undefined {
    const current = getAuthSessionFromSessionId(sessionToken, {
        now: options.now,
    });
    const parsedToken = parseSessionToken(sessionToken);
    if (!current || !parsedToken) {
        return undefined;
    }

    database.run("BEGIN IMMEDIATE");
    try {
        const deleted = database
            .prepare(
                `DELETE FROM auth_sessions
                 WHERE id = ? AND validator_hash = ?`
            )
            .run(parsedToken.selector, parsedToken.validatorHash);
        if (deleted.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        const rotated = insertSession(current.id, {
            authMethod: options.authMethod ?? current.authMethod,
            authenticatedAt: options.authenticatedAt ?? current.authenticatedAt,
            elevatedAt: options.elevatedAt ?? current.elevatedAt,
            elevatedMethod: options.elevatedMethod ?? current.elevatedMethod,
            mfaVerifiedAt: options.mfaVerifiedAt ?? current.mfaVerifiedAt,
            now: options.now,
            userAgent: options.userAgent ?? current.userAgent,
        });
        database.run("COMMIT");
        return rotated;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "Session rotation and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

export interface PasswordChangeResult {
    revokedSessions: number;
    sessionToken: string;
}

/**
 * Replaces a password, rotates the current session, and revokes every other
 * browser session and pending authentication ceremony atomically.
 * @param sessionToken Session token value.
 * @param userId User identifier.
 * @param newPassword New password value.
 * @returns Promise resolving to the change password and rotate session result.
 */
export async function changePasswordAndRotateSession(
    sessionToken: string,
    userId: number,
    newPassword: string,
    { now = new Date(), userAgent }: { now?: Date; userAgent?: string } = {}
): Promise<PasswordChangeResult | undefined> {
    const current = getAuthSessionFromSessionId(sessionToken, { now });
    const parsedToken = parseSessionToken(sessionToken);
    if (!parsedToken || !current || current.id !== userId) {
        return undefined;
    }
    const passwordHash = await hashPassword(newPassword);
    const timestamp = nowIso(now);

    database.run("BEGIN IMMEDIATE");
    try {
        const deletedCurrent = database
            .prepare(
                `DELETE FROM auth_sessions
                 WHERE id = ? AND validator_hash = ? AND user_id = ?`
            )
            .run(parsedToken.selector, parsedToken.validatorHash, userId);
        if (deletedCurrent.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        const rotated = insertSession(userId, {
            authMethod: current.authMethod,
            authenticatedAt: current.authenticatedAt,
            elevatedAt: current.elevatedAt,
            elevatedMethod: current.elevatedMethod,
            mfaVerifiedAt: current.mfaVerifiedAt,
            now,
            userAgent: userAgent ?? current.userAgent,
        });
        const rotatedSelector = rotated.split(".", 1)[0];
        const updated = database
            .prepare(
                `UPDATE users
                 SET password_hash = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(passwordHash, timestamp, userId);
        if (!rotatedSelector || updated.changes !== 1) {
            throw new Error("Password change target disappeared");
        }
        const revokedSessions = database
            .prepare(
                `DELETE FROM auth_sessions
                 WHERE user_id = ? AND id != ?`
            )
            .run(userId, rotatedSelector).changes;
        database.prepare("DELETE FROM auth_pending_logins WHERE user_id = ?").run(userId);
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE user_id = ?")
            .run(userId);
        database.run("COMMIT");
        return { revokedSessions, sessionToken: rotated };
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "Password change and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}
