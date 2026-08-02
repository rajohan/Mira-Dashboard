import type {
    DashboardAuthMethod,
    DashboardAuthSession,
} from "../../../contracts/accountSecurity.ts";
import type { DashboardUser } from "../../../contracts/auth.ts";
import { database, sqlNullable } from "../database/connection.ts";
import { sessionIdleTtlMs } from "./sessionPolicy.ts";
import {
    areSessionHashesEqual,
    hashSessionValidator,
    parseSessionToken,
    randomHex,
} from "./sessionToken.ts";
import type { AuthSession, CreateSessionOptions, SessionRow } from "./sessionTypes.ts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60_000;
const SESSION_SELECTOR_BYTES = 16;
const SESSION_VALIDATOR_BYTES = 32;
const MAX_USER_AGENT_LENGTH = 512;

function nowIso(now = new Date()): string {
    return now.toISOString();
}

function normalizedUserAgent(userAgent?: string): string | undefined {
    const normalized = userAgent?.replaceAll("\0", "").trim();
    return normalized ? normalized.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

/**
 * Inserts a session and returns its selector-validator token.
 * @param userId Dashboard user identifier.
 * @param options Session creation options.
 * @returns Newly created session token.
 */
export function insertSession(
    userId: number,
    options: CreateSessionOptions = {}
): string {
    const now = options.now ?? new Date();
    const timestamp = nowIso(now);
    const selector = randomHex(SESSION_SELECTOR_BYTES);
    const validator = randomHex(SESSION_VALIDATOR_BYTES);
    const validatorHash = hashSessionValidator(validator);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const authMethod = options.authMethod ?? "password";
    const authenticatedAt = options.authenticatedAt ?? timestamp;
    const elevatedAt = options.elevatedAt ?? timestamp;
    const elevatedMethod = options.elevatedMethod ?? authMethod;

    database
        .prepare(
            `INSERT INTO auth_sessions (
                id,
                user_id,
                created_at,
                expires_at,
                validator_hash,
                last_seen_at,
                authenticated_at,
                mfa_verified_at,
                elevated_at,
                auth_method,
                elevated_method,
                user_agent
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            selector,
            userId,
            timestamp,
            expiresAt,
            validatorHash,
            timestamp,
            authenticatedAt,
            sqlNullable(options.mfaVerifiedAt),
            elevatedAt,
            authMethod,
            elevatedMethod,
            sqlNullable(normalizedUserAgent(options.userAgent))
        );

    return `${selector}.${validator}`;
}

/**
 * Creates a durable session with a hashed validator.
 * @param userId User identifier.
 * @param options Operation options.
 * @returns Created a durable session with a hashed validator.
 */
export function createSession(
    userId: number,
    options: CreateSessionOptions = {}
): string {
    return insertSession(userId, options);
}

/**
 * Deletes exactly the session addressed by a selector/validator token.
 * @param sessionToken Session token value.
 */
export function deleteSession(sessionToken: string): void {
    const parsedToken = parseSessionToken(sessionToken);
    if (!parsedToken) {
        return;
    }
    database
        .prepare(
            `DELETE FROM auth_sessions
             WHERE id = ? AND validator_hash = ?`
        )
        .run(parsedToken.selector, parsedToken.validatorHash);
}

/**
 * Removes expired, idle, and structurally incomplete sessions.
 * @param now Now value.
 */
export function cleanupExpiredSessions(now = new Date()): void {
    const idleCutoff = new Date(now.getTime() - sessionIdleTtlMs()).toISOString();
    database
        .prepare(
            `DELETE FROM auth_sessions
             WHERE expires_at <= ?
                OR COALESCE(last_seen_at, created_at) <= ?
                OR auth_method IS NULL
                OR authenticated_at IS NULL`
        )
        .run(nowIso(now), idleCutoff);
}

function readSessionRow(selector: string): SessionRow | undefined {
    return (
        (database
            .prepare(
                `SELECT s.id AS session_id,
                        s.validator_hash,
                        s.created_at,
                        s.expires_at,
                        s.last_seen_at,
                        s.authenticated_at,
                        s.mfa_verified_at,
                        s.elevated_at,
                        s.auth_method,
                        s.elevated_method,
                        s.user_agent,
                        u.id,
                        u.username,
                        u.mfa_enabled_at
                 FROM auth_sessions s
                 JOIN users u ON u.id = s.user_id
                 WHERE s.id = ?`
            )
            .get(selector) as SessionRow | undefined) || undefined
    );
}

function sessionFromRow(row: SessionRow): AuthSession | undefined {
    if (!row.auth_method || !row.authenticated_at) {
        return undefined;
    }
    return {
        authMethod: row.auth_method,
        authenticatedAt: row.authenticated_at,
        createdAt: row.created_at,
        ...(row.elevated_at && { elevatedAt: row.elevated_at }),
        ...(row.elevated_method && { elevatedMethod: row.elevated_method }),
        expiresAt: row.expires_at,
        id: row.id,
        lastSeenAt: row.last_seen_at ?? row.created_at,
        mfaEnabled: Boolean(row.mfa_enabled_at),
        ...(row.mfa_verified_at && { mfaVerifiedAt: row.mfa_verified_at }),
        sessionId: row.session_id,
        ...(row.user_agent && { userAgent: row.user_agent }),
        username: row.username,
    };
}

/**
 * Resolves and optionally activity-touches one authenticated session.
 * @param sessionToken Session token value.
 * @returns Resolved and optionally activity-touches one authenticated session.
 */
export function getAuthSessionFromSessionId(
    sessionToken: string,
    {
        now = new Date(),
        touchActivity = false,
    }: { now?: Date; touchActivity?: boolean } = {}
): AuthSession | undefined {
    const parsedToken = parseSessionToken(sessionToken);
    if (!parsedToken) {
        return undefined;
    }
    const row = readSessionRow(parsedToken.selector);
    if (
        !row?.validator_hash ||
        !areSessionHashesEqual(row.validator_hash, parsedToken.validatorHash)
    ) {
        return undefined;
    }
    const nowMs = now.getTime();
    const expiresAt = Date.parse(row.expires_at);
    const lastSeenAt = Date.parse(row.last_seen_at ?? row.created_at);
    if (
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(lastSeenAt) ||
        expiresAt <= nowMs ||
        lastSeenAt <= nowMs - sessionIdleTtlMs()
    ) {
        return undefined;
    }
    const session = sessionFromRow(row);
    if (!session) {
        return undefined;
    }

    if (
        touchActivity &&
        Number.isFinite(lastSeenAt) &&
        now.getTime() - lastSeenAt >= SESSION_ACTIVITY_WRITE_INTERVAL_MS
    ) {
        const touchedAt = nowIso(now);
        database
            .prepare(
                `UPDATE auth_sessions
                 SET last_seen_at = ?
                 WHERE id = ? AND validator_hash = ?`
            )
            .run(touchedAt, parsedToken.selector, parsedToken.validatorHash);
        session.lastSeenAt = touchedAt;
    }
    return session;
}

/**
 * Resolves the authenticated user represented by a session token.
 * @param sessionToken Session token value.
 * @param options Operation options.
 * @returns Resolved the authenticated user represented by a session token.
 */
export function getAuthUserFromSessionId(
    sessionToken: string,
    options: { now?: Date; touchActivity?: boolean } = {}
): DashboardUser | undefined {
    const session = getAuthSessionFromSessionId(sessionToken, options);
    return session ? { id: session.id, username: session.username } : undefined;
}

/**
 * Lists the user's durable sessions without exposing validators.
 * @param userId User identifier.
 * @param currentSessionId Current session identifier.
 * @returns List user sessions result.
 */
export function listUserSessions(
    userId: number,
    currentSessionId?: string
): DashboardAuthSession[] {
    cleanupExpiredSessions();
    const rows = database
        .prepare(
            `SELECT id,
                    created_at,
                    expires_at,
                    last_seen_at,
                    authenticated_at,
                    mfa_verified_at,
                    elevated_at,
                    auth_method,
                    elevated_method,
                    user_agent
             FROM auth_sessions
             WHERE user_id = ?
               AND auth_method IS NOT NULL
               AND authenticated_at IS NOT NULL
             ORDER BY last_seen_at DESC, created_at DESC, id DESC`
        )
        .all(userId) as Array<{
        auth_method: DashboardAuthMethod;
        authenticated_at: string;
        created_at: string;
        elevated_at: string | null;
        elevated_method: DashboardAuthMethod | null;
        expires_at: string;
        id: string;
        last_seen_at: string | null;
        mfa_verified_at: string | null;
        user_agent: string | null;
    }>;
    return rows.map((row) => ({
        authMethod: row.auth_method,
        authenticatedAt: row.authenticated_at,
        createdAt: row.created_at,
        ...(row.elevated_at && { elevatedAt: row.elevated_at }),
        ...(row.elevated_method && { elevatedMethod: row.elevated_method }),
        expiresAt: row.expires_at,
        isCurrent: row.id === currentSessionId,
        lastSeenAt: row.last_seen_at ?? row.created_at,
        ...(row.mfa_verified_at && { mfaVerifiedAt: row.mfa_verified_at }),
        sessionId: row.id,
        ...(row.user_agent && { userAgent: row.user_agent }),
    }));
}

/**
 * Revokes one session only when it belongs to the authenticated user.
 * @param userId User identifier.
 * @param sessionId Session identifier.
 * @returns Did revoke user session result.
 */
export function didRevokeUserSession(userId: number, sessionId: string): boolean {
    return (
        database
            .prepare("DELETE FROM auth_sessions WHERE id = ? AND user_id = ?")
            .run(sessionId, userId).changes === 1
    );
}

/**
 * Revokes every session for a user, optionally preserving one selector.
 * @param userId User identifier.
 * @param exceptSessionId Except session identifier.
 * @returns Revoke user sessions result.
 */
export function revokeUserSessions(userId: number, exceptSessionId?: string): number {
    const result = exceptSessionId
        ? database
              .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id != ?")
              .run(userId, exceptSessionId)
        : database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return result.changes;
}
