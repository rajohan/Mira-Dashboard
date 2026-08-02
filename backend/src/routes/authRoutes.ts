import type { Server } from "bun";

import type { DashboardMfaMethod } from "../../../contracts/accountSecurity.ts";
import type {
    AuthBootstrapResponse,
    AuthLoginResponse,
    AuthSessionResponse,
} from "../../../contracts/auth.ts";
import {
    parseFirstUserRegistrationRequest,
    parseLoginCredentialsRequest,
    parseLoginMfaCodeRequest,
    parseLoginWebAuthnRequest,
} from "../../../contracts/auth.ts";
import type { ContractParser } from "../../../contracts/runtime.ts";
import { createSession, deleteSession } from "../auth/sessionService.ts";
import {
    createFirstUser,
    createUser,
    didDeletePersistedGatewayTokenIfMatches,
    findUserByUsername,
    getPersistedGatewayToken,
    isBootstrapRequired,
    persistGatewayToken,
    verifyPassword,
} from "../auth/userRepository.ts";
import { database } from "../database/connection.ts";
import {
    authSession,
    clearPendingLoginCookie,
    clearSessionCookie,
    json,
    pendingLoginCookie,
    pendingLoginFromCookie,
    sessionCookie,
    sessionIdFromCookie,
    withCookies,
} from "../http/core.ts";
import { readApiJsonOrError, routeFailureResponse } from "../http/routeSupport.ts";
import { errorMessage } from "../lib/errors.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    authenticationThrottleResponse,
    normalizeLoginPassword,
    normalizeLoginUsername,
    normalizeSecondFactorCode,
    parseAuthenticationResponse,
} from "../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../services/authenticationThrottle.ts";
import gateway from "../services/gateway/runtime.ts";
import {
    mfaMethodsForUser,
    verifyRecoveryCodeForUser,
    verifyTotpForUser,
} from "../services/multiFactorAuth/factorService.ts";
import {
    consumePendingLogin,
    createPendingLogin,
    getPendingLogin,
    type PendingLogin,
    recordPendingLoginFailure,
} from "../services/multiFactorAuth/pendingLoginService.ts";
import {
    createWebAuthnAuthenticationOptions,
    verifyWebAuthnAuthentication,
} from "../services/webAuthn/service.ts";

const logger = createStructuredLogger("auth");

interface AuthWebAuthnDependencies {
    createAuthenticationOptions: typeof createWebAuthnAuthenticationOptions;
    verifyAuthentication: typeof verifyWebAuthnAuthentication;
}

const defaultWebAuthnDependencies: AuthWebAuthnDependencies = {
    createAuthenticationOptions: createWebAuthnAuthenticationOptions,
    verifyAuthentication: verifyWebAuthnAuthentication,
};

// A non-secret Argon2id verifier keeps unknown-user and wrong-password work comparable.
const UNKNOWN_USER_PASSWORD_HASH =
    "$argon2id$v=19$m=65536,t=2,p=1$f3HFQG8vpt61lN+oOECsgjKF/kekaeFRsKlTi+dn71Y$Xlpldr0SHTMjbwyeJR9V352PLnlLWm9L6pHPUMS+9mQ";

async function readAuthBody<T>(
    request: Request,
    parser: ContractParser<T>
): Promise<Response | T> {
    return readApiJsonOrError(request, parser, {
        code: "invalid_auth_request",
        context: "auth.body",
        maxBytes: 128 * 1024,
        message: "Invalid request body",
    });
}

function pendingLoginForMethod(
    request: Request,
    method: DashboardMfaMethod
): { pending: PendingLogin; token: string } | undefined {
    const token = pendingLoginFromCookie(request);
    const pending = token ? getPendingLogin(token) : undefined;
    return token && pending?.methods.includes(method) ? { pending, token } : undefined;
}

function failedSecondFactor(
    request: Request,
    server: Server<unknown>,
    pending?: PendingLogin
): Response {
    if (pending) {
        recordPendingLoginFailure(pending.pendingLoginId);
    }
    const response = routeFailureResponse({
        context: "auth",
        message: "Invalid or expired authentication attempt",
        status: 401,
    });
    return pending
        ? response
        : withCookies(response, [clearPendingLoginCookie(request, server)]);
}

function completePendingLogin(
    request: Request,
    server: Server<unknown>,
    pendingToken: string,
    method: DashboardMfaMethod
): Response {
    const pending = consumePendingLogin(pendingToken);
    if (!pending) {
        return failedSecondFactor(request, server);
    }
    const timestamp = new Date().toISOString();
    const sessionId = createSession(pending.userId, {
        authMethod: method,
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: pending.userAgent,
    });
    return withCookies(
        json({
            authenticated: true,
            mfaRequired: false,
            user: { id: pending.userId, username: pending.username },
        } satisfies AuthLoginResponse),
        [
            sessionCookie(request, server, sessionId),
            clearPendingLoginCookie(request, server),
        ]
    );
}

