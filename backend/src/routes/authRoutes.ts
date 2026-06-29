import type { Server } from "bun";

import {
    createFirstUser,
    createSession,
    createUser,
    deleteSession,
    findUserByUsername,
    getPersistedGatewayToken,
    isBootstrapRequired,
    isPasswordVerified,
    persistGatewayToken,
} from "../auth.ts";
import { database } from "../database.ts";
import gateway from "../gateway.ts";
import {
    authUser,
    clearSessionCookie,
    json,
    readJson,
    sessionCookie,
    sessionIdFromCookie,
    withCookie,
} from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";

interface AuthBody {
    gatewayToken?: unknown;
    password?: unknown;
    username?: unknown;
}

async function readAuthBody(request: Request): Promise<AuthBody | Response> {
    try {
        const body = await readJson<unknown>(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Invalid request body" }, { status: 400 });
        }
        return body as AuthBody;
    } catch (error) {
        return json(
            { error: errorMessage(error, "Invalid request body") },
            { status: httpStatusCode(error) }
        );
    }
}

function validateUsername(username: unknown): string | undefined {
    if (typeof username !== "string") {
        return undefined;
    }
    const normalized = username.trim().toLowerCase();
    return /^[a-z0-9._-]{3,32}$/u.test(normalized) ? normalized : undefined;
}

function validatePassword(password: unknown): string | undefined {
    return typeof password === "string" && password.length >= 8 && password.length <= 256
        ? password
        : undefined;
}

