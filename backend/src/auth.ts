import { database } from "./database.ts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/** Represents one user row. */
interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    created_at: string;
    updated_at: string;
}

/** Represents auth user. */
export interface AuthUser {
    id: number;
    username: string;
}

/** Performs now iso. */
function nowIso(): string {
    const now = new Date();
    return now.toISOString();
}

/** Normalizes username. */
function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

/** Hashes a password with Bun's runtime password hashing API. */
export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password);
}

/** Returns cryptographically secure random bytes as hex using Bun's Web Crypto runtime. */
function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString("hex");
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

/** Returns user count. */
export function getUserCount(): number {
    const row = database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
    };
    return row.count;
}

/** Performs bootstrap reqUIred. */
export function isBootstrapRequired(): boolean {
    return getUserCount() === 0;
}

/** Performs find user by username. */
export function findUserByUsername(username: string): UserRow | undefined {
    const row = database
        .prepare(
            `SELECT id, username, password_hash, created_at, updated_at
             FROM users
             WHERE username = ?`
        )
        .get(normalizeUsername(username)) as UserRow | undefined;
    return row || undefined;
}

/** Creates user. */
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

/** Performs persist gateway token. */
export function persistGatewayToken(token: string): void {
    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO app_config (key, value, updated_at)
         VALUES ('gateway_token', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(token, timestamp);
}

/** Returns persisted gateway token. */
export function getPersistedGatewayToken(): string | undefined {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    return row?.value || undefined;
}

/** Creates session. */
export function createSession(userId: number): string {
    const sessionId = randomHex(32);
    const expiresAtDate = new Date(Date.now() + SESSION_TTL_MS);
    const expiresAt = expiresAtDate.toISOString();
    const createdAt = nowIso();

    database
        .prepare(
            `INSERT INTO auth_sessions (id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
        )
        .run(sessionId, userId, createdAt, expiresAt);

    return sessionId;
}

/** Performs delete session. */
export function deleteSession(sessionId: string): void {
    database.prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionId);
}

/** Performs cleanup expired sessions. */
export function cleanupExpiredSessions(): void {
    database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(nowIso());
}

/** Returns auth user from session ID. */
export function getAuthUserFromSessionId(sessionId: string): AuthUser | undefined {
    cleanupExpiredSessions();

    const row = database
        .prepare(
            `SELECT u.id, u.username
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ?`
        )
        .get(sessionId, nowIso()) as AuthUser | undefined;

    return row || undefined;
}
