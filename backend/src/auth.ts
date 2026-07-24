import { database, sqlNullable } from "./database.ts";
import {
    decryptStoredSecret,
    encryptStoredSecret,
    isEncryptedStoredSecret,
    secretEncryptionKeyBytes,
} from "./services/mfaCrypto.ts";

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
const GATEWAY_TOKEN_ASSOCIATED_DATA = "mira-dashboard:app-config:v1:gateway-token";

export type AuthMethod = "password" | "recovery" | "totp" | "webauthn";

/** Represents one user row. */
export interface UserRow {
    created_at: string;
    id: number;
    mfa_enabled_at: string | null;
    password_hash: string;
    updated_at: string;
    username: string;
}

/** Represents an authenticated Dashboard user. */
export interface AuthUser {
    id: number;
    username: string;
}

interface SessionRow extends AuthUser {
    auth_method: AuthMethod | null;
    authenticated_at: string | null;
    created_at: string;
    elevated_at: string | null;
    elevated_method: AuthMethod | null;
    expires_at: string;
    last_seen_at: string | null;
    mfa_enabled_at: string | null;
    mfa_verified_at: string | null;
    session_id: string;
    user_agent: string | null;
    validator_hash: string | null;
}

export interface AuthSession extends AuthUser {
    authMethod: AuthMethod;
    authenticatedAt: string;
    createdAt: string;
    elevatedAt?: string;
    elevatedMethod?: AuthMethod;
    expiresAt: string;
    lastSeenAt: string;
    mfaEnabled: boolean;
    mfaVerifiedAt?: string;
    sessionId: string;
    userAgent?: string;
}

export interface AuthSessionSummary {
    authMethod: AuthMethod;
    authenticatedAt: string;
    createdAt: string;
    elevatedAt?: string;
    elevatedMethod?: AuthMethod;
    expiresAt: string;
    isCurrent: boolean;
    lastSeenAt: string;
    mfaVerifiedAt?: string;
    sessionId: string;
    userAgent?: string;
}

interface CreateSessionOptions {
    authMethod?: AuthMethod;
    authenticatedAt?: string;
    elevatedAt?: string;
    elevatedMethod?: AuthMethod;
    mfaVerifiedAt?: string;
    now?: Date;
    userAgent?: string;
}

/** Returns the current time in the database timestamp format. */
function nowIso(now = new Date()): string {
    return now.toISOString();
}

/** Normalizes a Dashboard username. */
function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

/** Hashes a password with Bun's runtime password hashing API. */
export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password);
}

/** Returns cryptographically secure random bytes as lowercase hex. */
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

/** Returns the non-secret selector portion of a valid session token. */
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

/** Resolves the idle timeout while keeping unsafe environment values fail-closed. */
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

/** Resolves the bounded window used for privileged account-security actions. */
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

/** Returns whether the current session has a recent password verification. */
export function hasRecentPasswordVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return (
        session.elevatedMethod === "password" &&
        isRecentTimestamp(session.elevatedAt, now, recentAuthenticationTtlMs())
    );
}

/** Returns whether the current session has a recent second-factor verification. */
export function hasRecentMfaVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return isRecentTimestamp(session.mfaVerifiedAt, now, recentAuthenticationTtlMs());
}

/** Verifies a password with Bun's runtime password hashing API. */
export async function verifyPassword(
    password: string,
    storedHash: string
): Promise<boolean> {
    try {
        return await Bun.password.verify(password, storedHash);
    } catch {
        return false;
    }
}

/** Returns the number of Dashboard users. */
export function getUserCount(): number {
    const row = database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
    };
    return row.count;
}

/** Returns whether first-user bootstrap is still available. */
export function isBootstrapRequired(): boolean {
    return getUserCount() === 0;
}

/** Finds a user by normalized username. */
export function findUserByUsername(username: string): UserRow | undefined {
    const row = database
        .prepare(
            `SELECT id,
                    username,
                    password_hash,
                    created_at,
                    updated_at,
                    mfa_enabled_at
             FROM users
             WHERE username = ?`
        )
        .get(normalizeUsername(username)) as UserRow | undefined;
    return row || undefined;
}

/** Finds a user by internal identifier. */
export function findUserById(userId: number): UserRow | undefined {
    return (
        (database
            .prepare(
                `SELECT id,
                        username,
                        password_hash,
                        created_at,
                        updated_at,
                        mfa_enabled_at
                 FROM users
                 WHERE id = ?`
            )
            .get(userId) as UserRow | undefined) || undefined
    );
}

/** Creates a Dashboard user. */
export async function createUser(username: string, password: string): Promise<AuthUser> {
    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = await hashPassword(password);

    const result = database
        .prepare(
            `INSERT INTO users (username, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?)`
        )
        .run(normalizedUsername, passwordHash, timestamp, timestamp);

    return {
        id: Number(result.lastInsertRowid),
        username: normalizedUsername,
    };
}

/** Atomically creates the first user only when no users exist. */
export async function createFirstUser(
    username: string,
    password: string
): Promise<AuthUser | undefined> {
    if (getUserCount() > 0) {
        return undefined;
    }

    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = await hashPassword(password);
    const rollback = (transactionError?: unknown) => {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            if (transactionError) {
                throw new AggregateError(
                    [transactionError, rollbackError],
                    "First-user transaction and rollback failed",
                    { cause: rollbackError }
                );
            }
            throw rollbackError;
        }
    };

    database.run("BEGIN IMMEDIATE");
    try {
        const result = database
            .prepare(
                `INSERT INTO users (username, password_hash, created_at, updated_at)
                 SELECT ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM users)`
            )
            .run(normalizedUsername, passwordHash, timestamp, timestamp);
        if (result.changes === 0) {
            rollback();
            return undefined;
        }
        database.run("COMMIT");
        return {
            id: Number(result.lastInsertRowid),
            username: normalizedUsername,
        };
    } catch (error) {
        rollback(error);
        throw error;
    }
}

