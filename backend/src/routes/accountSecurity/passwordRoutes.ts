import type { Server } from "bun";

import {
    parseAccountPasswordRequest,
    parsePasswordChangeRequest,
} from "../../../../contracts/accountSecurity/requests.ts";
import type { PasswordReauthenticationResponse } from "../../../../contracts/accountSecurity/responses.ts";
import {
    changePasswordAndRotateSession,
    rotateSession,
} from "../../auth/sessionMutations.ts";
import { hasRecentMfaVerification } from "../../auth/sessionPolicy.ts";
import { findUserById, verifyPassword } from "../../auth/userRepository.ts";
import { json, sessionCookie, withCookies } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { authenticationThrottleResponse } from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import {
    normalizedPassword,
    readSecurityBody,
    recentVerificationRequired,
    requestContext,
    securityEvent,
    securitySummary,
} from "./support.ts";

/**
 * Creates account summary, password reauthentication, and password-change routes.
 * @returns Account-security route handlers.
 */
export function createAccountPasswordRoutes() {
    return {
        "/api/account/security": {
            GET: (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                return context instanceof Response
                    ? context
                    : json(securitySummary(context));
            },
        },

        "/api/account/security/reauth/password": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseAccountPasswordRequest);
                if (body instanceof Response) return body;
                const password = normalizedPassword(body.password);
                const user = findUserById(context.session.id);
                if (
                    !password ||
                    !user ||
                    !(await verifyPassword(password, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid current password",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                const timestamp = new Date().toISOString();
                const rotated = rotateSession(context.sessionToken, {
                    elevatedAt: timestamp,
                    elevatedMethod: "password",
                    userAgent:
                        request.headers.get("user-agent") ?? context.session.userAgent,
                });
                if (!rotated) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session rotation failed",
                        status: 409,
                    });
                }
                securityEvent("account.password-reauth", String(context.session.id));
                return withCookies(
                    json({
                        isOk: true,
                        verifiedAt: timestamp,
                    } satisfies PasswordReauthenticationResponse),
                    [sessionCookie(request, server, rotated)]
                );
            },
        },

        "/api/account/security/password/change": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (
                    context.session.mfaEnabled &&
                    !hasRecentMfaVerification(context.session)
                ) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parsePasswordChangeRequest);
                if (body instanceof Response) return body;
                const currentPassword = normalizedPassword(body.currentPassword);
                const newPassword =
                    typeof body.newPassword === "string" &&
                    body.newPassword.length >= 8 &&
                    body.newPassword.length <= 256
                        ? body.newPassword
                        : undefined;
                if (!newPassword) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "New password must be 8-256 characters",
                        status: 400,
                    });
                }
                const user = findUserById(context.session.id);
                if (
                    !currentPassword ||
                    !user ||
                    !(await verifyPassword(currentPassword, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid current password",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                if (await verifyPassword(newPassword, user.password_hash)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "New password must differ from the current password",
                        status: 400,
                    });
                }
                const changed = await changePasswordAndRotateSession(
                    context.sessionToken,
                    context.session.id,
                    newPassword,
                    {
                        userAgent:
                            request.headers.get("user-agent") ??
                            context.session.userAgent,
                    }
                );
                if (!changed) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session changed; sign in and try again",
                        status: 409,
                    });
                }
                clearAuthenticationFailures("login-password", context.session.username);
                securityEvent("account.password-changed", String(context.session.id), {
                    revokedSessions: changed.revokedSessions,
                });
                return withCookies(
                    json({
                        isOk: true,
                        revokedSessions: changed.revokedSessions,
                    }),
                    [sessionCookie(request, server, changed.sessionToken)]
                );
            },
        },
    } as const;
}
