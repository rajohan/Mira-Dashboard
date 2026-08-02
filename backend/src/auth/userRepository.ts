import type { DashboardUser } from "../../../contracts/auth.ts";
import { database } from "../database/connection.ts";
import {
    decryptStoredSecret,
    encryptStoredSecret,
    secretEncryptionKeyBytes,
} from "../services/mfaCrypto.ts";

const GATEWAY_TOKEN_ASSOCIATED_DATA = "mira-dashboard:app-config:v1:gateway-token";

export interface UserRow {
    created_at: string;
    id: number;
    mfa_enabled_at: string | null;
    password_hash: string;
    updated_at: string;
    username: string;
}

function rollbackFirstUserTransaction(transactionError?: unknown): void {
    try {
        database.run("ROLLBACK");
    } catch (rollbackError) {
        if (transactionError !== undefined) {
            const rollbackFailure = new AggregateError(
                [transactionError, rollbackError],
                "First-user transaction and rollback failed",
                { cause: transactionError }
            );
            throw rollbackFailure;
        }
        throw rollbackError;
    }
}

function nowIso(now = new Date()): string {
    return now.toISOString();
}

/**
 * Normalizes a Dashboard username.
 * @param username Username value.
 * @returns Normalized a Dashboard username.
 */
function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

/**
 * Hashes a password with Bun's runtime password hashing API.
 * @param password Password value.
 * @returns Promise resolving to the hash password result.
 */
export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password);
}

/**
 * Verifies a password against a stored Bun password hash.
 * @param password Candidate password.
 * @param storedHash Stored password hash.
 * @returns Whether the password matches the stored hash.
 */
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

/**
 * Returns the number of Dashboard users.
 * @returns the number of Dashboard users.
 */
export function getUserCount(): number {
    const row = database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
    };
    return row.count;
}

/**
 * Returns whether first-user bootstrap is still available.
 * @returns Whether first-user bootstrap is still available.
 */
export function isBootstrapRequired(): boolean {
    return getUserCount() === 0;
}

/**
 * Finds a user by normalized username.
 * @param username Username value.
 * @returns Located a user by normalized username.
 */
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

/**
 * Finds a user by internal identifier.
 * @param userId User identifier.
 * @returns Located a user by internal identifier.
 */
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

/**
 * Creates a Dashboard user.
 * @param username Username value.
 * @param password Password value.
 * @returns Created a Dashboard user.
 */
export async function createUser(
    username: string,
    password: string
): Promise<DashboardUser> {
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

/**
 * Atomically creates the first user only when no users exist.
 * @param username Username value.
 * @param password Password value.
 * @returns Promise resolving to the create first user result.
 */
export async function createFirstUser(
    username: string,
    password: string
): Promise<DashboardUser | undefined> {
    if (getUserCount() > 0) {
        return undefined;
    }

    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = await hashPassword(password);

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
            rollbackFirstUserTransaction();
            return undefined;
        }
        database.run("COMMIT");
        return {
            id: Number(result.lastInsertRowid),
            username: normalizedUsername,
        };
    } catch (error) {
        rollbackFirstUserTransaction(error);
        throw error;
    }
}

/**
 * Persists the server-side OpenClaw Gateway token.
 * @param token Token value.
 */
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

/**
 * Returns the persisted OpenClaw Gateway token.
 * @returns the persisted OpenClaw Gateway token.
 */
export function getPersistedGatewayToken(): string | undefined {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    if (!row?.value) {
        return undefined;
    }
    return decryptStoredSecret(row.value, GATEWAY_TOKEN_ASSOCIATED_DATA);
}

/**
 * Deletes the encrypted persisted Gateway token only when its plaintext matches.
 * @param token Token value.
 * @returns Did delete persisted gateway token if matches result.
 */
export function didDeletePersistedGatewayTokenIfMatches(token: string): boolean {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    if (!row?.value) {
        return false;
    }
    const currentToken = decryptStoredSecret(row.value, GATEWAY_TOKEN_ASSOCIATED_DATA);
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

/** Requires the external key and validates any persisted encrypted Gateway token. */
export function validateStoredSecretConfig(): void {
    secretEncryptionKeyBytes();
    getPersistedGatewayToken();
}