function rollbackFirstUserBootstrap(
    userId: number,
    gatewayToken: string,
    previousGatewayToken?: string
): void {
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        if (previousGatewayToken) {
            persistGatewayToken(previousGatewayToken);
        } else {
            didDeletePersistedGatewayTokenIfMatches(gatewayToken);
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            logger.error("auth.first_user_transaction_rollback_failed", {
                error: rollbackError,
            });
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "First-user rollback transaction and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

function rollbackGatewayTokenSwitch(
    gatewayToken: string,
    previousGatewayToken?: string
): void {
    if (previousGatewayToken) {
        persistGatewayToken(previousGatewayToken);
        return;
    }
    didDeletePersistedGatewayTokenIfMatches(gatewayToken);
}

function responseForClosedBootstrap(): Response {
    return routeFailureResponse({
        context: "auth",
        message: "Bootstrap registration is no longer available",
        status: 409,
    });
}

function isGatewayAuthFailure(error: unknown): boolean {
    const message = errorMessage(error, "Gateway authentication failed").toLowerCase();
    return message.includes("unauthorized") || message.includes("token mismatch");
}

function environmentGatewayToken(): string | undefined {
    return process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
}

const firstUserBootstrapState = {
    isInProgress: false,
};

export function createAuthRoutes(
    webAuthn: AuthWebAuthnDependencies = defaultWebAuthnDependencies
) {
    return {
        "/api/auth/bootstrap": {
            GET: () =>
                json({
                    isBootstrapRequired: isBootstrapRequired(),
                    hasGatewayToken: Boolean(getPersistedGatewayToken()),
                } satisfies AuthBootstrapResponse),
        },

        "/api/auth/session": {
            GET: (request: Request, server: Server<unknown>) => {
                void server;
                const needsBootstrap = isBootstrapRequired();
                const session = needsBootstrap ? undefined : authSession(request);
                const user = session
                    ? { id: session.id, username: session.username }
                    : undefined;
                return json({
                    authenticated: Boolean(session),
                    isBootstrapRequired: needsBootstrap,
                    ...(session && {
                        session: {
                            authMethod: session.authMethod,
                            expiresAt: session.expiresAt,
                            lastSeenAt: session.lastSeenAt,
                            mfaEnabled: session.mfaEnabled,
                            ...(session.mfaVerifiedAt && {
                                mfaVerifiedAt: session.mfaVerifiedAt,
                            }),
                            // This is only the non-secret selector; the validator stays in the cookie.
                            sessionId: session.sessionId,
                        },
                    }),
                    ...(user && { user }),
                } satisfies AuthSessionResponse);
            },
        },

        "/api/auth/register-first-user": {
            POST: async (request: Request, server: Server<unknown>) => {
                const body = await readAuthBody(
                    request,
                    parseFirstUserRegistrationRequest
                );
                if (body instanceof Response) return body;
                const username = normalizeLoginUsername(body.username);
                if (!username) {
                    return routeFailureResponse({
                        context: "auth",
                        message:
                            "Username must be 3-32 chars: letters, numbers, dot, dash, underscore",
                        status: 400,
                    });
                }
                const password = normalizeLoginPassword(body.password);
                if (!password) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Password must be 8-256 characters",
                        status: 400,
                    });
                }
                const rawGatewayToken = body.gatewayToken;
                if (typeof rawGatewayToken !== "string" || !rawGatewayToken.trim()) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Gateway token is required for first-user setup",
                        status: 400,
                    });
                }
                if (!isBootstrapRequired()) {
                    return responseForClosedBootstrap();
                }
                if (firstUserBootstrapState.isInProgress) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "First-user setup is already in progress",
                        status: 409,
                    });
                }
                const gatewayToken = rawGatewayToken.trim();
                firstUserBootstrapState.isInProgress = true;
                let user: Awaited<ReturnType<typeof createUser>> | undefined;
                let previousGatewayToken: string | undefined;
                let previousActiveGatewayToken: string | undefined;
                let isAttemptedGatewaySwitch = false;
                let isGatewayTokenPersisted = false;
                try {
                    previousGatewayToken = getPersistedGatewayToken();
                    previousActiveGatewayToken =
                        environmentGatewayToken() || previousGatewayToken?.trim();
                    isAttemptedGatewaySwitch = true;
                    await gateway.initAndWait(gatewayToken);
                    persistGatewayToken(gatewayToken);
                    isGatewayTokenPersisted = true;
                    const createdUser = await createFirstUser(username, password);
                    if (!createdUser) {
                        rollbackGatewayTokenSwitch(gatewayToken, previousGatewayToken);
                        if (previousActiveGatewayToken) {
                            gateway.init(previousActiveGatewayToken);
                        } else {
                            gateway.shutdown();
                        }
                        return responseForClosedBootstrap();
                    }
                    user = createdUser;
                    const sessionId = createSession(user.id, {
                        userAgent: request.headers.get("user-agent") ?? undefined,
                    });
                    return withCookies(
                        json(
                            {
                                authenticated: true,
                                user: { id: user.id, username: user.username },
                            } satisfies AuthLoginResponse,
                            { status: 201 }
                        ),
                        [
                            sessionCookie(request, server, sessionId),
                            clearPendingLoginCookie(request, server),
                        ]
                    );
                } catch (bootstrapError) {
                    logger.error("auth.first_user_bootstrap_failed", {
                        error: bootstrapError,
                    });
                    let isRollbackFailed = false;
                    if (isGatewayTokenPersisted) {
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
                            logger.error("auth.first_user_bootstrap_rollback_failed", {
                                error: rollbackError,
                            });
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
                    let message = "Failed to complete first-user setup";
                    if (isAuthFailure) {
                        message = "Invalid OpenClaw gateway token";
                    }
                    if (isRollbackFailed) {
                        message = "Failed to roll back first-user bootstrap";
                    }
                    return routeFailureResponse({
                        context: "auth",
                        message,
                        status: !isRollbackFailed && isAuthFailure ? 401 : 500,
                    });
                } finally {
                    firstUserBootstrapState.isInProgress = false;
                }
            },
        },

        "/api/auth/login": {
            POST: async (request: Request, server: Server<unknown>) => {
                if (isBootstrapRequired()) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Create the first user before logging in",
                        status: 409,
                    });
                }
                const body = await readAuthBody(request, parseLoginCredentialsRequest);
                if (body instanceof Response) return body;
                const username = normalizeLoginUsername(body.username);
                const password = normalizeLoginPassword(body.password);
                if (!username || !password) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Username and password are required",
                        status: 400,
                    });
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "login-password",
                    username
                );
                if (throttled) return throttled;
                const user = findUserByUsername(username);
                const isPasswordValid = await verifyPassword(
                    password,
                    user?.password_hash ?? UNKNOWN_USER_PASSWORD_HASH
                );
                if (!user || !isPasswordValid) {
                    recordAuthenticationFailure("login-password", username);
                    return routeFailureResponse({
                        context: "auth",
                        message: "Invalid username or password",
                        status: 401,
                    });
                }
                clearAuthenticationFailures("login-password", username);
                const existingSession = sessionIdFromCookie(request);
                if (existingSession) {
                    deleteSession(existingSession);
                }
                if (user.mfa_enabled_at) {
                    const methods = mfaMethodsForUser(user.id);
                    if (methods.length === 0) {
                        return routeFailureResponse({
                            context: "auth",
                            message: "Multi-factor authentication is unavailable",
                            status: 503,
                        });
                    }
                    const pendingLogin = createPendingLogin(
                        user.id,
                        methods,
                        request.headers.get("user-agent") ?? undefined
                    );
                    return withCookies(
                        json(
                            {
                                authenticated: false,
                                methods,
                                mfaRequired: true,
                                user: { username: user.username },
                            } satisfies AuthLoginResponse,
                            { status: 202 }
                        ),
                        [
                            pendingLoginCookie(request, server, pendingLogin),
                            clearSessionCookie(request, server),
                        ]
                    );
                }
                const sessionId = createSession(user.id, {
                    userAgent: request.headers.get("user-agent") ?? undefined,
                });
                return withCookies(
                    json({
                        authenticated: true,
                        mfaRequired: false,
                        user: { id: user.id, username: user.username },
                    } satisfies AuthLoginResponse),
                    [
                        sessionCookie(request, server, sessionId),
                        clearPendingLoginCookie(request, server),
                    ]
                );
            },
        },

        "/api/auth/login/totp": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "totp");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizeSecondFactorCode(body.code);
                const factor = code
                    ? await verifyTotpForUser(attempt.pending.userId, code)
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "totp");
            },
        },

        "/api/auth/login/recovery": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "recovery");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizeSecondFactorCode(body.code);
                const verified =
                    code &&
                    (await verifyRecoveryCodeForUser(attempt.pending.userId, code));
                if (!verified) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "recovery");
            },
        },

        "/api/auth/login/webauthn/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "webauthn");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                try {
                    const options = await webAuthn.createAuthenticationOptions({
                        pendingLoginId: attempt.pending.pendingLoginId,
                        purpose: "login",
                        userId: attempt.pending.userId,
                    });
                    return json({ options });
                } catch (error) {
                    logger.error("auth.webauthn_login_options_failed", { error });
                    return routeFailureResponse({
                        context: "auth",
                        message: "Security-key authentication is unavailable",
                        status: 503,
                    });
                }
            },
        },

        "/api/auth/login/webauthn/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "webauthn");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginWebAuthnRequest);
                if (body instanceof Response) return body;
                const response = parseAuthenticationResponse(body.response);
                const factor = response
                    ? await webAuthn.verifyAuthentication(
                          {
                              pendingLoginId: attempt.pending.pendingLoginId,
                              purpose: "login",
                              userId: attempt.pending.userId,
                          },
                          response
                      )
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "webauthn");
            },
        },

        "/api/auth/logout": {
            POST: (request: Request, server: Server<unknown>) => {
                const sessionId = sessionIdFromCookie(request);
                if (sessionId) {
                    deleteSession(sessionId);
                }
                return withCookies(json({ isOk: true }), [
                    clearSessionCookie(request, server),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },
    } as const;
}

export const authRoutes = createAuthRoutes();
