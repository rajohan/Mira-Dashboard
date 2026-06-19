import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import type express from "express";

import { database } from "./database.ts";

const SESSION_COOKIE = "mira_dashboard_session";
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

const LOOPBACK_USER: AuthUser = {
    id: 0,
    username: "mira-local",
};

/** Parses cookies. */
function parseCookies(cookieHeader?: string): Record<string, string> {
    if (!cookieHeader) {
        return {};
    }

    return Object.fromEntries(
        cookieHeader
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const index = part.indexOf("=");
                if (index === -1) {
                    return [part, ""];
                }
                return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
            })
    );
}

/** Returns session ID from cookie header. */
function getSessionIdFromCookieHeader(cookieHeader?: string): string | null {
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies[SESSION_COOKIE];
    return sessionId || null;
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

/** Returns whether production. */
function isProduction(request?: IncomingMessage): boolean {
    if (process.env.NODE_ENV === "production") {
        return true;
    }

    const forwardedProtocol = request?.headers["x-forwarded-proto"];
    const trustedProxyIps = new Set(
        (process.env.MIRA_DASHBOARD_TRUSTED_PROXY_IPS || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
    );
    const peerAddress = request?.socket.remoteAddress;
    const isTrustedProxy =
        isLoopbackAddress(peerAddress) ||
        (peerAddress ? trustedProxyIps.has(peerAddress) : false);

    if (isTrustedProxy && typeof forwardedProtocol === "string") {
        return forwardedProtocol.split(",", 1)[0]?.trim() === "https";
    }
    return false;
}

/** Returns whether loopback address. */
function isLoopbackAddress(address?: string | null): boolean {
    if (!address) {
        return false;
    }

    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function forwardedAddresses(forwardedFor: string): string[] {
    return forwardedFor
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
}

function clientAddressFromTrustedChain(
    peerAddress: string | undefined,
    forwardedFor: string
): string | undefined {
    let clientAddress = peerAddress;
    const forwardedChain = forwardedAddresses(forwardedFor);
    for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
        const address = forwardedChain[index];
        clientAddress = address;
        if (!isLoopbackAddress(address)) {
            break;
        }
    }

    return clientAddress;
}

function remoteAddress(request: express.Request | IncomingMessage): string | undefined {
    return request.socket?.remoteAddress ?? request.connection?.remoteAddress;
}

/** Returns whether loopback request. */
export function isLoopbackRequest(request: express.Request | IncomingMessage): boolean {
    const peerAddress = remoteAddress(request);
    const isTrustForwardedHeaders = isLoopbackAddress(peerAddress);
    const headers = request.headers ?? {};
    const realIp = headerValue(headers["x-real-ip"]);
    if (isTrustForwardedHeaders && realIp) {
        return isLoopbackAddress(realIp.trim());
    }
    const forwardedFor = headerValue(headers["x-forwarded-for"]);
    if (isTrustForwardedHeaders && forwardedFor) {
        return isLoopbackAddress(
            clientAddressFromTrustedChain(peerAddress, forwardedFor)
        );
    }
    return isLoopbackAddress(peerAddress);
}

/** Performs hash password. */
export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

/** Performs verify password. */
export function isPasswordVerified(password: string, storedHash: string): boolean {
    const [algorithm, salt, hash] = storedHash.split(":");
    if (algorithm !== "scrypt" || !salt || !hash) {
        return false;
    }

    const derivedKey = crypto.scryptSync(password, salt, 64);
    const storedBuffer = Buffer.from(hash, "hex");

    if (storedBuffer.length !== derivedKey.length) {
        return false;
    }

    return crypto.timingSafeEqual(storedBuffer, derivedKey);
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
export function findUserByUsername(username: string): UserRow | null {
    const row = database
        .prepare(
            `SELECT id, username, password_hash, created_at, updated_at
             FROM users
             WHERE username = ?`
        )
        .get(normalizeUsername(username)) as UserRow | undefined;
    return row || null;
}

/** Creates user. */
export function createUser(username: string, password: string): AuthUser {
    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = hashPassword(password);

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
export function createFirstUser(username: string, password: string): AuthUser | null {
    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = hashPassword(password);
    const rollback = (transactionError?: unknown) => {
        try {
            database.exec("ROLLBACK");
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

    database.exec("BEGIN IMMEDIATE");
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
            return null;
        }
        database.exec("COMMIT");
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
export function getPersistedGatewayToken(): string | null {
    const row = database
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as undefined | { value: string };
    return row?.value || null;
}

/** Creates session. */
export function createSession(userId: number): string {
    const sessionId = crypto.randomBytes(32).toString("hex");
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
export function getAuthUserFromSessionId(sessionId: string): AuthUser | null {
    cleanupExpiredSessions();

    const row = database
        .prepare(
            `SELECT u.id, u.username
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ?`
        )
        .get(sessionId, nowIso()) as AuthUser | undefined;

    return row || null;
}

/** Returns auth user from request. */
export function getAuthUserFromRequest(
    request: express.Request | IncomingMessage
): AuthUser | null {
    if (isLoopbackRequest(request)) {
        return LOOPBACK_USER;
    }

    const sessionId = getSessionIdFromCookieHeader(request.headers.cookie);
    if (!sessionId) {
        return null;
    }
    return getAuthUserFromSessionId(sessionId);
}

/** Performs set session cookie. */
export function setSessionCookie(
    response: express.Response,
    sessionId: string,
    request: express.Request
): void {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const isSecure = isProduction(request);
    const cookieParts = [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${maxAge}`,
    ];

    if (isSecure) {
        cookieParts.push("Secure");
    }

    response.setHeader("Set-Cookie", cookieParts.join("; "));
}

/** Performs clear session cookie. */
export function clearSessionCookie(
    response: express.Response,
    request: express.Request
): void {
    const isSecure = isProduction(request);
    const cookieParts = [
        `${SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0",
    ];

    if (isSecure) {
        cookieParts.push("Secure");
    }

    response.setHeader("Set-Cookie", cookieParts.join("; "));
}

/** Performs reqUIre auth. */
export function requireAuth(
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
): void {
    const user = getAuthUserFromRequest(request);
    if (!user) {
        response.status(401).json({ error: "Unauthorized" });
        return;
    }

    request.user = user;
    next();
}

declare module "express-serve-static-core" {
    /** Represents request. */
    interface Request {
        user?: AuthUser;
    }
}
