import type {
    DashboardAuthMethod,
    DashboardAuthSession,
} from "../../../contracts/accountSecurity.ts";
import type { DashboardUser } from "../../../contracts/auth.ts";
import { database, sqlNullable } from "../database/connection.ts";
import { hashPassword } from "./userRepository.ts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_SESSION_IDLE_MINUTES = 30;
const MINIMUM_SESSION_IDLE_MINUTES = 5;
const MAXIMUM_SESSION_IDLE_MINUTES = 24 * 60;
const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60_000;
const DEFAULT_RECENT_AUTHENTICATION_MINUTES = 10;
const MINIMUM_RECENT_AUTHENTICATION_MINUTES = 1;
const MAXIMUM_RECENT_AUTHENTICATION_MINUTES = 60;
const SESSION_SELECTOR_BYTES = 16;
const SESSION_VALIDATOR_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^([a-f0-9]{32})\.([a-f0-9]{64})$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_USER_AGENT_LENGTH = 512;
interface SessionRow extends DashboardUser {
    auth_method: DashboardAuthMethod | null;
    authenticated_at: string | null;
    created_at: string;
    elevated_at: string | null;
    elevated_method: DashboardAuthMethod | null;
    expires_at: string;
    last_seen_at: string | null;
    mfa_enabled_at: string | null;
    mfa_verified_at: string | null;
    session_id: string;
    user_agent: string | null;
    validator_hash: string | null;
}

export interface AuthSession extends DashboardUser {
    authMethod: DashboardAuthMethod;
    authenticatedAt: string;
    createdAt: string;
    elevatedAt?: string;
    elevatedMethod?: DashboardAuthMethod;
    expiresAt: string;
    lastSeenAt: string;
    mfaEnabled: boolean;
    mfaVerifiedAt?: string;
    sessionId: string;
    userAgent?: string;
}

interface CreateSessionOptions {
    authMethod?: DashboardAuthMethod;
    authenticatedAt?: string;
    elevatedAt?: string;
    elevatedMethod?: DashboardAuthMethod;
    mfaVerifiedAt?: string;
    now?: Date;
    userAgent?: string;
}

/**
 * Returns the current time in the database timestamp format.
 * @param now Now value.
 * @returns the current time in the database timestamp format.
 */
function nowIso(now = new Date()): string {
    return now.toISOString();
}

/**
 * Returns cryptographically secure random bytes as lowercase hex.
 * @param byteLength Number of random bytes.
 * @returns Random bytes encoded as lowercase hex.
 */
function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes.toHex();
}

function hashSessionValidator(validator: string): string {
    return new Bun.CryptoHasher("sha256").update(validator).digest("hex");
}

function parseSessionToken(
    sessionToken: string
): { selector: string; validatorHash: string } | undefined {
    const match = sessionToken.match(SESSION_TOKEN_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    if (!selector || !validator) {
        return undefined;
    }
    return { selector, validatorHash: hashSessionValidator(validator) };
}

/**
 * Returns the non-secret selector portion of a valid session token.
 * @param sessionToken Session token value.
 * @returns the non-secret selector portion of a valid session token.
 */
export function sessionSelectorFromToken(sessionToken: string): string | undefined {
    return parseSessionToken(sessionToken)?.selector;
}

function areSessionHashesEqual(storedHash: string, candidateHash: string): boolean {
    if (
        !SESSION_HASH_PATTERN.test(storedHash) ||
        !SESSION_HASH_PATTERN.test(candidateHash)
    ) {
        return false;
    }
    return crypto.timingSafeEqual(
        Uint8Array.fromHex(storedHash),
        Uint8Array.fromHex(candidateHash)
    );
}

function normalizedUserAgent(userAgent?: string): string | undefined {
    const normalized = userAgent?.replaceAll("\0", "").trim();
    return normalized ? normalized.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

/**
 * Resolves the idle timeout while keeping unsafe environment values fail-closed.
 * @param configuredMinutes Configured minutes value.
 * @returns Resolved the idle timeout while keeping unsafe environment values fail-closed.
 */
export function sessionIdleTtlMs(
    configuredMinutes = process.env.MIRA_DASHBOARD_SESSION_IDLE_MINUTES
): number {
    const normalized = configuredMinutes?.trim();
    if (!normalized) {
        return DEFAULT_SESSION_IDLE_MINUTES * 60_000;
    }
    if (!/^\d+$/u.test(normalized)) {
        throw new TypeError("MIRA_DASHBOARD_SESSION_IDLE_MINUTES must be an integer");
    }
    const minutes = Number(normalized);
    if (
        !Number.isSafeInteger(minutes) ||
        minutes < MINIMUM_SESSION_IDLE_MINUTES ||
        minutes > MAXIMUM_SESSION_IDLE_MINUTES
    ) {
        throw new RangeError(
            `MIRA_DASHBOARD_SESSION_IDLE_MINUTES must be ${MINIMUM_SESSION_IDLE_MINUTES}-${MAXIMUM_SESSION_IDLE_MINUTES}`
        );
    }
    return minutes * 60_000;
}

/**
 * Resolves the bounded window used for privileged account-security actions.
 * @param configuredMinutes Configured minutes value.
 * @returns Resolved the bounded window used for privileged account-security actions.
 */
export function recentAuthenticationTtlMs(
    configuredMinutes = process.env.MIRA_DASHBOARD_RECENT_AUTH_MINUTES
): number {
    const normalized = configuredMinutes?.trim();
    if (!normalized) {
        return DEFAULT_RECENT_AUTHENTICATION_MINUTES * 60_000;
    }
    if (!/^\d+$/u.test(normalized)) {
        throw new TypeError("MIRA_DASHBOARD_RECENT_AUTH_MINUTES must be an integer");
    }
    const minutes = Number(normalized);
    if (
        !Number.isSafeInteger(minutes) ||
        minutes < MINIMUM_RECENT_AUTHENTICATION_MINUTES ||
        minutes > MAXIMUM_RECENT_AUTHENTICATION_MINUTES
    ) {
        throw new RangeError(
            `MIRA_DASHBOARD_RECENT_AUTH_MINUTES must be ${MINIMUM_RECENT_AUTHENTICATION_MINUTES}-${MAXIMUM_RECENT_AUTHENTICATION_MINUTES}`
        );
    }
    return minutes * 60_000;
}

/** Fails startup before serving requests when authentication timing config is unsafe. */
export function validateAuthenticationConfig(): void {
    sessionIdleTtlMs();
    recentAuthenticationTtlMs();
}

function isRecentTimestamp(
    timestamp: string | undefined,
    now: Date,
    ttlMs: number
): boolean {
    if (!timestamp) return false;
    const parsed = Date.parse(timestamp);
    const age = now.getTime() - parsed;
    return Number.isFinite(parsed) && age >= -60_000 && age <= ttlMs;
}

/**
 * Returns whether the current session has a recent password verification.
 * @returns Whether the current session has a recent password verification.
 */
export function hasRecentPasswordVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return (
        session.elevatedMethod === "password" &&
        isRecentTimestamp(session.elevatedAt, now, recentAuthenticationTtlMs())
    );
}

/**
 * Returns whether the current session has a recent second-factor verification.
 * @returns Whether the current session has a recent second-factor verification.
 */
export function hasRecentMfaVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return isRecentTimestamp(session.mfaVerifiedAt, now, recentAuthenticationTtlMs());
}

/**
 * Inserts a session and returns its selector-validator token.
 * @param userId Dashboard user identifier.
 * @param options Session creation options.
 * @returns Newly created session token.
 */
function insertSession(userId: number, options: CreateSessionOptions = {}): string {
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