/** Persists the server-side OpenClaw Gateway token. */
export function persistGatewayToken(token: string): void {
    const timestamp = nowIso();
    const encryptedToken = encryptStoredSecret(token, GATEWAY_TOKEN_ASSOCIATED_DATA);
    database
        .prepare(
            `INSERT INTO app_config (key, value, updated_at)
             VALUES ('gateway_token', ?, ?)
             ON CONFLICT(key) DO UPDATE
             SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(encryptedToken, timestamp);
}

/** Returns the persisted OpenClaw Gateway token. */
export function getPersistedGatewayToken(): string | undefined {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    if (!row?.value) {
        return undefined;
    }
    if (isEncryptedStoredSecret(row.value)) {
        return decryptStoredSecret(row.value, GATEWAY_TOKEN_ASSOCIATED_DATA);
    }

    const encryptedToken = encryptStoredSecret(row.value, GATEWAY_TOKEN_ASSOCIATED_DATA);
    const upgraded = database
        .prepare(
            `UPDATE app_config
             SET value = ?, updated_at = ?
             WHERE key = 'gateway_token' AND value = ?`
        )
        .run(encryptedToken, nowIso(), row.value);
    if (upgraded.changes === 1) {
        return row.value;
    }
    const currentRow = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    return currentRow?.value
        ? decryptStoredSecret(currentRow.value, GATEWAY_TOKEN_ASSOCIATED_DATA)
        : undefined;
}

/** Deletes the encrypted persisted Gateway token only when its plaintext matches. */
export function didDeletePersistedGatewayTokenIfMatches(token: string): boolean {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    if (!row?.value) {
        return false;
    }
    const currentToken = isEncryptedStoredSecret(row.value)
        ? decryptStoredSecret(row.value, GATEWAY_TOKEN_ASSOCIATED_DATA)
        : row.value;
    const currentBytes = new TextEncoder().encode(currentToken);
    const expectedBytes = new TextEncoder().encode(token);
    const isMatch =
        currentBytes.byteLength === expectedBytes.byteLength &&
        crypto.timingSafeEqual(currentBytes, expectedBytes);
    return (
        isMatch &&
        database
            .prepare(
                `DELETE FROM app_config
                 WHERE key = 'gateway_token' AND value = ?`
            )
            .run(row.value).changes === 1
    );
}

/** Requires the external key and upgrades any legacy plaintext Gateway token. */
export function validateStoredSecretConfig(): void {
    secretEncryptionKeyBytes();
    getPersistedGatewayToken();
}

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

/** Creates a durable session with a hashed validator. */
export function createSession(
    userId: number,
    options: CreateSessionOptions = {}
): string {
    return insertSession(userId, options);
}

/** Deletes exactly the session addressed by a selector/validator token. */
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

/** Removes expired, idle, and pre-MFA legacy sessions. */
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

/** Resolves and optionally activity-touches one authenticated session. */
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
    cleanupExpiredSessions(now);
    const row = readSessionRow(parsedToken.selector);
    if (
        !row?.validator_hash ||
        !areSessionHashesEqual(row.validator_hash, parsedToken.validatorHash)
    ) {
        return undefined;
    }
    const session = sessionFromRow(row);
    if (!session) {
        return undefined;
    }

    const lastSeenAt = Date.parse(session.lastSeenAt);
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

/** Resolves the authenticated user represented by a session token. */
export function getAuthUserFromSessionId(
    sessionToken: string,
    options: { now?: Date; touchActivity?: boolean } = {}
): AuthUser | undefined {
    const session = getAuthSessionFromSessionId(sessionToken, options);
    return session ? { id: session.id, username: session.username } : undefined;
}

/** Rotates a session selector/validator and optionally records fresh elevation. */
export function rotateSession(
    sessionToken: string,
    options: Omit<CreateSessionOptions, "authenticatedAt"> & {
        authMethod?: AuthMethod;
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
            throw new AggregateError(
                [error, rollbackError],
                "Session rotation and rollback failed",
                { cause: rollbackError }
            );
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
            throw new AggregateError(
                [error, rollbackError],
                "Password change and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Lists the user's durable sessions without exposing validators. */
export function listUserSessions(
    userId: number,
    currentSessionId?: string
): AuthSessionSummary[] {
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
        auth_method: AuthMethod;
        authenticated_at: string;
        created_at: string;
        elevated_at: string | null;
        elevated_method: AuthMethod | null;
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

/** Revokes one session only when it belongs to the authenticated user. */
export function didRevokeUserSession(userId: number, sessionId: string): boolean {
    return (
        database
            .prepare("DELETE FROM auth_sessions WHERE id = ? AND user_id = ?")
            .run(sessionId, userId).changes === 1
    );
}

/** Revokes every session for a user, optionally preserving one selector. */
export function revokeUserSessions(userId: number, exceptSessionId?: string): number {
    const result = exceptSessionId
        ? database
              .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id != ?")
              .run(userId, exceptSessionId)
        : database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return result.changes;
}
