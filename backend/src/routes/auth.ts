import type express from "express";

import {
    bootstrapRequired,
    clearSessionCookie,
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

function rollbackFirstUserBootstrap(userId: number, gatewayToken: string): void {
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    db.prepare("DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?").run(
        gatewayToken
    );
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
        initGateway?: typeof gateway.init;
        persistGatewayToken?: typeof persistGatewayToken;
        setSessionCookie?: typeof setSessionCookie;
    } = {}
): void {
    const createAuthSession = dependencies.createSession ?? createSession;
    const createAuthUser = dependencies.createUser ?? createUser;
    const initGateway =
        dependencies.initGateway ?? ((token: string) => gateway.init(token));
    const persistAuthGatewayToken =
        dependencies.persistGatewayToken ?? persistGatewayToken;
    const setAuthSessionCookie = dependencies.setSessionCookie ?? setSessionCookie;

    app.get("/api/auth/bootstrap", (_request, response) => {
        response.json({
            bootstrapRequired: bootstrapRequired(),
            hasGatewayToken: Boolean(getPersistedGatewayToken()),
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
        if (!bootstrapRequired()) {
            response
                .status(409)
                .json({ error: "Bootstrap registration is no longer available" });
            return;
        }
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
            user = createAuthUser(username, password);
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : String(error_);
            if (message.includes("UNIQUE")) {
                response.status(409).json({ error: "Username already exists" });
                return;
            }
            response.status(500).json({ error: "Failed to create first user" });
            return;
        }

        try {
            persistAuthGatewayToken(gatewayToken);
            initGateway(gatewayToken);
            const sessionId = createAuthSession(user.id);
            setAuthSessionCookie(response, sessionId, request);
            response.status(201).json({ authenticated: true, user });
        } catch {
            rollbackFirstUserBootstrap(user.id, gatewayToken);
            gateway.shutdown();
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
