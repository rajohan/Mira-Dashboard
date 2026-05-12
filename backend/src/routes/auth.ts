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
import gateway from "../gateway.js";

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

function validatePassword(password: unknown): string | null {
    if (typeof password !== "string") {
        return null;
    }

    if (password.length < 8 || password.length > 256) {
        return null;
    }

    return password;
}

export default function authRoutes(app: express.Application): void {
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
        const gatewayToken =
            typeof request.body?.gatewayToken === "string"
                ? request.body.gatewayToken.trim()
                : "";

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

        if (!gatewayToken) {
            response
                .status(400)
                .json({ error: "Gateway token is required for first-user setup" });
            return;
        }

        try {
            const user = createUser(username, password);
            persistGatewayToken(gatewayToken);
            gateway.init(gatewayToken);
            const sessionId = createSession(user.id);
            setSessionCookie(response, sessionId, request);
            response.status(201).json({ authenticated: true, user });
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : String(error_);
            if (message.includes("UNIQUE")) {
                response.status(409).json({ error: "Username already exists" });
                return;
            }

            response.status(500).json({ error: "Failed to create first user" });
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

        const sessionId = createSession(user.id);
        setSessionCookie(response, sessionId, request);
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
