import type { Server } from "bun";

import type {
    AuthBootstrapResponse,
    AuthLoginResponse,
} from "../../../../contracts/auth.ts";
import { parseFirstUserRegistrationRequest } from "../../../../contracts/auth.ts";
import { createSession } from "../../auth/sessionRepository.ts";
import {
    createFirstUser,
    createUser,
    didDeletePersistedGatewayTokenIfMatches,
    getPersistedGatewayToken,
    isBootstrapRequired,
    persistGatewayToken,
} from "../../auth/userRepository.ts";
import { database } from "../../database/connection.ts";
import {
    clearPendingLoginCookie,
    json,
    sessionCookie,
    withCookies,
} from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { errorMessage } from "../../lib/errors.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    normalizeLoginPassword,
    normalizeLoginUsername,
} from "../../services/authenticationRequest.ts";
import gateway from "../../services/gateway/runtime.ts";
import { readAuthBody } from "./request.ts";

const logger = createStructuredLogger("auth");

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

/**
 * Creates first-user bootstrap status and registration routes.
 * @returns Authentication route handlers.
 */
export function createAuthBootstrapRoutes() {
    return {
        "/api/auth/bootstrap": {
            GET: () =>
                json({
                    isBootstrapRequired: isBootstrapRequired(),
                    hasGatewayToken: Boolean(getPersistedGatewayToken()),
                } satisfies AuthBootstrapResponse),
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
    } as const;
}
