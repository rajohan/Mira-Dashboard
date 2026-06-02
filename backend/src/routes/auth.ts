import type express from "express";

import {
    bootstrapRequired,
    clearSessionCookie,
    createFirstUser,
    createSession,
    createUser,
    deleteSession,
    findUserByUsername,
    getAuthUserFromRequest,
    getPersistedGatewayToken,
    persistGatewayToken,
    setSessionCookie,
    verifyPassword,
} from "../auth.js";
import { db } from "../db.js";
import gateway from "../gateway.js";

/** Performs read session ID. */
function readSessionId(cookieHeader?: string): string | null {
    if (!cookieHeader) {
        return null;
    }

    for (const part of cookieHeader.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("mira_dashboard_session=")) {
            return decodeURIComponent(trimmed.slice("mira_dashboard_session=".length));
        }
    }

    return null;
}

/** Validates username. */
function validateUsername(username: unknown): string | null {
    if (typeof username !== "string") {
        return null;
    }

    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/u.test(normalized)) {
        return null;
    }

    return normalized;
}

/** Validates password. */
function validatePassword(password: unknown): string | null {
    if (typeof password !== "string") {
        return null;
    }

    if (password.length < 8 || password.length > 256) {
        return null;
    }

    return password;
}

function rollbackFirstUserBootstrap(
    userId: number,
    gatewayToken: string,
    previousGatewayToken: string | null = null,
    persistToken: typeof persistGatewayToken = persistGatewayToken
): void {
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        if (previousGatewayToken) {
            persistToken(previousGatewayToken);
        } else {
            db.prepare(
                "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
            ).run(gatewayToken);
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch (rollbackError) {
            console.error(
                "[Auth] First-user rollback transaction rollback failed:",
                rollbackError
            );
            throw new AggregateError(
                [error, rollbackError],
                "First-user rollback transaction and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

export const __testing = {
    readSessionId,
    rollbackFirstUserBootstrap,
    validateUsername,
    validatePassword,
};

/** Registers auth API routes. */
export default function authRoutes(
    app: express.Application,
    dependencies: {
        createSession?: typeof createSession;
        createUser?: typeof createUser;
        getPersistedGatewayToken?: typeof getPersistedGatewayToken;
        initGateway?: typeof gateway.init;
        persistGatewayToken?: typeof persistGatewayToken;
        rollbackBootstrap?: typeof rollbackFirstUserBootstrap;
        setSessionCookie?: typeof setSessionCookie;
        shutdownGateway?: typeof gateway.shutdown;
    } = {}
): void {
    const createAuthSession = dependencies.createSession ?? createSession;
    const createAuthUser = dependencies.createUser ?? createUser;
    const createFirstAuthUser =
        dependencies.createUser === undefined
            ? createFirstUser
            : (username: string, password: string) =>
                  bootstrapRequired() ? createAuthUser(username, password) : null;
    const initGateway =
        dependencies.initGateway ?? ((token: string) => gateway.init(token));
    const persistAuthGatewayToken =
        dependencies.persistGatewayToken ?? persistGatewayToken;
    const getPersistedAuthGatewayToken =
        dependencies.getPersistedGatewayToken ?? getPersistedGatewayToken;
    const rollbackBootstrap =
        dependencies.rollbackBootstrap ??
        ((userId: number, token: string, previousToken: string | null = null): void =>
            rollbackFirstUserBootstrap(
                userId,
                token,
                previousToken,
                persistAuthGatewayToken
            ));
    const setAuthSessionCookie = dependencies.setSessionCookie ?? setSessionCookie;
    const shutdownGateway = dependencies.shutdownGateway ?? (() => gateway.shutdown());

    app.get("/api/auth/bootstrap", (_request, response) => {
        response.json({
            bootstrapRequired: bootstrapRequired(),
            hasGatewayToken: Boolean(getPersistedAuthGatewayToken()),
        });
    });

    app.get("/api/auth/session", (request, response) => {
        const user = getAuthUserFromRequest(request);
        response.json({
            authenticated: Boolean(user),
            bootstrapRequired: bootstrapRequired(),
            user,
        });
    });

    app.post("/api/auth/register-first-user", (request, response) => {
        const username = validateUsername(request.body?.username);
        const password = validatePassword(request.body?.password);
        const rawGatewayToken = request.body?.gatewayToken;
        if (!username) {
            response.status(400).json({
                error: "Username must be 3-32 chars: letters, numbers, dot, dash, underscore",
            });
            return;
        }
        if (!password) {
            response.status(400).json({ error: "Password must be 8-256 characters" });
            return;
        }
        if (typeof rawGatewayToken !== "string" || !rawGatewayToken.trim()) {
            response
                .status(400)
                .json({ error: "Gateway token is required for first-user setup" });
            return;
        }
        const gatewayToken = rawGatewayToken.trim();
        let user: ReturnType<typeof createUser>;
        try {
            const createdUser = createFirstAuthUser(username, password);
            if (!createdUser) {
                response.status(409).json({
                    error: "Bootstrap registration is no longer available",
                });
                return;
            }
            user = createdUser;
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : String(error_);
            if (message.includes("UNIQUE")) {
                response.status(409).json({ error: "Username already exists" });
                return;
            }
            response.status(500).json({ error: "Failed to create first user" });
            return;
        }

        let previousGatewayToken: string | null = null;
        let attemptedGatewaySwitch = false;
        try {
            previousGatewayToken = getPersistedAuthGatewayToken();
            persistAuthGatewayToken(gatewayToken);
            attemptedGatewaySwitch = true;
            initGateway(gatewayToken);
            const sessionId = createAuthSession(user.id);
            setAuthSessionCookie(response, sessionId, request);
            response.status(201).json({ authenticated: true, user });
        } catch (bootstrapError) {
            console.error("[Auth] First-user bootstrap failed:", bootstrapError);
            try {
                rollbackBootstrap(user.id, gatewayToken, previousGatewayToken);
            } catch (rollbackError) {
                console.error(
                    "[Auth] First-user bootstrap rollback failed:",
                    rollbackError
                );
            }
            if (attemptedGatewaySwitch) {
                try {
                    shutdownGateway();
                } catch {
                    // Preserve the original bootstrap failure response.
                }
                if (previousGatewayToken) {
                    try {
                        initGateway(previousGatewayToken);
                    } catch {
                        // Preserve the original bootstrap failure response.
                    }
                }
            }
            response.status(500).json({ error: "Failed to complete first-user setup" });
        }
    });

    app.post("/api/auth/login", (request, response) => {
        if (bootstrapRequired()) {
            response
                .status(409)
                .json({ error: "Create the first user before logging in" });
            return;
        }

        const username = validateUsername(request.body?.username);
        const password = validatePassword(request.body?.password);

        if (!username || !password) {
            response.status(400).json({ error: "Username and password are required" });
            return;
        }

        const user = findUserByUsername(username);
        if (!user || !verifyPassword(password, user.password_hash)) {
            response.status(401).json({ error: "Invalid username or password" });
            return;
        }

        const sessionId = createAuthSession(user.id);
        setAuthSessionCookie(response, sessionId, request);
        response.json({
            authenticated: true,
            user: { id: user.id, username: user.username },
        });
    });

    app.post("/api/auth/logout", (request, response) => {
        const sessionId = readSessionId(request.headers.cookie);
        if (sessionId) {
            deleteSession(sessionId);
        }
        clearSessionCookie(response, request);
        response.json({ ok: true });
    });
}
