import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import type express from "express";

import { db } from "./db.js";

const SESSION_COOKIE = "mira_dashboard_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    created_at: string;
    updated_at: string;
}

export interface AuthUser {
    id: number;
    username: string;
}

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

function getSessionIdFromCookieHeader(cookieHeader?: string): string | null {
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies[SESSION_COOKIE];
    return sessionId || null;
}

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

function isProduction(request?: IncomingMessage): boolean {
    const forwardedProto = request?.headers["x-forwarded-proto"];
    if (typeof forwardedProto === "string") {
        return forwardedProto.split(",")[0]?.trim() === "https";
    }
    return process.env.NODE_ENV === "production";
}

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
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

export function getUserCount(): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return row.count;
}

export function bootstrapRequired(): boolean {
    return getUserCount() === 0;
}

export function findUserByUsername(username: string): UserRow | null {
    const row = db
        .prepare(
            `SELECT id, username, password_hash, created_at, updated_at
             FROM users
             WHERE username = ?`
        )
        .get(normalizeUsername(username)) as UserRow | undefined;

    return row || null;
}

export function createUser(username: string, password: string): AuthUser {
    const normalizedUsername = normalizeUsername(username);
    const timestamp = nowIso();
    const passwordHash = hashPassword(password);

    const result = db
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

export function persistGatewayToken(token: string): void {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES ('gateway_token', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(token, timestamp);
}

export function getPersistedGatewayToken(): string | null {
    const row = db
        .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
        .get() as { value: string } | undefined;
    return row?.value || null;
}

export function createSession(userId: number): string {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const createdAt = nowIso();

    db.prepare(
        `INSERT INTO auth_sessions (id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
    ).run(sessionId, userId, createdAt, expiresAt);

    return sessionId;
}

export function deleteSession(sessionId: string): void {
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionId);
}

export function cleanupExpiredSessions(): void {
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(nowIso());
}

export function getAuthUserFromSessionId(sessionId: string): AuthUser | null {
    cleanupExpiredSessions();

    const row = db
        .prepare(
            `SELECT u.id, u.username
             FROM auth_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ?`
        )
        .get(sessionId, nowIso()) as AuthUser | undefined;

    return row || null;
}

export function getAuthUserFromRequest(request: express.Request | IncomingMessage): AuthUser | null {
    const sessionId = getSessionIdFromCookieHeader(request.headers.cookie);
    if (!sessionId) {
        return null;
    }
    return getAuthUserFromSessionId(sessionId);
}

export function setSessionCookie(response: express.Response, sessionId: string, request: express.Request): void {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const secure = isProduction(request);
    const cookieParts = [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${maxAge}`,
    ];

    if (secure) {
        cookieParts.push("Secure");
    }

    response.setHeader("Set-Cookie", cookieParts.join("; "));
}

export function clearSessionCookie(response: express.Response, request: express.Request): void {
    const secure = isProduction(request);
    const cookieParts = [
        `${SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0",
    ];

    if (secure) {
        cookieParts.push("Secure");
    }

    response.setHeader("Set-Cookie", cookieParts.join("; "));
}

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

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}
