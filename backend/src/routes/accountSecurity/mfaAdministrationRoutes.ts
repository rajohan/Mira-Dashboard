import type { Server } from "bun";

import { parseAccountPasswordRequest } from "../../../../contracts/accountSecurity/requests.ts";
import { hasRecentMfaVerification } from "../../auth/sessionPolicy.ts";
import { createSession, revokeUserSessions } from "../../auth/sessionRepository.ts";
import { findUserById, verifyPassword } from "../../auth/userRepository.ts";
import {
    clearPendingLoginCookie,
    json,
    sessionCookie,
    withCookies,
} from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { authenticationThrottleResponse } from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import { disableMultiFactor } from "../../services/multiFactorAuth/factorLifecycle.ts";
import { rotateRecoveryCodes } from "../../services/multiFactorAuth/recoveryCodeService.ts";
import {
    normalizedPassword,
    readSecurityBody,
    recentVerificationRequired,
    requestContext,
    securityEvent,
} from "./support.ts";

/**
 * Creates recovery-code rotation and MFA-disable routes.
 * @returns Account-security route handlers.
 */
export function createMfaAdministrationRoutes() {
    return {
        "/api/account/security/recovery-codes/rotate": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                const recoveryCodes = await rotateRecoveryCodes(context.session.id);
                securityEvent(
                    "account.recovery-codes-rotated",
                    String(context.session.id),
                    {
                        count: recoveryCodes.length,
                    }
                );
                return json({ recoveryCodes });
            },
        },

        "/api/account/security/mfa/disable": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (
                    !context.session.mfaEnabled ||
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
                disableMultiFactor(context.session.id);
                revokeUserSessions(context.session.id);
                const sessionId = createSession(context.session.id, {
                    authMethod: "password",
                    userAgent:
                        request.headers.get("user-agent") ?? context.session.userAgent,
                });
                securityEvent("account.mfa-disabled", String(context.session.id));
                return withCookies(json({ isOk: true }), [
                    sessionCookie(request, server, sessionId),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },
    } as const;
}