function rollbackFirstUserBootstrap(
    userId: number,
    gatewayToken: string,
    previousGatewayToken?: string | undefined
): void {
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        if (previousGatewayToken) {
            persistGatewayToken(previousGatewayToken);
        } else {
            database
                .prepare(
                    "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
                )
                .run(gatewayToken);
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
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

function rollbackCreatedFirstUser(userId: number): void {
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            console.error(
                "[Auth] First-user cleanup transaction rollback failed:",
                rollbackError
            );
            throw new AggregateError(
                [error, rollbackError],
                "First-user cleanup transaction and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

function rollbackGatewayTokenSwitch(
    gatewayToken: string,
    previousGatewayToken?: string | undefined
): void {
    database.run("BEGIN IMMEDIATE");
    try {
        if (previousGatewayToken) {
            persistGatewayToken(previousGatewayToken);
        } else {
            database
                .prepare(
                    "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
                )
                .run(gatewayToken);
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            console.error(
                "[Auth] Gateway token rollback transaction rollback failed:",
                rollbackError
            );
            throw new AggregateError(
                [error, rollbackError],
                "Gateway token rollback transaction and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

function responseForClosedBootstrap(): Response {
    return json(
        { error: "Bootstrap registration is no longer available" },
        { status: 409 }
    );
}

function isGatewayAuthFailure(error: unknown): boolean {
    const message = errorMessage(error, String(error)).toLowerCase();
    return message.includes("unauthorized") || message.includes("token mismatch");
}

function environmentGatewayToken(): string | undefined {
    return (
        process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
        process.env.OPENCLAW_TOKEN?.trim() ||
        undefined
    );
}

export const authRoutes = {
    "/api/auth/bootstrap": {
        GET: () =>
            json({
                isBootstrapRequired: isBootstrapRequired(),
                hasGatewayToken: Boolean(getPersistedGatewayToken()),
            }),
    },

    "/api/auth/session": {
        GET: (request: Request, server: Server<unknown>) => {
            const needsBootstrap = isBootstrapRequired();
            const user = needsBootstrap ? undefined : authUser(request, server);
            return json({
                authenticated: Boolean(user),
                isBootstrapRequired: needsBootstrap,
                user,
            });
        },
    },

    "/api/auth/register-first-user": {
        POST: async (request: Request, server: Server<unknown>) => {
            const body = await readAuthBody(request);
            if (body instanceof Response) return body;
            const username = validateUsername(body.username);
            if (!username) {
                return json(
                    {
                        error: "Username must be 3-32 chars: letters, numbers, dot, dash, underscore",
                    },
                    { status: 400 }
                );
            }
            const password = validatePassword(body.password);
            if (!password) {
                return json(
                    { error: "Password must be 8-256 characters" },
                    { status: 400 }
                );
            }
            const rawGatewayToken = body.gatewayToken;
            if (typeof rawGatewayToken !== "string" || !rawGatewayToken.trim()) {
                return json(
                    { error: "Gateway token is required for first-user setup" },
                    { status: 400 }
                );
            }
            const gatewayToken = rawGatewayToken.trim();
            let user: Awaited<ReturnType<typeof createUser>> | undefined;
            let previousGatewayToken: string | undefined;
            let previousActiveGatewayToken: string | undefined;
            let isAttemptedGatewaySwitch = false;
            try {
                previousGatewayToken = getPersistedGatewayToken();
                previousActiveGatewayToken =
                    environmentGatewayToken() || previousGatewayToken?.trim();
                persistGatewayToken(gatewayToken);
                isAttemptedGatewaySwitch = true;
                await gateway.initAndWait(gatewayToken);
                const createdUser = await createFirstUser(username, password);
                if (!createdUser) {
                    rollbackGatewayTokenSwitch(gatewayToken, previousGatewayToken);
                    if (previousActiveGatewayToken) {
                        gateway.init(previousActiveGatewayToken);
                    }
                    return responseForClosedBootstrap();
                }
                user = createdUser;
                const sessionId = createSession(user.id);
                return withCookie(
                    json(
                        {
                            authenticated: true,
                            user: { id: user.id, username: user.username },
                        },
                        { status: 201 }
                    ),
                    sessionCookie(request, server, sessionId)
                );
            } catch (bootstrapError) {
                console.error("[Auth] First-user bootstrap failed:", bootstrapError);
                let isRollbackFailed = false;
                if (isAttemptedGatewaySwitch) {
                    try {
                        if (user) {
                            rollbackFirstUserBootstrap(
                                user.id,
                                gatewayToken,
                                previousGatewayToken
                            );
                        } else {
                            rollbackGatewayTokenSwitch(
                                gatewayToken,
                                previousGatewayToken
                            );
                        }
                    } catch (rollbackError) {
                        isRollbackFailed = true;
                        console.error(
                            "[Auth] First-user bootstrap rollback failed:",
                            rollbackError
                        );
                    }
                } else if (user) {
                    try {
                        rollbackCreatedFirstUser(user.id);
                    } catch (rollbackError) {
                        isRollbackFailed = true;
                        console.error("[Auth] First-user cleanup failed:", rollbackError);
                    }
                }
                if (isAttemptedGatewaySwitch && !isRollbackFailed) {
                    try {
                        gateway.shutdown();
                    } catch {
                        // Preserve the original bootstrap failure response.
                    }
                    if (previousActiveGatewayToken) {
                        try {
                            gateway.init(previousActiveGatewayToken);
                        } catch {
                            // Preserve the original bootstrap failure response.
                        }
                    }
                }
                const isAuthFailure = isGatewayAuthFailure(bootstrapError);
                return json(
                    {
                        error: isRollbackFailed
                            ? "Failed to roll back first-user bootstrap"
                            : isAuthFailure
                              ? "Invalid OpenClaw gateway token"
                              : "Failed to complete first-user setup",
                    },
                    { status: !isRollbackFailed && isAuthFailure ? 401 : 500 }
                );
            }
        },
    },

    "/api/auth/login": {
        POST: async (request: Request, server: Server<unknown>) => {
            if (isBootstrapRequired()) {
                return json(
                    { error: "Create the first user before logging in" },
                    { status: 409 }
                );
            }
            const body = await readAuthBody(request);
            if (body instanceof Response) return body;
            const username = validateUsername(body.username);
            const password = validatePassword(body.password);
            if (!username || !password) {
                return json(
                    { error: "Username and password are required" },
                    { status: 400 }
                );
            }
            const user = findUserByUsername(username);
            if (!user || !(await isPasswordVerified(password, user.password_hash))) {
                return json({ error: "Invalid username or password" }, { status: 401 });
            }
            const sessionId = createSession(user.id);
            return withCookie(
                json({
                    authenticated: true,
                    user: { id: user.id, username: user.username },
                }),
                sessionCookie(request, server, sessionId)
            );
        },
    },

    "/api/auth/logout": {
        POST: (request: Request, server: Server<unknown>) => {
            const sessionId = sessionIdFromCookie(request);
            if (sessionId) {
                deleteSession(sessionId);
            }
            return withCookie(json({ isOk: true }), clearSessionCookie(request, server));
        },
    },
} as const;
