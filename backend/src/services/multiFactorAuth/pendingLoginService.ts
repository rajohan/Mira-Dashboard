import type { DashboardMfaMethod as MfaLoginMethod } from "../../../../contracts/accountSecurity.ts";
import { database, sqlNullable } from "../../database.ts";
import { areTimingSafeHashesEqual, randomHex, sha256Hex } from "../mfaCrypto.ts";

const PENDING_LOGIN_TTL_MS = 5 * 60_000;
const MAX_PENDING_LOGIN_ATTEMPTS = 8;
const PENDING_SELECTOR_BYTES = 16;
const PENDING_VALIDATOR_BYTES = 32;
const PENDING_TOKEN_PATTERN = /^([a-f0-9]{32})\.([a-f0-9]{64})$/u;
const MAX_USER_AGENT_LENGTH = 512;

interface PendingLoginRow {
    attempt_count: number;
    created_at: string;
    expires_at: string;
    id: string;
    methods_json: string;
    user_agent: string | null;
    user_id: number;
    username: string;
    validator_hash: string;
}

export interface PendingLogin {
    attemptCount: number;
    createdAt: string;
    expiresAt: string;
    methods: MfaLoginMethod[];
    pendingLoginId: string;
    userAgent?: string;
    userId: number;
    username: string;
}

function nowIso(now = new Date()): string {
    return now.toISOString();
}

function normalizeUserAgent(userAgent?: string): string | undefined {
    const normalized = userAgent?.replaceAll("\0", "").trim();
    return normalized ? normalized.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}
function pendingTokenParts(
    pendingToken: string
): { selector: string; validatorHash: string } | undefined {
    const match = pendingToken.match(PENDING_TOKEN_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    return selector && validator
        ? { selector, validatorHash: sha256Hex(validator) }
        : undefined;
}

/**
 * Removes expired pending logins, WebAuthn challenges, and abandoned TOTP setups.
 * @param now Now value.
 */
export function cleanupExpiredMultiFactorState(now = new Date()): void {
    const timestamp = nowIso(now);
    const abandonedEnrollmentCutoff = new Date(
        now.getTime() - PENDING_LOGIN_TTL_MS
    ).toISOString();
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE expires_at <= ?")
            .run(timestamp);
        database
            .prepare("DELETE FROM auth_pending_logins WHERE expires_at <= ?")
            .run(timestamp);
        database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE confirmed_at IS NULL AND created_at <= ?`
            )
            .run(abandonedEnrollmentCutoff);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "MFA cleanup and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}
/**
 * Creates one short-lived password-verified login transaction.
 * @param userId User identifier.
 * @param methods Methods value.
 * @param userAgent User agent value.
 * @param now Now value.
 * @returns Created one short-lived password-verified login transaction.
 */
export function createPendingLogin(
    userId: number,
    methods: MfaLoginMethod[],
    userAgent?: string,
    now = new Date()
): string {
    if (methods.length === 0) {
        throw new Error("No MFA methods are configured");
    }
    cleanupExpiredMultiFactorState(now);
    const selector = randomHex(PENDING_SELECTOR_BYTES);
    const validator = randomHex(PENDING_VALIDATOR_BYTES);
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_pending_logins WHERE user_id = ?").run(userId);
        database
            .prepare(
                `INSERT INTO auth_pending_logins (
                    id,
                    validator_hash,
                    user_id,
                    methods_json,
                    attempt_count,
                    user_agent,
                    created_at,
                    expires_at
                 ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
            )
            .run(
                selector,
                sha256Hex(validator),
                userId,
                JSON.stringify(methods),
                sqlNullable(normalizeUserAgent(userAgent)),
                timestamp,
                new Date(now.getTime() + PENDING_LOGIN_TTL_MS).toISOString()
            );
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "Pending login creation and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
    return `${selector}.${validator}`;
}

/**
 * Resolves a pending-login token without exposing its validator.
 * @param pendingToken Pending token value.
 * @param now Now value.
 * @returns Resolved a pending-login token without exposing its validator.
 */
export function getPendingLogin(
    pendingToken: string,
    now = new Date()
): PendingLogin | undefined {
    const parsed = pendingTokenParts(pendingToken);
    if (!parsed) {
        return undefined;
    }
    cleanupExpiredMultiFactorState(now);
    const row = database
        .prepare(
            `SELECT p.id,
                    p.validator_hash,
                    p.user_id,
                    p.methods_json,
                    p.attempt_count,
                    p.user_agent,
                    p.created_at,
                    p.expires_at,
                    u.username
             FROM auth_pending_logins p
             JOIN users u ON u.id = p.user_id
             WHERE p.id = ? AND p.expires_at > ?`
        )
        .get(parsed.selector, nowIso(now)) as PendingLoginRow | undefined;
    if (
        !row ||
        row.attempt_count >= MAX_PENDING_LOGIN_ATTEMPTS ||
        !areTimingSafeHashesEqual(row.validator_hash, parsed.validatorHash)
    ) {
        return undefined;
    }
    let methods: unknown;
    try {
        methods = JSON.parse(row.methods_json) as unknown;
    } catch {
        return undefined;
    }
    if (
        !Array.isArray(methods) ||
        methods.some(
            (method) =>
                method !== "recovery" && method !== "totp" && method !== "webauthn"
        )
    ) {
        return undefined;
    }
    return {
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        methods: methods as MfaLoginMethod[],
        pendingLoginId: row.id,
        ...(row.user_agent && { userAgent: row.user_agent }),
        userId: row.user_id,
        username: row.username,
    };
}

/**
 * Records a failed second-factor attempt and consumes exhausted login state.
 * @param pendingLoginId Pending login identifier.
 */
export function recordPendingLoginFailure(pendingLoginId: string): void {
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare(
                `UPDATE auth_pending_logins
                 SET attempt_count = attempt_count + 1
                 WHERE id = ?`
            )
            .run(pendingLoginId);
        database
            .prepare(
                `DELETE FROM auth_pending_logins
                 WHERE id = ? AND attempt_count >= ?`
            )
            .run(pendingLoginId, MAX_PENDING_LOGIN_ATTEMPTS);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "Pending login failure update and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/**
 * Atomically consumes a pending login after successful factor verification.
 * @param pendingToken Pending token value.
 * @returns Consume pending login result.
 */
export function consumePendingLogin(pendingToken: string): PendingLogin | undefined {
    const pending = getPendingLogin(pendingToken);
    const parsed = pendingTokenParts(pendingToken);
    if (!pending || !parsed) {
        return undefined;
    }
    const deleted = database
        .prepare(
            `DELETE FROM auth_pending_logins
             WHERE id = ? AND validator_hash = ?`
        )
        .run(parsed.selector, parsed.validatorHash);
    return deleted.changes === 1 ? pending : undefined;
}
